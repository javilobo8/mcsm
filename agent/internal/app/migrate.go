package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/files"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
)

// Migración entre nodos (Plan 7, spec §7). El panel orquesta; el agente ejecuta pasos
// idempotentes. Origen: BackupPush (sube la copia pre_migration al panel) y MigrateRetire (lo
// retira al confirmar). Destino: MigrateReceive (recibe y restaura) y MigrateAbort (deshace).

// errMigrateExists: el destino ya tiene el servidor o su directorio; no se pisa nada.
var errMigrateExists = errors.New("ya existe")

// migrateErrCode traduce un fallo de los mensajes de migración al Error.code del protocolo.
func migrateErrCode(err error) string {
	switch {
	case errors.Is(err, reconcile.ErrBusy), errors.Is(err, errTransfersBusy), errors.Is(err, errClosing), errors.Is(err, errFilesClosing):
		return errcode.Busy
	case errors.Is(err, errUnknownServer):
		return errcode.UnknownServer
	case errors.Is(err, errBadRequest):
		return errcode.InvalidRequest
	case errors.Is(err, errMigrateExists):
		return errcode.Exists
	case errors.Is(err, backup.ErrNoSpace):
		return errcode.TooLarge
	case errors.Is(err, files.ErrTransfer):
		return errcode.TransferFailed
	case errors.Is(err, fs.ErrNotExist):
		return errcode.NotFound
	default:
		return errcode.BackupFailed
	}
}

// handleBackupPush sube una copia al panel (PUT /agent/transfer/{id}) y responde con sus
// metadatos cuando el panel la ha recibido entera. Cuenta como Files* en curso para el cierre
// (xfer.enter) y ocupa uno de los huecos de transferencia del nodo. ctx: el de vida del agente.
func (a *App) handleBackupPush(ctx context.Context, id uint64, m *mcsmv1.BackupPush, send func(*mcsmv1.Envelope) error) {
	if !a.xfer.enter() {
		_ = send(errMsg(id, errcode.Busy, errFilesClosing))
		return
	}
	defer a.xfer.leave()
	res, err := a.backupPush(ctx, m)
	if err != nil {
		_ = send(errMsg(id, migrateErrCode(err), err))
		return
	}
	_ = send(&mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_BackupPushResult{BackupPushResult: res}})
}

func (a *App) backupPush(ctx context.Context, m *mcsmv1.BackupPush) (*mcsmv1.BackupPushResult, error) {
	t, err := a.bk.target(m.GetServerId())
	if err != nil {
		return nil, err
	}
	if !backup.ValidName(t.slug, m.GetFilename()) {
		return nil, fmt.Errorf("%w: nombre de copia inválido %q", errBadRequest, m.GetFilename())
	}
	meta, err := backup.ReadMeta(t.backupsDir, m.GetFilename())
	if err != nil || meta.SHA256 == "" {
		return nil, fmt.Errorf("la copia %s no tiene sha256 en su .json: no se envía sin poder comprobarla", m.GetFilename())
	}
	// Abierta antes de reclamar la transferencia: una copia que ya no existe no la consume. El
	// descriptor sigue valiendo aunque la poda la borre mientras se envía.
	f, err := os.Open(filepath.Join(t.backupsDir, m.GetFilename()))
	if err != nil {
		return nil, fmt.Errorf("abrir la copia: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: la copia no es un fichero normal", errBadRequest)
	}
	xfer, err := a.transfers()
	if err != nil {
		return nil, err
	}
	release, err := a.xfer.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	size := fi.Size()
	err = a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		// LimitReader: se manda lo que medía al abrirla; si encoge, Put falla por Content-Length.
		if err := xfer.Put(ctx, m.GetTransferId(), track(io.LimitReader(f, size)), size); err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &mcsmv1.BackupPushResult{SizeBytes: uint64(size), Sha256: meta.SHA256, DataBytes: uint64(max(meta.DataBytes, 0))}, nil
}

// ── Recepción en el destino ──

const (
	// jobTypeMigrateIn es el tipo de job de la recepción (JobProgress.type, inventario).
	jobTypeMigrateIn = "migrate_in"
	// holdMigration es el motivo de la reserva durante los pasos de una migración.
	holdMigration = "migración"
	// migrationMarker se crea en <DATA_ROOT>/<slug> al recibir una migración y contiene su id:
	// MigrateAbort solo borra un directorio con el marcador de esa misma migración.
	migrationMarker = ".mcsm-migration"
	// committedMark precede al id en el marcador de una migración confirmada (MigrateConfirm):
	// «committed <migration_id>». Desde entonces ningún MigrateAbort borra ese directorio.
	committedMark = "committed "
	// retiringMarker se escribe en <DATA_ROOT>/<slug> del origen, con el id de la migración, antes
	// de olvidar la spec al retirarlo: un reintento sin spec solo toca un <slug> con esa marca.
	retiringMarker = ".mcsm-retiring"
	// maxMigrateBytes acota size_bytes y data_bytes (un valor absurdo desbordaría las cuentas).
	maxMigrateBytes = 1 << 50
)

func (b *backupService) handleMigrateReceive(id uint64, m *mcsmv1.MigrateReceive, send func(*mcsmv1.Envelope) error) {
	if err := b.startReceive(m); err != nil {
		_ = send(errMsg(id, migrateErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// startReceive valida, registra el job (un job_id ya conocido reenvía su estado, §5.4),
// comprueba que ni el servidor ni su directorio existen en este nodo y que cabe la copia más su
// extracción con el margen, reserva el servidor y lanza la recepción en segundo plano.
func (b *backupService) startReceive(m *mcsmv1.MigrateReceive) error {
	if m.GetJobId() == "" || m.GetServerId() == "" || m.GetMigrationId() == "" {
		return fmt.Errorf("%w: faltan job_id, server_id o migration_id", errBadRequest)
	}
	if !spec.ValidSlug(m.GetSlug()) || !backup.ValidName(m.GetSlug(), m.GetFilename()) {
		return fmt.Errorf("%w: slug o nombre de copia no válidos", errBadRequest)
	}
	if m.GetSizeBytes() == 0 || m.GetSizeBytes() > maxMigrateBytes || m.GetDataBytes() > maxMigrateBytes || !backup.ValidSHA256(m.GetSha256()) {
		return fmt.Errorf("%w: tamaño o sha256 de la copia no válidos", errBadRequest)
	}
	j, existing, err := b.jobs.Begin(m.GetJobId(), m.GetServerId(), jobTypeMigrateIn)
	if err != nil {
		return err
	}
	if existing != nil {
		b.jobs.Replay(existing)
		return nil
	}
	fail := func(err error) error {
		b.finish(j, err, "")
		return err
	}
	sp, err := b.a.st.GetSpec(m.GetServerId())
	if err != nil {
		return fail(err)
	}
	if sp != nil {
		return fail(fmt.Errorf("%w: el servidor ya está en este nodo", errMigrateExists))
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	if _, err := os.Lstat(dir); err == nil {
		return fail(fmt.Errorf("%w: %s ya existe en el nodo destino; muévelo o bórralo antes de migrar aquí", errMigrateExists, dir))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fail(err)
	}
	size, extract := int64(m.GetSizeBytes()), int64(m.GetDataBytes())
	if extract <= 0 {
		extract = size
	}
	if err := backup.CheckSpace(b.a.cfg.DataRoot, size+extract, "recibir la migración", b.freeSpace); err != nil {
		return fail(err)
	}
	// Reserva sin spec: un ApplySpec que llegara durante la recepción solo se guarda; se aplica
	// (y crea el contenedor) al liberar, ya con data restaurado. Ningún Files* puede escribir en este
	// servidor (serverFS responde unknown_server antes de fileWrites.enter): no hay escrituras que esperar.
	release, err := b.a.rec.Hold(m.GetServerId(), holdMigration)
	if err != nil {
		return fail(err)
	}
	if !b.spawn(func() { b.runReceive(m, dir, j, release) }) {
		release(b.a.life)
		return fail(errClosing)
	}
	return nil
}

func (b *backupService) runReceive(m *mcsmv1.MigrateReceive, dir string, j *jobs.Job, release func(context.Context)) {
	ctx := b.a.life
	err := b.withSlot(ctx, j, func() error { return b.receive(ctx, m, dir, j) })
	err = interrupted(ctx, err)
	release(b.a.life) // normalmente sin spec: no hay nada que reconciliar
	b.finish(j, err, "Copia recibida, verificada y restaurada en "+filepath.Join(dir, "data"))
}

// receive crea <DATA_ROOT>/<slug> (exclusivo) con el marcador de la migración, descarga la copia
// a su backups/ comprobando tamaño y sha256, y la restaura como data/ con backup.Restore (que la
// verifica otra vez, comprueba el espacio y acota la extracción). Si algo falla, borra el
// directorio entero: lo ha creado esta recepción.
func (b *backupService) receive(ctx context.Context, m *mcsmv1.MigrateReceive, dir string, j *jobs.Job) (err error) {
	if err := os.Mkdir(dir, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%w: %s ya existe en el nodo destino", errMigrateExists, dir)
		}
		return fmt.Errorf("crear %s: %w", dir, err)
	}
	defer func() {
		if err == nil {
			return
		}
		if rerr := os.RemoveAll(dir); rerr != nil {
			j.Log("aviso: no se pudo borrar " + dir + " (bórralo a mano): " + rerr.Error())
		}
	}()
	if err := os.WriteFile(filepath.Join(dir, migrationMarker), []byte(m.GetMigrationId()+"\n"), 0o644); err != nil {
		return fmt.Errorf("marcar el directorio de la migración: %w", err)
	}
	xfer, err := b.a.transfers()
	if err != nil {
		return err
	}
	releaseSlot, err := b.a.xfer.acquire()
	if err != nil {
		return err
	}
	backupsDir := backup.Dir(b.a.cfg.DataRoot, m.GetSlug())
	size := int64(m.GetSizeBytes())
	j.Progress(1, "Recibiendo la copia desde el panel")
	err = b.a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		body, got, err := xfer.Get(ctx, m.GetTransferId())
		if err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		defer body.Close()
		if got >= 0 && got != size {
			return fmt.Errorf("%w: el panel anuncia %d bytes y la copia mide %d", files.ErrTransfer, got, size)
		}
		_, err = backup.Receive(ctx, backup.ReceiveRequest{
			BackupsDir: backupsDir, ServerID: m.GetServerId(), Slug: m.GetSlug(), Filename: m.GetFilename(),
			Body: track(body), Size: size, SHA256: m.GetSha256(), ExtractBytes: int64(m.GetDataBytes()),
			Now: b.clock.Now, FreeSpace: b.freeSpace,
			Progress: func(done, total int64) {
				j.Progress(1+uint32(done*49/max(total, 1)), "Recibiendo la copia desde el panel")
			},
		})
		return err
	})
	releaseSlot()
	if err != nil {
		return err
	}
	j.Log("copia recibida y verificada (sha256 " + m.GetSha256() + ")")
	_, err = b.restore(ctx, backup.RestoreRequest{
		ServerID: m.GetServerId(), Slug: m.GetSlug(), Filename: m.GetFilename(),
		DataDir: filepath.Join(dir, "data"), BackupsDir: backupsDir, Now: b.clock.Now,
		Progress: func(pct uint32, msg string) { j.Progress(50+pct/2, msg) }, Log: j.Log,
	})
	return err
}

// ── Deshacer en el destino y retirar el origen ──

func (b *backupService) handleMigrateAbort(id uint64, m *mcsmv1.MigrateAbort, send func(*mcsmv1.Envelope) error) {
	b.respondAsync(id, send, func() error { return b.abortMigration(m) })
}

func (b *backupService) handleMigrateRetire(id uint64, m *mcsmv1.MigrateRetire, send func(*mcsmv1.Envelope) error) {
	b.respondAsync(id, send, func() error { return b.retireMigration(m) })
}

func (b *backupService) handleMigrateConfirm(id uint64, m *mcsmv1.MigrateConfirm, send func(*mcsmv1.Envelope) error) {
	b.respondAsync(id, send, func() error { return b.confirmMigration(m) })
}

// respondAsync ejecuta fn en segundo plano, contada en wg como las copias (el cierre la espera), y
// responde Ack o Error al terminar. Si el agente se está cerrando, busy.
func (b *backupService) respondAsync(id uint64, send func(*mcsmv1.Envelope) error, fn func() error) {
	if !b.spawn(func() {
		if err := fn(); err != nil {
			_ = send(errMsg(id, migrateErrCode(err), err))
			return
		}
		_ = send(ack(id))
	}) {
		_ = send(errMsg(id, errcode.Busy, errClosing))
	}
}

func checkMigrationMsg(serverID, slug, migrationID string) error {
	if serverID == "" || migrationID == "" || !spec.ValidSlug(slug) {
		return fmt.Errorf("%w: faltan server_id o migration_id, o el slug no es válido", errBadRequest)
	}
	return nil
}

// migMark es el marcador .mcsm-migration de un <DATA_ROOT>/<slug> recibido por migración.
type migMark struct {
	present   bool
	committed bool // «committed <id>»: confirmada (MigrateConfirm)
	id        string
}

// pendingOf: el directorio lo creó la migración id y aún no se ha confirmado.
func (m migMark) pendingOf(id string) bool { return m.present && !m.committed && m.id == id }

func (m migMark) String() string {
	switch {
	case !m.present:
		return "sin marcador de migración"
	case m.committed:
		return "migración " + m.id + " confirmada"
	default:
		return "migración " + m.id + " sin confirmar"
	}
}

func readMigMark(dir string) (migMark, error) {
	b, err := os.ReadFile(filepath.Join(dir, migrationMarker))
	if errors.Is(err, fs.ErrNotExist) {
		return migMark{}, nil
	}
	if err != nil {
		return migMark{}, err
	}
	s := strings.TrimSpace(string(b))
	if id, ok := strings.CutPrefix(s, committedMark); ok {
		return migMark{present: true, committed: true, id: id}, nil
	}
	return migMark{present: true, id: s}, nil
}

// writeMarker escribe un marcador de forma atómica (temporal + rename): un corte a mitad nunca
// deja un marcador vacío o a medias.
func writeMarker(dir, name, content string) error {
	tmp := filepath.Join(dir, name+".tmp")
	if err := os.WriteFile(tmp, []byte(content+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// abortMigration deshace en el destino lo que dejó una migración no confirmada: la spec y el
// contenedor (Forget y liberar la reserva, que lo para y lo borra por su lápida) y el directorio,
// solo si lleva el marcador SIN CONFIRMAR de esta migración, ningún otro servidor del nodo lo usa
// y ya no hay contenedor que lo monte. El marcador se lee antes de tocar la spec: si el servidor
// está en este nodo y su directorio no es una copia sin confirmar de esta migración (confirmada con
// MigrateConfirm, de otra migración o sin marcador), invalid_request sin tocar nada. Así un abort
// tardío (p. ej. de un panel restaurado desde una foto anterior al commit) nunca borra el servidor
// vivo. Repetirlo no hace nada.
func (b *backupService) abortMigration(m *mcsmv1.MigrateAbort) error {
	if err := checkMigrationMsg(m.GetServerId(), m.GetSlug(), m.GetMigrationId()); err != nil {
		return err
	}
	id := m.GetServerId()
	unlock, err := b.migLocks.lock(b.a.life, id)
	if err != nil {
		return err
	}
	defer unlock()
	sp, err := b.a.st.GetSpec(id)
	if err != nil {
		return err
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	mark, err := readMigMark(dir)
	if err != nil {
		return err
	}
	switch {
	case sp != nil && sp.Slug != m.GetSlug():
		return fmt.Errorf("%w: el servidor tiene otro slug en este nodo (%s)", errBadRequest, sp.Slug)
	case sp != nil:
		if !mark.pendingOf(m.GetMigrationId()) {
			return fmt.Errorf("%w: el servidor de este nodo no es una copia sin confirmar de la migración %s (%s); no se toca", errBadRequest, m.GetMigrationId(), mark)
		}
		if err := b.forgetHeld(id, nil); err != nil {
			return err
		}
	default:
		if reason := b.a.rec.HeldReason(id); reason != "" {
			return fmt.Errorf("%w: se reintentará al terminar", reconcile.Busy(reason))
		}
	}
	if err := b.removalDone(id); err != nil {
		return err
	}
	b.a.hub.Reset(id)
	if mark, err = readMigMark(dir); err != nil {
		return err
	}
	if !mark.pendingOf(m.GetMigrationId()) {
		if mark.present {
			b.a.log.Warn("deshacer migración: el directorio no es de esta migración sin confirmar; no se toca", "dir", dir, "marcador", mark.String())
		}
		return nil // nada de esta migración en el disco (o ya borrado)
	}
	if err := b.dirFree(id, m.GetSlug()); err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("borrar %s: %w", dir, err)
	}
	return nil
}

// confirmMigration marca como confirmada la migración que trajo el servidor a este nodo:
// reescribe el marcador como «committed <id>». Sin marcador (o ya confirmado), no hace nada.
func (b *backupService) confirmMigration(m *mcsmv1.MigrateConfirm) error {
	if err := checkMigrationMsg(m.GetServerId(), m.GetSlug(), m.GetMigrationId()); err != nil {
		return err
	}
	unlock, err := b.migLocks.lock(b.a.life, m.GetServerId())
	if err != nil {
		return err
	}
	defer unlock()
	sp, err := b.a.st.GetSpec(m.GetServerId())
	if err != nil {
		return err
	}
	if sp != nil && sp.Slug != m.GetSlug() {
		return fmt.Errorf("%w: el servidor tiene otro slug en este nodo (%s)", errBadRequest, sp.Slug)
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	mark, err := readMigMark(dir)
	switch {
	case err != nil:
		return err
	case !mark.present:
		return nil
	case mark.id != m.GetMigrationId():
		return fmt.Errorf("%w: %s lleva el marcador de otra migración (%s); no se toca", errBadRequest, dir, mark)
	case mark.committed:
		return nil
	}
	return writeMarker(dir, migrationMarker, committedMark+m.GetMigrationId())
}

// retireMigration retira el servidor del origen tras confirmar la migración. Con la spec en el
// nodo comprueba que es la versión que se migró (source_version: un servidor que volvió después a
// este nodo trae otra) y marca <slug> con .mcsm-retiring; con la reserva tomada, para el
// contenedor si alguien lo arrancó y comprueba que se ha parado, olvida la spec y libera la reserva
// (lo que borra el contenedor por su lápida). Solo entonces, sin contenedor que lo monte, aparta
// <DATA_ROOT>/<slug> (datos y copias) a <DATA_ROOT>/<slug>.migrated-<ts> o, con delete_data, lo
// borra. Un reintento sin spec (tras un corte, un borrado del contenedor pendiente o una respuesta
// perdida) solo toca un <slug> con la marca de esta retirada: uno recién creado por una recepción
// (marcador de migración sin confirmar) o ajeno da invalid_request.
func (b *backupService) retireMigration(m *mcsmv1.MigrateRetire) error {
	if err := checkMigrationMsg(m.GetServerId(), m.GetSlug(), m.GetMigrationId()); err != nil {
		return err
	}
	id := m.GetServerId()
	unlock, err := b.migLocks.lock(b.a.life, id)
	if err != nil {
		return err
	}
	defer unlock()
	sp, err := b.a.st.GetSpec(id)
	if err != nil {
		return err
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	if sp != nil {
		if sp.Slug != m.GetSlug() {
			return fmt.Errorf("%w: el servidor tiene otro slug en este nodo (%s)", errBadRequest, sp.Slug)
		}
		if sp.Version != m.GetSourceVersion() {
			return fmt.Errorf("%w: el servidor de este nodo tiene la versión %d y la migración se hizo con la %d (¿volvió aquí después?); no se toca",
				errBadRequest, sp.Version, m.GetSourceVersion())
		}
		if _, err := os.Lstat(dir); err == nil {
			if err := writeMarker(dir, retiringMarker, m.GetMigrationId()); err != nil {
				return fmt.Errorf("marcar %s para retirarlo: %w", dir, err)
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := b.forgetHeld(id, func() error { return b.stopForRetire(id) }); err != nil {
			return err
		}
	}
	if err := b.removalDone(id); err != nil {
		return err
	}
	b.a.hub.Reset(id)
	if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := b.retiringDir(dir, m.GetMigrationId()); err != nil {
		return err
	}
	if err := b.dirFree(id, m.GetSlug()); err != nil {
		return err
	}
	if m.GetDeleteData() {
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("borrar %s: %w", dir, err)
		}
		b.a.log.Info("migración confirmada: datos del origen borrados", "server", id, "dir", dir)
		return nil
	}
	to := filepath.Join(b.a.cfg.DataRoot, backup.MigratedName(dir, b.clock.Now()))
	// rename(2) sustituiría en silencio un directorio vacío con ese nombre.
	if _, err := os.Lstat(to); err == nil {
		return fmt.Errorf("%w: %s ya existe; se reintentará", reconcile.Busy(holdMigration), to)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Rename(dir, to); err != nil {
		return fmt.Errorf("apartar %s: %w", dir, err)
	}
	b.a.log.Info("migración confirmada: los datos del origen se conservan", "server", id, "en", to)
	return nil
}

// retiringDir comprueba que <slug> lleva la marca .mcsm-retiring de esta migración (la escribe la
// retirada con la spec y la versión comprobadas). Si no, no es el directorio de esta retirada.
func (b *backupService) retiringDir(dir, migrationID string) error {
	got, err := os.ReadFile(filepath.Join(dir, retiringMarker))
	if err == nil && strings.TrimSpace(string(got)) == migrationID {
		return nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if mark, merr := readMigMark(dir); merr == nil && mark.present && !mark.committed {
		return fmt.Errorf("%w: %s es una recepción en curso o el resto de otra migración (%s); no se toca", errBadRequest, dir, mark)
	}
	return fmt.Errorf("%w: %s no lleva la marca de esta retirada (%s); no se toca", errBadRequest, dir, retiringMarker)
}

// keyedLocks: un cerrojo por servidor (valor cero utilizable). lock espera su turno o al cierre
// del agente.
type keyedLocks struct {
	mu    sync.Mutex
	locks map[string]*keyedLock
	// notify (tests): recibe un aviso, sin bloquear, cada vez que alguien se pone a esperar turno.
	notify chan struct{}
}

type keyedLock struct {
	ch      chan struct{}
	refs    int // quienes lo tienen o lo esperan (se borra al llegar a 0)
	waiting int
}

func (k *keyedLocks) lock(ctx context.Context, id string) (func(), error) {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = map[string]*keyedLock{}
	}
	l := k.locks[id]
	if l == nil {
		l = &keyedLock{ch: make(chan struct{}, 1)}
		k.locks[id] = l
	}
	l.refs++
	l.waiting++
	if k.notify != nil {
		select {
		case k.notify <- struct{}{}:
		default:
		}
	}
	k.mu.Unlock()
	done := func() {
		k.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(k.locks, id)
		}
		k.mu.Unlock()
	}
	select {
	case l.ch <- struct{}{}:
		k.mu.Lock()
		l.waiting--
		k.mu.Unlock()
		return func() { <-l.ch; done() }, nil
	case <-ctx.Done():
		k.mu.Lock()
		l.waiting--
		k.mu.Unlock()
		done()
		return nil, errClosing
	}
}

// waiting: cuántos esperan turno para id (tests).
func (k *keyedLocks) waiting(id string) int {
	k.mu.Lock()
	defer k.mu.Unlock()
	if l := k.locks[id]; l != nil {
		return l.waiting
	}
	return 0
}

// dirFree comprueba, antes de borrar o apartar <DATA_ROOT>/<slug>, que ningún otro servidor del
// nodo usa ese slug (invalid_request: no se toca) y que el servidor ya no tiene contenedor que lo
// monte (busy: se reintentará). Docker sin responder también impide tocarlo.
func (b *backupService) dirFree(serverID, slug string) error {
	specs, err := b.a.st.ListSpecs()
	if err != nil {
		return err
	}
	for _, sp := range specs {
		if sp.Slug == slug && sp.ServerId != serverID {
			return fmt.Errorf("%w: %s es el directorio de otro servidor de este nodo (%s); no se toca", errBadRequest, slug, sp.ServerId)
		}
	}
	c, err := b.a.rec.Container(b.a.life, serverID)
	if err != nil {
		return errCheckContainer(err)
	}
	if c != nil {
		return fmt.Errorf("%w: el contenedor del servidor sigue existiendo; se reintentará", reconcile.Busy(holdMigration))
	}
	return nil
}

// forgetHeld reserva el servidor, espera a las escrituras de archivos en curso, ejecuta before (si
// hay) con la reserva tomada, olvida la spec (deja lápida) y libera la reserva, lo que para y borra
// su contenedor. Si algo falla antes de olvidar, libera sin más: el servidor sigue como estaba.
func (b *backupService) forgetHeld(id string, before func() error) error {
	ctx := b.a.life
	release, err := b.a.rec.Hold(id, holdMigration)
	if err != nil {
		return err
	}
	if err := b.waitFileWrites(id); err != nil {
		release(ctx)
		return err
	}
	if before != nil {
		if err := before(); err != nil {
			release(ctx)
			return err
		}
	}
	if err := b.a.rec.Forget(id); err != nil {
		release(ctx)
		return err
	}
	release(ctx) // con lápida: completa el borrado del contenedor (o lo deja al reintento de lápidas)
	return nil
}

// waitFileWrites espera, como mucho drainWait, a que terminen las escrituras de archivos que ya
// estaban en curso en el servidor al reservarlo (las nuevas ya responden busy). Ver fileWrites.
func (b *backupService) waitFileWrites(id string) error {
	select {
	case <-b.a.fileWrites.drained(id):
		return nil
	case <-b.clock.Until(b.clock.Now().Add(b.drainWait)):
		return fmt.Errorf("%w: hay operaciones de archivos en curso en el servidor; se reintentará", reconcile.Busy(holdMigration))
	case <-b.a.life.Done():
		return errClosing
	}
}

// removalDone falla con busy si el borrado del contenedor quedó pendiente (lápida): la pasada de
// lápidas lo reintenta y el panel repite la orden.
func (b *backupService) removalDone(id string) error {
	tomb, err := b.a.st.HasTombstone(id)
	if err != nil {
		return err
	}
	if tomb {
		return fmt.Errorf("%w: el contenedor del servidor aún no se ha podido borrar; se reintentará", reconcile.Busy(holdMigration))
	}
	return nil
}

// stopForRetire para el contenedor si sigue en marcha (el panel lo paró en el paso 1, pero alguien
// pudo arrancarlo a mano) y comprueba que se ha parado: nunca se retira un servidor en marcha.
func (b *backupService) stopForRetire(id string) error {
	ctx := b.a.life
	running, err := b.isRunning(ctx, id)
	if err != nil || !running {
		return err
	}
	c, err := b.a.rec.Container(ctx, id)
	if err != nil {
		return errCheckContainer(err)
	}
	if c != nil {
		if err := b.a.eng.Stop(ctx, c.ID, reconcile.StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return fmt.Errorf("parar el servidor en el origen: %w", err)
		}
	}
	if running, err := b.isRunning(ctx, id); err != nil {
		return err
	} else if running {
		return errors.New("el servidor sigue en marcha en el origen: no se retira")
	}
	return nil
}
