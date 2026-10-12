package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
)

const (
	// scheduleRefreshEvery: cada cuánto se sincroniza el programador con las specs guardadas
	// (ApplySpec y SyncSpecs las cambian) y se revisan los servidores bloqueados sin datos.
	scheduleRefreshEvery = 15 * time.Second
	// rconCommandTimeout acota cada comando de una copia en caliente (save-all flush en un
	// mundo grande tarda; mc.Rcon respeta el plazo del contexto).
	rconCommandTimeout = 2 * time.Minute
	// resumeOnStartTimeout acota el save-on que se envía al arrancar por una copia interrumpida.
	resumeOnStartTimeout = 15 * time.Second
	// defaultReleaseWait es lo que un job espera a la reconciliación que hace la liberación de
	// la reserva antes de terminar y dejarla en segundo plano.
	defaultReleaseWait = 3 * time.Minute
	// fileWritesDrainWait es lo que una restauración, ya con el servidor reservado, espera a
	// las escrituras de archivos que estaban en curso antes de apartar data. Muy por debajo
	// del plazo de 30 s con que el panel espera la respuesta a BackupRestore.
	fileWritesDrainWait = 10 * time.Second
	// shutdownWait es el tope de la espera a las copias en curso al cerrar el agente: el
	// save-on de una copia cancelada tiene su propio plazo de 15 s. Los docker-compose dan al
	// agente stop_grace_period: 30s.
	shutdownWait = 25 * time.Second
	// outboxSize: avisos al panel pendientes de entrega como mucho; los que no caben se descartan.
	outboxSize = 256
	// maxInventoryBytes deja margen bajo el maxPayload de 4 MiB del WS del panel: un mensaje
	// mayor cerraría la conexión, y cada reconexión volvería a pedir el inventario.
	maxInventoryBytes = 3 << 20
	// pruneReason es el motivo de los BackupDeleted de la poda; deleteReason, el de los
	// borrados que pide el panel.
	pruneReason  = "poda"
	deleteReason = "borrada"
	// inventoryEvery: cada cuánto el agente manda el inventario sin que se lo pidan (además de
	// tras cada Hello, cuando lo pide el panel). Repone avisos descartados por la cola (un job
	// que se quedaría «running» en el panel) y un BackupList que falló y nadie reintenta.
	inventoryEvery = 10 * time.Minute
	// maxParallelJobs: copias y restauraciones a la vez en el nodo (comprimen, leen y escriben
	// el disco entero; varias copias a la misma hora tendrían N mundos en save-off a la vez).
	// Las demás esperan en cola, con su servidor reservado y su mundo guardando con normalidad.
	maxParallelJobs = 2
)

var (
	errUnknownServer = errors.New("servidor desconocido en este nodo")
	errBadRequest    = errors.New("petición inválida")
	errBadSpec       = errors.New("la spec guardada no se puede leer")
	errClosing       = errors.New("el agente se está cerrando")
	errOutboxFull    = errors.New("cola de avisos al panel llena")
)

// backupErrCode traduce un fallo de una petición de copias al Error.code del protocolo.
func backupErrCode(err error) string {
	switch {
	case errors.Is(err, reconcile.ErrBusy):
		return errcode.Busy
	case errors.Is(err, errUnknownServer):
		return errcode.UnknownServer
	case errors.Is(err, errBadRequest):
		return errcode.InvalidRequest
	case errors.Is(err, errBadSpec):
		return errcode.BadSpec
	case errors.Is(err, errExternalData): // plan-6
		return errcode.ExternalData
	default:
		return errcode.BackupFailed
	}
}

// backupService orquesta copias y restauraciones (spec §6.5): jobs idempotentes por job_id
// (§5.4), reserva del servidor en el reconciliador (Hold) para que un ApplySpec no recree el
// contenedor a mitad, RCON, poda, inventario para el panel, programación por cron y la
// recuperación tras un cierre o un crash a mitad de un job.
//
// Todo lo que muta Docker o disco usa el contexto de vida del agente (App.life), no el de la
// sesión WS: un job no muere con la conexión. Los avisos al panel (JobProgress,
// BackupCreated, BackupDeleted) salen por out, que nunca bloquea a quien los emite.
type backupService struct {
	a       *App
	clock   backup.Clock
	sleep   func(ctx context.Context, d time.Duration) error
	jobs    *jobs.Tracker
	sched   *backup.Scheduler
	players *backup.PlayerWatch
	out     *outbox
	slots   chan struct{} // semáforo de maxParallelJobs (ver withSlot)

	// Inyectables en tests.
	restore        func(ctx context.Context, req backup.RestoreRequest) (backup.Meta, error)
	recoverDisk    func(backupsDir, dataDir, slug string) (backup.Recovery, error)
	freeSpace      func(dir string) (uint64, error) // nil: statfs
	releaseWait    time.Duration
	drainWait      time.Duration // ver fileWritesDrainWait
	inventoryLimit int

	// invMu ordena el inventario respecto a los avisos de copias: se calcula y se encola bajo
	// invMu, y BackupCreated/BackupDeleted también se encolan bajo invMu, en la misma cola
	// FIFO. Así el panel nunca recibe antes que el inventario el aviso de un cambio que el
	// listado ya no vio (una copia nueva que el inventario daría por borrada) ni, después, un
	// inventario que aún lista una copia ya borrada y anunciada (que la resucitaría).
	invMu sync.Mutex

	mu      sync.Mutex
	closed  bool                             // wait empezó: no se lanzan tareas nuevas
	blocked map[string]func(context.Context) // servidores sin datos → su reserva (ver block)

	wg sync.WaitGroup // copias, restauraciones y liberaciones en curso (los tests esperan con wg.Wait)
	// plan-7: MigrateAbort, MigrateRetire y MigrateConfirm de un mismo servidor, de uno en uno.
	migLocks keyedLocks
	loops    sync.WaitGroup // bucles de start
}

func newBackupService(a *App, clock backup.Clock) *backupService {
	b := &backupService{
		a: a, clock: clock, sleep: backup.Sleep,
		restore: backup.Restore, recoverDisk: backup.RecoverInterrupted,
		releaseWait: defaultReleaseWait, drainWait: fileWritesDrainWait, inventoryLimit: maxInventoryBytes,
		blocked: map[string]func(context.Context){},
		slots:   make(chan struct{}, maxParallelJobs),
	}
	// a.send se lee al entregar: se fija antes de lanzar goroutines (Run o el test).
	b.out = newOutbox(func(e *mcsmv1.Envelope) error { return a.send(e) }, outboxSize, a.log)
	b.jobs = jobs.New(a.st, b.out.post, clock.Now)
	b.players = backup.NewPlayerWatch(clock.Now)
	b.sched = backup.NewScheduler(clock, b.onSchedule)
	return b
}

// spawn ejecuta fn en segundo plano, contada en wg, salvo si el agente ya se está cerrando
// (wait empezó): entonces devuelve false y no la ejecuta.
func (b *backupService) spawn(fn func()) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return false
	}
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		fn()
	}()
	return true
}

// loop ejecuta un bucle de fondo contado en loops.
func (b *backupService) loop(fn func()) {
	b.loops.Add(1)
	go func() {
		defer b.loops.Done()
		fn()
	}()
}

// recoverAtStart deja el nodo coherente tras un cierre o un crash a mitad de un job. Se llama al
// arrancar, antes de la primera reconciliación y de aceptar jobs:
//
//  1. save-on a los servidores en marcha cuya copia quedó a medias (save-off no caduca: el
//     mundo seguiría sin autoguardado), ANTES de marcar el job: si el agente vuelve a caer
//     aquí, el siguiente arranque lo reintenta.
//  2. FailInterrupted: los jobs RUNNING pasan a FAILED «interrumpido» (y se olvidan los
//     terminados hace más de jobs.KeepFor: es la poda de jobs al arrancar).
//  3. Disco de cada servidor (backup.RecoverInterrupted): fuera los restos y, si data falta
//     tras un intercambio a medias, los datos originales de vuelta. Si no se pueden devolver,
//     el servidor queda bloqueado (block): sin arrancar y con el error en Observed.
func (b *backupService) recoverAtStart(ctx context.Context) {
	b.resumeInterrupted(ctx)
	if err := b.jobs.FailInterrupted(); err != nil {
		b.a.log.Warn("marcar los jobs interrumpidos", "err", err)
	}
	specs, err := b.a.st.ListSpecs()
	if err != nil {
		b.a.log.Error("listar specs para recuperar copias y restauraciones", "err", err)
		return
	}
	for _, sp := range specs {
		b.recoverServer(sp.ServerId)
	}
}

// resumeInterrupted envía save-on a los servidores en marcha con una copia RUNNING en el store.
func (b *backupService) resumeInterrupted(ctx context.Context) {
	recs, err := b.a.st.ListJobs()
	if err != nil {
		b.a.log.Warn("listar jobs al arrancar", "err", err)
		return
	}
	var wg sync.WaitGroup
	seen := map[string]bool{}
	for _, r := range recs {
		if r.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING || r.Type != jobs.TypeBackup || seen[r.ServerId] {
			continue
		}
		seen[r.ServerId] = true
		wg.Add(1)
		go func(serverID string) {
			defer wg.Done()
			b.resumeSaves(ctx, serverID)
		}(r.ServerId)
	}
	wg.Wait()
}

func (b *backupService) resumeSaves(ctx context.Context, serverID string) {
	t, err := b.target(serverID)
	if err != nil {
		return // retirado o ilegible: no hay a quién enviar save-on
	}
	running, err := b.isRunning(ctx, serverID)
	if err == nil && !running {
		return // parado: al arrancar, el servidor vuelve a guardar solo
	}
	// En marcha, o sin poder comprobarlo (Docker no responde): save-on es idempotente y contra
	// un servidor parado falla enseguida. Sin él, FailInterrupted olvidaría el job.
	cctx, cancel := context.WithTimeout(ctx, resumeOnStartTimeout)
	defer cancel()
	if _, err := b.a.rcon(cctx, spec.ContainerName(t.slug), uint16(spec.RconPort), t.spec.RconPassword, "save-on"); err != nil {
		b.a.log.Error("una copia interrumpida pudo dejar el guardado automático desactivado y save-on falló: ejecuta save-on en la consola", "server", t.slug, "err", err)
		return
	}
	b.a.log.Warn("copia interrumpida por el cierre del agente: guardado automático reactivado (save-on)", "server", t.slug)
}

func (b *backupService) recoverServer(serverID string) {
	t, err := b.target(serverID)
	if err != nil {
		b.a.log.Warn("recuperar copias y restauraciones", "server", serverID, "err", err)
		return
	}
	if t.spec.DataPath != "" { // plan-6 (m3): el agente no ve esa carpeta y nunca copia ni restaura ahí
		return
	}
	rec, err := b.recoverDisk(t.backupsDir, t.dataDir, t.slug)
	for _, p := range rec.Removed {
		b.a.log.Info("resto de una copia o restauración interrumpida borrado", "server", t.slug, "path", p)
	}
	for _, w := range rec.Warnings {
		b.a.log.Warn("restos de una copia o restauración interrumpida", "server", t.slug, "aviso", w)
	}
	if rec.RolledBack != "" {
		b.a.log.Warn("restauración interrumpida: los datos originales vuelven a data", "server", t.slug, "desde", rec.RolledBack)
	}
	if err == nil {
		return
	}
	release, herr := b.a.rec.Hold(serverID, "sin directorio de datos")
	if herr != nil {
		b.a.log.Error("no se pudo bloquear un servidor sin datos", "server", t.slug, "err", herr)
		return
	}
	b.block(serverID, release, dataMissingMsg(t.dataDir, err))
}

func dataMissingMsg(dataDir string, err error) string {
	return fmt.Sprintf("%v. El servidor no se arrancará hasta que exista %s: devuelve ahí los datos (o crea la carpeta vacía para empezar un mundo nuevo)", err, dataDir)
}

// block deja un servidor reservado (release es su reserva), parado y con msg en Observed
// hasta que su directorio de datos vuelva a existir (checkBlocked). Sin data, liberarlo lo
// arrancaría: Docker crearía un data vacío y el servidor generaría un mundo nuevo.
func (b *backupService) block(serverID string, release func(context.Context), msg string) {
	b.a.rec.HoldError(serverID, msg)
	// plan-8: mc-router arrancaría un servidor bajo demanda aunque esté reservado, y Docker le crearía
	// un data vacío: se aparca (sin contenedor) hasta que vuelvan los datos.
	if _, err := b.a.rec.Park(b.a.life, serverID); err != nil {
		b.a.log.Error("no se pudo aparcar un servidor sin datos", "server", serverID, "err", err)
	}
	b.mu.Lock()
	b.blocked[serverID] = release
	b.mu.Unlock()
	b.a.log.Error("servidor sin directorio de datos: no se arrancará", "server", serverID, "motivo", msg)
	b.a.observeAsync(b.a.life, serverID) // el error, al panel cuanto antes
}

// checkBlocked reintenta recuperar los datos de los servidores bloqueados y libera los que
// vuelven a tenerlos (devueltos a mano, o una carpeta vacía para empezar de cero) y los que
// el panel retiró (la liberación completa el borrado de su contenedor).
func (b *backupService) checkBlocked() {
	b.mu.Lock()
	ids := make([]string, 0, len(b.blocked))
	for id := range b.blocked {
		ids = append(ids, id)
	}
	b.mu.Unlock()
	sort.Strings(ids)
	for _, id := range ids {
		if b.dataBack(id) {
			b.unblock(id)
		}
	}
}

func (b *backupService) dataBack(serverID string) bool {
	t, err := b.target(serverID)
	if errors.Is(err, errUnknownServer) {
		return true
	}
	if err != nil {
		return false
	}
	if _, err := b.recoverDisk(t.backupsDir, t.dataDir, t.slug); err != nil {
		return false
	}
	fi, err := os.Lstat(t.dataDir)
	return err == nil && fi.IsDir()
}

func (b *backupService) unblock(serverID string) {
	b.mu.Lock()
	release, ok := b.blocked[serverID]
	delete(b.blocked, serverID)
	b.mu.Unlock()
	if !ok {
		return
	}
	b.a.log.Info("servidor desbloqueado: vuelve a tener directorio de datos o se retiró", "server", serverID)
	b.spawn(func() { release(b.a.life) })
}

// start arranca la cola de avisos al panel, el programador y su refresco cada 15 s (que
// también revisa los servidores bloqueados) y el inventario periódico. recoverAtStart va antes.
func (b *backupService) start(ctx context.Context) {
	b.refreshSchedules()
	b.loop(func() { b.out.run(ctx) })
	b.loop(func() { b.sched.Run(ctx) })
	b.loop(func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-b.clock.Until(b.clock.Now().Add(scheduleRefreshEvery)):
				b.refreshSchedules()
				b.checkBlocked()
			}
		}
	})
	b.loop(func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-b.clock.Until(b.clock.Now().Add(inventoryEvery)):
				b.periodicInventory()
			}
		}
	})
}

// wait espera, como mucho d, a las copias, restauraciones y liberaciones en curso y a los
// bucles de start. Se llama al cerrar el agente, con su contexto de vida ya cancelado: una
// copia en caliente aborta y su defer envía save-on (con plazo propio). Desde aquí no se
// lanzan tareas nuevas. Devuelve false si venció el tope.
func (b *backupService) wait(d time.Duration) bool {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		b.loops.Wait()
		close(done)
	}()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		b.a.log.Warn("cierre sin esperar a las copias en curso: venció el plazo", "plazo", d)
		return false
	}
}

// refreshSchedules sincroniza el programador con las specs guardadas.
func (b *backupService) refreshSchedules() {
	specs, err := b.a.st.ListSpecs()
	if err != nil {
		b.a.log.Warn("leer specs para programar copias", "err", err)
		return
	}
	want := map[string]string{}
	for _, sp := range specs {
		parsed, err := spec.Parse(sp.SpecJson)
		if err != nil || parsed.Backups == nil || !parsed.Backups.Enabled {
			continue
		}
		want[sp.ServerId] = parsed.Backups.Cron
	}
	for _, id := range b.sched.IDs() {
		if _, ok := want[id]; !ok {
			b.sched.Remove(id)
		}
	}
	for id, expr := range want {
		if err := b.sched.Set(id, expr); err != nil {
			b.a.log.Warn("cron de copias inválido", "server", id, "err", err)
		}
	}
}

// target es un servidor del nodo con lo que necesitan sus copias.
//
// La sección backups de la spec se usa tal cual: el panel guarda y envía la spec ya parseada
// por zod, con todos los valores por defecto puestos, y el agente no los repite (dos fuentes
// de verdad que podrían divergir). Una sección parcial (spec escrita a mano o panel antiguo)
// se queda con los ceros de Go, que fallan hacia guardar más: sin exclusiones, sin poda y sin
// omitir copias por falta de jugadores. Sin sección, las copias manuales usan
// spec.DefaultBackupExcludes y no hay programación.
type target struct {
	serverID   string
	slug       string
	version    uint64
	spec       spec.Spec
	dataDir    string
	backupsDir string
}

// target resuelve un servidor del store. El agente solo opera sobre servidores de su nodo
// (spec §9): uno que no está en el store es errUnknownServer.
func (b *backupService) target(serverID string) (*target, error) {
	sp, err := b.a.st.GetSpec(serverID)
	if err != nil {
		return nil, err
	}
	if sp == nil {
		return nil, errUnknownServer
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errBadSpec, err)
	}
	build, err := spec.BuildContainer(spec.Meta{ServerID: sp.ServerId, Slug: sp.Slug, Version: sp.Version}, parsed, b.a.cfg.DataRoot, b.a.cfg.Network)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errBadSpec, err)
	}
	return &target{
		serverID: sp.ServerId, slug: sp.Slug, version: sp.Version, spec: parsed,
		dataDir: build.DataDir, backupsDir: backup.Dir(b.a.cfg.DataRoot, sp.Slug),
	}, nil
}

func (b *backupService) handleBackupNow(id uint64, m *mcsmv1.BackupNow, send func(*mcsmv1.Envelope) error) {
	trigger := backup.TriggerFromProto(m.GetTrigger())
	if trigger != backup.TriggerManual && trigger != backup.TriggerPreMigration {
		_ = send(errMsg(id, errcode.InvalidRequest, fmt.Errorf("tipo de copia no admitido desde el panel: %s", trigger)))
		return
	}
	if err := b.startBackup(m.GetJobId(), m.GetServerId(), trigger); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

func (b *backupService) handleBackupRestore(id uint64, m *mcsmv1.BackupRestore, send func(*mcsmv1.Envelope) error) {
	if err := b.startRestore(m.GetJobId(), m.GetServerId(), m.GetFilename()); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

func (b *backupService) handleBackupDelete(id uint64, m *mcsmv1.BackupDelete, send func(*mcsmv1.Envelope) error) {
	if err := b.deleteBackup(m.GetServerId(), m.GetFilename()); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// handleBackupList encola el inventario como mensaje no solicitado (id 0) y responde Ack. Va
// por la cola de avisos (ver invMu), así que puede llegar antes o después del Ack, e incluso
// en la sesión siguiente: lleva el id de la petición en request_id para que el panel lo
// correlacione.
func (b *backupService) handleBackupList(id uint64, m *mcsmv1.BackupList, send func(*mcsmv1.Envelope) error) {
	if err := b.postInventory(m.GetServerId(), id); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// postInventory calcula el inventario y lo encola, todo bajo invMu. requestID es el id del
// BackupList al que contesta (0: periódico).
func (b *backupService) postInventory(serverID string, requestID uint64) error {
	b.invMu.Lock()
	defer b.invMu.Unlock()
	inv, err := b.inventory(serverID)
	if err != nil {
		return err
	}
	inv.RequestId = requestID
	return b.out.post(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupInventory{BackupInventory: inv}})
}

// periodicInventory manda el inventario de todo el nodo sin que lo pidan (cada inventoryEvery).
// Con request_id 0 el panel solo aplica lo positivo (altas de copias y estados de jobs).
func (b *backupService) periodicInventory() {
	if err := b.postInventory("", 0); err != nil {
		b.a.log.Warn("inventario periódico de copias", "err", err)
	}
}

// postChange encola un aviso de copia (BackupCreated, BackupDeleted) bajo invMu.
func (b *backupService) postChange(e *mcsmv1.Envelope) {
	b.invMu.Lock()
	defer b.invMu.Unlock()
	_ = b.out.post(e)
}

// startBackup registra el job, reserva el servidor y lanza la copia en segundo plano. Con
// un job_id ya conocido no repite nada: reenvía el estado guardado (spec §5.4).
func (b *backupService) startBackup(jobID, serverID, trigger string) error {
	if jobID == "" {
		return fmt.Errorf("%w: falta job_id", errBadRequest)
	}
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if err := externalDataSpec(t.spec); err != nil { // plan-6
		return err
	}
	j, existing, err := b.jobs.Begin(jobID, serverID, jobs.TypeBackup)
	if err != nil {
		return err
	}
	if existing != nil {
		b.jobs.Replay(existing)
		return nil
	}
	release, err := b.a.rec.Hold(serverID, holdBackup)
	if err != nil {
		b.finish(j, err, "")
		return err
	}
	if trigger == backup.TriggerPreMigration {
		// plan-7: la copia que se migra se hace en frío y sin escrituras a medias (como una
		// restauración): un arranque o una subida que llegaran después del paso 1 la dejarían
		// desfasada respecto a lo que siga escribiendo el origen.
		if err := b.preMigrationReady(serverID, j); err != nil {
			// En línea, como al fallar el lanzamiento: el servidor está parado o sin cambios (la
			// reconciliación es inmediata) y el panel lo vuelve a arrancar en cuanto recibe el error.
			release(b.a.life)
			b.finish(j, err, "")
			return err
		}
	}
	return b.launchBackup(j, serverID, trigger, release)
}

// holdBackup es el motivo de la reserva de una copia.
const holdBackup = "copia de seguridad"

// launchBackup lanza en segundo plano la copia de un job ya registrado y con el servidor
// reservado. Si el agente se está cerrando, libera y cierra el job.
func (b *backupService) launchBackup(j *jobs.Job, serverID, trigger string, release func(context.Context)) error {
	if !b.spawn(func() { b.runBackupJob(serverID, trigger, j, release) }) {
		release(b.a.life)
		b.finish(j, errClosing, "")
		return errClosing
	}
	return nil
}

func (b *backupService) runBackupJob(serverID, trigger string, j *jobs.Job, release func(context.Context)) {
	ctx := b.a.life
	var meta backup.Meta
	err := b.withSlot(ctx, j, func() (err error) {
		meta, err = b.runBackup(ctx, serverID, trigger, j)
		return err
	})
	err = interrupted(ctx, err)
	b.releaseHold(j, serverID, release)
	b.finish(j, err, "Copia creada: "+meta.Filename)
}

// withSlot ejecuta fn con uno de los maxParallelJobs huecos del nodo. Se toma antes de
// save-off (copia) o de parar el servidor (restauración); si no hay, el job lo dice y espera
// en cola sin fallar. Solo falla si el agente se cierra mientras espera.
func (b *backupService) withSlot(ctx context.Context, j *jobs.Job, fn func() error) error {
	select {
	case b.slots <- struct{}{}:
	default:
		j.Progress(0, "En cola: esperando a que terminen otras copias o restauraciones del nodo")
		select {
		case b.slots <- struct{}{}:
		case <-ctx.Done():
			return fmt.Errorf("en cola: %w", ctx.Err())
		}
	}
	defer func() { <-b.slots }()
	return fn()
}

// interrupted explica un fallo causado por el cierre del agente (contexto de vida cancelado).
func interrupted(ctx context.Context, err error) error {
	if err != nil && ctx.Err() != nil {
		return fmt.Errorf("interrumpido: el agente se está cerrando (%w)", err)
	}
	return err
}

// finish cierra el job y registra si no se pudo guardar su estado final.
func (b *backupService) finish(j *jobs.Job, err error, okMsg string) {
	if perr := j.Done(err, okMsg); perr != nil {
		b.a.log.Error("guardar el final del job", "job", j.ID(), "err", perr)
	}
}

// releaseHold libera la reserva, lo que reconcilia el servidor: aplica la spec que llegó
// durante el job y lo vuelve a su estado deseado. Va con el contexto de vida del agente y sin
// plazo propio: si la spec aplazada cambia la imagen, un plazo podría cortar el pull con el
// contenedor viejo ya borrado y dejar el servidor caído hasta el siguiente tick con backoff.
// Si tarda más de releaseWait, el job deja de esperarla y termina; la reconciliación sigue en
// segundo plano (contada en wg). Al cerrar el agente se cancela, y el servidor se reconcilia
// en el siguiente arranque.
func (b *backupService) releaseHold(j *jobs.Job, serverID string, release func(context.Context)) {
	if sp, err := b.a.st.GetSpec(serverID); err == nil && sp != nil {
		if applied, _ := b.a.st.Applied(serverID); applied != sp.Version {
			j.Log(fmt.Sprintf("aplicando la configuración que llegó durante el job (versión %d)", sp.Version))
		}
	}
	done := make(chan struct{})
	b.wg.Add(1) // quien llama es un job contado en wg: el contador no está a cero
	go func() {
		defer b.wg.Done()
		defer close(done)
		release(b.a.life)
	}()
	select {
	case <-done:
	case <-b.clock.Until(b.clock.Now().Add(b.releaseWait)):
		j.Log("la configuración pendiente se sigue aplicando en segundo plano (p. ej. descargando una imagen nueva)")
	}
}

func (b *backupService) runBackup(ctx context.Context, serverID, trigger string, j *jobs.Job) (backup.Meta, error) {
	t, err := b.target(serverID)
	if err != nil {
		return backup.Meta{}, err
	}
	req := backup.CreateRequest{
		ServerID: serverID, Slug: t.slug, SpecVersion: t.version, Trigger: trigger,
		DataDir: t.dataDir, BackupsDir: t.backupsDir, Excludes: t.spec.BackupExcludes(),
		Now: b.clock.Now, Sleep: b.sleep, Progress: j.Progress, Log: j.Log, FreeSpace: b.freeSpace,
	}
	running, err := b.isRunning(ctx, serverID)
	if err != nil {
		return backup.Meta{}, err
	}
	if running {
		j.Log("servidor en marcha: copia en caliente con save-off / save-all flush / save-on")
		host, pass := spec.ContainerName(t.slug), t.spec.RconPassword
		req.Rcon = func(ctx context.Context, cmd string) (string, error) {
			cctx, cancel := context.WithTimeout(ctx, rconCommandTimeout)
			defer cancel()
			return b.a.rcon(cctx, host, uint16(spec.RconPort), pass, cmd)
		}
	} else {
		j.Log("servidor parado: copia directa")
		// plan-8: sin contenedor, mc-router no puede despertarlo a mitad de una copia en frío.
		if parked, err := b.a.rec.Park(ctx, serverID); err != nil {
			return backup.Meta{}, err
		} else if parked {
			j.Log("servidor bajo demanda aparcado: su contenedor se recrea al terminar")
		}
	}
	meta, err := backup.Create(ctx, req)
	if meta.Filename != "" { // también con ErrResume: la copia está escrita
		b.announce(meta, serverID, j.ID())
		b.prune(t)
	}
	return meta, err
}

// isRunning dice si el contenedor del servidor está en marcha. Si Docker no deja comprobarlo
// devuelve error, nunca «parado»: una copia lo tomaría por fría (sin save-off) y una
// restauración intercambiaría data con el servidor escribiendo.
func (b *backupService) isRunning(ctx context.Context, serverID string) (bool, error) {
	c, err := b.a.rec.Container(ctx, serverID)
	if err != nil {
		return false, errCheckContainer(err)
	}
	if c == nil {
		return false, nil
	}
	ins, err := b.a.eng.Inspect(ctx, c.ID)
	if errors.Is(err, docker.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, errCheckContainer(err)
	}
	return ins.Running, nil
}

func errCheckContainer(err error) error {
	return fmt.Errorf("no se pudo comprobar si el servidor está en marcha (Docker: %w); no se hace nada", err)
}

// announce avisa al panel de una copia nueva (también de los datos pre-restore).
func (b *backupService) announce(m backup.Meta, serverID, jobID string) {
	b.postChange(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupCreated{BackupCreated: &mcsmv1.BackupCreated{Backup: m.Info(serverID), JobId: jobID}}})
}

// prune aplica keepDays/keepCount a las copias programadas tras cada copia (spec §6.5).
func (b *backupService) prune(t *target) {
	cfg := t.spec.Backups
	if cfg == nil {
		return
	}
	metas, err := backup.List(t.backupsDir, t.slug)
	if err != nil {
		b.a.log.Warn("listar copias para podar", "server", t.slug, "err", err)
		return
	}
	for _, name := range backup.PrunePlan(metas, cfg.KeepDays, cfg.KeepCount, b.clock.Now()) {
		if err := backup.Delete(t.backupsDir, t.dataDir, t.slug, name); err != nil {
			b.a.log.Warn("podar copia", "server", t.slug, "file", name, "err", err)
			continue
		}
		b.postChange(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupDeleted{BackupDeleted: &mcsmv1.BackupDeleted{
			ServerId: t.serverID, Filename: name, Reason: pruneReason,
		}}})
	}
}

// startRestore valida, registra el job, reserva el servidor y restaura en segundo plano.
func (b *backupService) startRestore(jobID, serverID, filename string) error {
	if jobID == "" {
		return fmt.Errorf("%w: falta job_id", errBadRequest)
	}
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if err := externalDataSpec(t.spec); err != nil { // plan-6
		return err
	}
	if !backup.ValidName(t.slug, filename) {
		return fmt.Errorf("%w: nombre de copia inválido %q", errBadRequest, filename)
	}
	j, existing, err := b.jobs.Begin(jobID, serverID, jobs.TypeRestore)
	if err != nil {
		return err
	}
	if existing != nil {
		b.jobs.Replay(existing)
		return nil
	}
	release, err := b.a.rec.Hold(serverID, "restauración")
	if err != nil {
		b.finish(j, err, "")
		return err
	}
	if err := b.drainFileWrites(serverID, j); err != nil {
		// La respuesta no espera a la liberación: reconcilia y aplicaría (pull incluido) una
		// spec que llegó durante la espera, más allá del plazo con que el panel espera esta
		// respuesta.
		b.releaseAsync(release)
		b.finish(j, err, "")
		return err
	}
	if !b.spawn(func() { b.runRestoreJob(t, filename, j, release) }) {
		release(b.a.life)
		b.finish(j, errClosing, "")
		return errClosing
	}
	return nil
}

// releaseAsync libera una reserva en segundo plano con el contexto de vida del agente,
// contada en wg (la espera del cierre la incluye). Si el agente ya se cierra, libera en línea:
// con el contexto cancelado la reconciliación no espera, y el siguiente arranque la completa.
func (b *backupService) releaseAsync(release func(context.Context)) {
	if !b.spawn(func() { release(b.a.life) }) {
		release(b.a.life)
	}
}

// drainFileWrites espera, como mucho drainWait, a que terminen las escrituras de archivos
// que ya estaban en curso en serverID al reservarlo (las nuevas ya responden busy). Si no
// terminan, la restauración no empieza: ErrBusy. Ver fileWrites.
func (b *backupService) drainFileWrites(serverID string, j *jobs.Job) error {
	drained := b.a.fileWrites.drained(serverID)
	select {
	case <-drained:
		return nil
	default:
	}
	j.Progress(0, "Esperando a que terminen las operaciones de archivos en curso")
	select {
	case <-drained:
		return nil
	case <-b.clock.Until(b.clock.Now().Add(b.drainWait)):
		return fmt.Errorf("%w: hay operaciones de archivos en curso en el servidor (subidas, escrituras o borrados); espera a que terminen y vuelve a intentarlo", reconcile.ErrBusy)
	case <-b.a.life.Done():
		return errClosing
	}
}

func (b *backupService) runRestoreJob(t *target, filename string, j *jobs.Job, release func(context.Context)) {
	ctx := b.a.life
	err := b.withSlot(ctx, j, func() error { return b.runRestore(ctx, t.serverID, filename, j) })
	if errors.Is(err, backup.ErrDataMissing) {
		// Sin liberar: la liberación reconciliaría y arrancaría el servidor sobre un data vacío.
		b.block(t.serverID, release, dataMissingMsg(t.dataDir, err))
		b.finish(j, err, "")
		return
	}
	err = interrupted(ctx, err)
	if err == nil {
		j.Progress(95, "Volviendo a arrancar el servidor si estaba en marcha")
	}
	b.releaseHold(j, t.serverID, release) // reconcilia: lo arranca si su estado deseado es running
	b.finish(j, err, "Restauración completada desde "+filename)
}

func (b *backupService) runRestore(ctx context.Context, serverID, filename string, j *jobs.Job) error {
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	c, err := b.a.rec.Container(ctx, serverID)
	if err != nil {
		return errCheckContainer(err)
	}
	if c != nil {
		j.Progress(1, "Parando el servidor")
		// plan-8: un servidor bajo demanda se aparca (se borra su contenedor) para que mc-router no lo
		// arranque sobre el mundo viejo si alguien intenta entrar durante la restauración.
		parked, err := b.a.rec.Park(ctx, serverID)
		if err != nil {
			return fmt.Errorf("parar el servidor: %w", err)
		}
		if parked {
			j.Log("servidor bajo demanda aparcado: su contenedor se recrea al terminar")
		} else if err := b.a.eng.Stop(ctx, c.ID, reconcile.StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return fmt.Errorf("parar el servidor: %w", err)
		}
		running, err := b.isRunning(ctx, serverID)
		if err != nil {
			return err
		}
		if running {
			return errors.New("el servidor sigue en marcha: no se restaura")
		}
		j.Log("servidor parado")
	}
	pre, err := b.restore(ctx, backup.RestoreRequest{
		ServerID: serverID, Slug: t.slug, Filename: filename, DataDir: t.dataDir, BackupsDir: t.backupsDir,
		Now: b.clock.Now, Progress: j.Progress, Log: j.Log,
	})
	if err != nil {
		return err
	}
	if pre.Filename != "" {
		b.announce(pre, serverID, "") // los datos previos se registran como copia pre_restore
	}
	return nil
}

// deleteBackup borra una copia o un directorio pre-restore. Con el servidor reservado (copia,
// restauración o sin datos) responde ocupado: un pre-restore puede ser lo único que queda.
func (b *backupService) deleteBackup(serverID, filename string) error {
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if !backup.ValidName(t.slug, filename) && !backup.ValidPreRestoreName(t.dataDir, filename) {
		return fmt.Errorf("%w: nombre de copia inválido %q", errBadRequest, filename)
	}
	if reason := b.a.rec.HeldReason(serverID); reason != "" {
		return fmt.Errorf("%w: no se pueden borrar copias mientras dure la reserva", reconcile.Busy(reason))
	}
	if err := backup.Delete(t.backupsDir, t.dataDir, t.slug, filename); err != nil {
		return err
	}
	// Por la cola, detrás de un inventario que aún la listara (el Ack puede adelantarse a él).
	b.postChange(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupDeleted{BackupDeleted: &mcsmv1.BackupDeleted{
		ServerId: serverID, Filename: filename, Reason: deleteReason,
	}}})
	return nil
}

// inventory lista copias (y datos pre-restore) y jobs recientes; serverID vacío = todo el
// nodo. Un servidor cuyo listado falla, o que no cabe en inventoryLimit, se omite entero
// (fuera de server_ids): el panel no marca nada suyo como borrado.
func (b *backupService) inventory(serverID string) (*mcsmv1.BackupInventory, error) {
	var specs []*mcsmv1.ServerSpec
	if serverID != "" {
		sp, err := b.a.st.GetSpec(serverID)
		if err != nil {
			return nil, err
		}
		if sp == nil {
			return nil, errUnknownServer
		}
		specs = []*mcsmv1.ServerSpec{sp}
	} else {
		var err error
		if specs, err = b.a.st.ListSpecs(); err != nil {
			return nil, err
		}
	}
	recs, err := b.jobs.Inventory(serverID)
	if err != nil {
		return nil, err
	}
	inv := &mcsmv1.BackupInventory{Jobs: recs}
	size := proto.Size(inv)
	for _, sp := range specs {
		infos, err := b.listing(sp.ServerId)
		if err != nil {
			b.a.log.Warn("inventario de copias", "server", sp.Slug, "err", err)
			continue
		}
		n := len(sp.ServerId) + 8 // etiqueta y longitud de cada elemento repetido: holgado
		for _, info := range infos {
			n += proto.Size(info) + 8
		}
		if size+n > b.inventoryLimit {
			b.a.log.Warn("inventario de copias demasiado grande: este servidor se omite (borra copias antiguas)", "server", sp.Slug, "copias", len(infos))
			continue
		}
		size += n
		inv.ServerIds = append(inv.ServerIds, sp.ServerId)
		inv.Backups = append(inv.Backups, infos...)
	}
	return inv, nil
}

func (b *backupService) listing(serverID string) ([]*mcsmv1.BackupInfo, error) {
	t, err := b.target(serverID)
	if err != nil {
		return nil, err
	}
	archives, err := backup.List(t.backupsDir, t.slug)
	if err != nil {
		return nil, err
	}
	var pre []backup.Meta
	if t.spec.DataPath == "" { // plan-6 (m3): con dataPath no hay restauraciones ni el agente ve la carpeta
		if pre, err = backup.ListPreRestore(t.dataDir); err != nil {
			return nil, err
		}
	}
	out := make([]*mcsmv1.BackupInfo, 0, len(archives)+len(pre))
	for _, m := range append(archives, pre...) {
		out = append(out, m.Info(serverID))
	}
	return out, nil
}

// onSchedule lo llama el programador desde su bucle: vuelve enseguida (la copia va en su
// propia goroutine) para no retrasar los disparos de otros servidores, que maxLate saltaría.
func (b *backupService) onSchedule(serverID string) {
	b.spawn(func() { b.scheduled(serverID) })
}

// scheduled ejecuta un disparo. Vuelve a comprobar que el servidor sigue en el nodo y la
// programación activa: entre el disparo y aquí pudo llegar un Remove o una spec nueva que el
// refresco del programador aún no recogió. Un servidor sin data (aún no arrancado nunca) o
// ya reservado (otra copia en curso, un cron más rápido que la copia, o bloqueado sin datos)
// se omite con un aviso en el log, sin job: un job FAILED en cada disparo solo sería ruido.
// Por eso aquí la reserva va antes que el job.
func (b *backupService) scheduled(serverID string) {
	t, err := b.target(serverID)
	if errors.Is(err, errUnknownServer) {
		return
	}
	if err != nil {
		b.a.log.Warn("copia programada", "server", serverID, "err", err)
		return
	}
	cfg := t.spec.Backups
	if cfg == nil || !cfg.Enabled {
		return
	}
	if fi, err := os.Lstat(t.dataDir); err != nil || !fi.IsDir() {
		b.a.log.Warn("copia programada omitida: el servidor aún no tiene directorio de datos", "server", t.slug)
		return
	}
	if !backup.ShouldRun(cfg.OnlyIfPlayersSince, b.lastBackup(t), b.players.LastSeen(serverID), b.players.Since()) {
		b.a.log.Info("copia programada omitida: nadie se ha conectado desde la última", "server", t.slug)
		return
	}
	release, err := b.a.rec.Hold(serverID, holdBackup)
	if err != nil {
		b.a.log.Warn("copia programada omitida", "server", t.slug, "err", err)
		return
	}
	j, _, err := b.jobs.Begin(jobs.NewID(), serverID, jobs.TypeBackup)
	if err != nil {
		release(b.a.life)
		b.a.log.Warn("copia programada", "server", t.slug, "err", err)
		return
	}
	if err := b.launchBackup(j, serverID, backup.TriggerScheduled, release); err != nil {
		b.a.log.Warn("copia programada", "server", t.slug, "err", err)
	}
}

// lastBackup es el INICIO de la copia más reciente (ShouldRun lo exige: con el fin, un
// jugador que entró durante la copia contaría como anterior a ella).
func (b *backupService) lastBackup(t *target) time.Time {
	metas, err := backup.List(t.backupsDir, t.slug)
	if err != nil || len(metas) == 0 {
		return time.Time{}
	}
	return metas[0].StartedAt
}

// outbox entrega al panel, en orden y sin bloquear a quien los emite, los avisos de copias y
// jobs. Un job emite desde la copia (con el mundo en save-off) y Tracker.Begin lo hace con su
// mutex tomado: un envío lento —con la sesión WS medio caída cada escritura espera hasta
// 10 s— no debe frenarlos. Con la cola llena el aviso se descarta: el inventario que el panel
// pide tras cada Hello repone el estado.
type outbox struct {
	deliver func(*mcsmv1.Envelope) error
	ch      chan outItem
	log     *slog.Logger
	dropped atomic.Uint64
}

// outItem es un aviso o, con mark, una marca que se cierra al llegar a ella (tests).
type outItem struct {
	env  *mcsmv1.Envelope
	mark chan struct{}
}

func newOutbox(deliver func(*mcsmv1.Envelope) error, size int, log *slog.Logger) *outbox {
	return &outbox{deliver: deliver, ch: make(chan outItem, size), log: log}
}

// post encola un aviso sin bloquear.
func (o *outbox) post(e *mcsmv1.Envelope) error {
	select {
	case o.ch <- outItem{env: e}:
		return nil
	default:
		o.dropped.Add(1)
		return errOutboxFull
	}
}

// run entrega los avisos hasta que ctx termina.
func (o *outbox) run(ctx context.Context) {
	var reported uint64
	for {
		select {
		case <-ctx.Done():
			return
		case it := <-o.ch:
			if it.mark != nil {
				close(it.mark)
				continue
			}
			_ = o.deliver(it.env) // sin conexión falla al instante: el inventario lo repone
			if d := o.dropped.Load(); d != reported {
				o.log.Warn("avisos de copias y jobs descartados: la cola hacia el panel estaba llena", "nuevos", d-reported, "total", d)
				reported = d
			}
		}
	}
}
