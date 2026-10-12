package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/store"
)

// collector guarda todo lo que envía el agente. send es a.send (avisos y observados) y se
// puede atascar con stall, como una sesión WS medio caída; reply es el send de la sesión
// con el que Handle responde (nunca se atasca).
type collector struct {
	mu      sync.Mutex
	envs    []*mcsmv1.Envelope
	stuck   chan struct{}
	entered chan struct{} // recibe una señal cada vez que send se queda atascado
	changed chan struct{}
}

func newCollector() *collector {
	return &collector{changed: make(chan struct{}, 1), entered: make(chan struct{}, 1024)}
}

func (c *collector) record(e *mcsmv1.Envelope) {
	c.mu.Lock()
	c.envs = append(c.envs, e)
	c.mu.Unlock()
	select {
	case c.changed <- struct{}{}:
	default:
	}
}

func (c *collector) send(e *mcsmv1.Envelope) error {
	c.mu.Lock()
	stuck := c.stuck
	c.mu.Unlock()
	if stuck != nil {
		c.entered <- struct{}{}
		<-stuck
	}
	c.record(e)
	return nil
}

func (c *collector) reply(e *mcsmv1.Envelope) error {
	c.record(e)
	return nil
}

// stall atasca send hasta que se llame a la función devuelta (se puede llamar más de una vez).
func (c *collector) stall() (unstall func()) {
	ch := make(chan struct{})
	c.mu.Lock()
	c.stuck = ch
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			c.stuck = nil
			c.mu.Unlock()
			close(ch)
		})
	}
}

func (c *collector) all() []*mcsmv1.Envelope {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*mcsmv1.Envelope(nil), c.envs...)
}

// waitFor espera, sin dormir, a que cond se cumpla con lo recibido.
func (c *collector) waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for !cond() {
		select {
		case <-c.changed:
		case <-deadline:
			t.Fatalf("no llegó: %s", what)
		}
	}
}

// resp devuelve la respuesta (Ack o Error) a la petición id.
func (c *collector) resp(id uint64) *mcsmv1.Envelope {
	for _, e := range c.all() {
		if e.Id == id && (e.GetAck() != nil || e.GetError() != nil) {
			return e
		}
	}
	return nil
}

// final devuelve el último JobProgress terminado (OK o FAILED) de un job.
func (c *collector) final(jobID string) *mcsmv1.JobProgress {
	var out *mcsmv1.JobProgress
	for _, e := range c.all() {
		if p := e.GetJobProgress(); p != nil && p.JobId == jobID && p.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING {
			out = p
		}
	}
	return out
}

func (c *collector) created() []*mcsmv1.BackupInfo {
	var out []*mcsmv1.BackupInfo
	for _, e := range c.all() {
		if m := e.GetBackupCreated(); m != nil {
			out = append(out, m.Backup)
		}
	}
	return out
}

func (c *collector) deleted() []*mcsmv1.BackupDeleted {
	var out []*mcsmv1.BackupDeleted
	for _, e := range c.all() {
		if m := e.GetBackupDeleted(); m != nil {
			out = append(out, m)
		}
	}
	return out
}

func (c *collector) inventory() *mcsmv1.BackupInventory {
	var inv *mcsmv1.BackupInventory
	for _, e := range c.all() {
		if m := e.GetBackupInventory(); m != nil {
			inv = m
		}
	}
	return inv
}

// manualClock: Until solo se dispara si la hora ya pasó; los tests mueven el reloj a mano.
type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) Until(t time.Time) <-chan time.Time {
	ch := make(chan time.Time, 1)
	if !t.After(c.Now()) {
		ch <- t
	}
	return ch
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// rconRec es un RCON falso. Con block, save-all flush espera a que se cierre (y avisa por
// reached); onCmd, si está, se llama con cada comando antes de responder.
type rconRec struct {
	mu      sync.Mutex
	cmds    []string
	block   chan struct{}
	reached chan struct{}
	onCmd   func(cmd string)
}

func (r *rconRec) fn(ctx context.Context, host string, port uint16, password, cmd string) (string, error) {
	r.mu.Lock()
	r.cmds = append(r.cmds, cmd)
	block, reached, onCmd := r.block, r.reached, r.onCmd
	r.mu.Unlock()
	if onCmd != nil {
		onCmd(cmd)
	}
	if cmd == "save-all flush" && block != nil {
		close(reached)
		select {
		case <-block:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return "ok", nil
}

func (r *rconRec) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.cmds...)
}

// blockFlush hace que el siguiente save-all flush espere: devuelve el aviso de llegada y la
// función que lo deja seguir.
func (r *rconRec) blockFlush() (reached <-chan struct{}, unblock func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.block, r.reached = make(chan struct{}), make(chan struct{})
	return r.reached, func() { close(r.block) }
}

const backupsSpecJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","backups":{"enabled":true,"cron":"* * * * *","keepDays":0,"keepCount":2,"excludes":["logs"],"onlyIfPlayersSince":false}}`

type backupEnv struct {
	a      *App
	fake   *docker.Fake
	st     *store.Store
	col    *collector
	rc     *rconRec
	clk    *manualClock
	cancel context.CancelFunc // cancela el contexto de vida del agente (a.life)
}

// newBackupEnv: agente con el servidor "a" (slug alpha) en marcha y un mundo en disco. El
// servicio de copias tiene reloj manual y solo su cola de avisos en marcha (sin programador
// ni refresco: los tests los mueven a mano).
func newBackupEnv(t *testing.T, specJS string) *backupEnv {
	fake := docker.NewFake()
	return newBackupEnvEngine(t, fake, fake, specJS)
}

func newBackupEnvEngine(t *testing.T, eng docker.Engine, fake *docker.Fake, specJS string) *backupEnv {
	t.Helper()
	a, st := newAppEngine(t, eng)
	ctx, cancel := context.WithCancel(context.Background())
	e := &backupEnv{a: a, fake: fake, st: st, col: newCollector(), rc: &rconRec{},
		clk: &manualClock{now: time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)}, cancel: cancel}
	a.life = ctx
	a.send = e.col.send
	a.rcon = e.rc.fn
	a.bk = newBackupService(a, e.clk)
	a.bk.sleep = func(context.Context, time.Duration) error { return nil }
	a.bk.loop(func() { a.bk.out.run(ctx) })
	t.Cleanup(func() {
		cancel()
		a.bk.wg.Wait()
		a.bk.loops.Wait()
	})
	sp := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJS)}
	if r := e.handle(1, &mcsmv1.ApplySpec{Server: sp}); r == nil || r.GetAck() == nil {
		t.Fatalf("ApplySpec: %+v", r)
	}
	e.writeLevel(t, "LEVEL-1")
	return e
}

// settle espera a que terminen los jobs en segundo plano y a que la cola de avisos haya
// entregado todo lo que emitieron.
func (e *backupEnv) settle(t *testing.T) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.a.bk.wg.Wait()
		mark := make(chan struct{})
		e.a.bk.out.ch <- outItem{mark: mark}
		<-mark
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("los jobs no terminaron")
	}
}

func (e *backupEnv) dataDir() string    { return filepath.Join(e.a.cfg.DataRoot, "alpha", "data") }
func (e *backupEnv) backupsDir() string { return filepath.Join(e.a.cfg.DataRoot, "alpha", "backups") }

func (e *backupEnv) writeLevel(t *testing.T, level string) {
	t.Helper()
	p := filepath.Join(e.dataDir(), "world", "level.dat")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(level), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readLevel(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "world", "level.dat"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (e *backupEnv) handle(id uint64, body any) *mcsmv1.Envelope {
	env := &mcsmv1.Envelope{Id: id}
	switch b := body.(type) {
	case *mcsmv1.BackupNow:
		env.Body = &mcsmv1.Envelope_BackupNow{BackupNow: b}
	case *mcsmv1.BackupRestore:
		env.Body = &mcsmv1.Envelope_BackupRestore{BackupRestore: b}
	case *mcsmv1.BackupDelete:
		env.Body = &mcsmv1.Envelope_BackupDelete{BackupDelete: b}
	case *mcsmv1.BackupList:
		env.Body = &mcsmv1.Envelope_BackupList{BackupList: b}
	case *mcsmv1.ApplySpec:
		env.Body = &mcsmv1.Envelope_ApplySpec{ApplySpec: b}
	case *mcsmv1.PowerAction:
		env.Body = &mcsmv1.Envelope_PowerAction{PowerAction: b}
	}
	e.a.Handle(context.Background(), env, e.col.reply)
	return e.col.resp(id)
}

func (e *backupEnv) running(t *testing.T) bool {
	t.Helper()
	cid := e.a.rec.ContainerID(context.Background(), "a")
	ins, err := e.fake.Inspect(context.Background(), cid)
	return err == nil && ins.Running
}

func (e *backupEnv) stopContainer(t *testing.T) {
	t.Helper()
	if err := e.fake.Stop(context.Background(), e.a.rec.ContainerID(context.Background(), "a"), time.Second); err != nil {
		t.Fatal(err)
	}
}

func fakeCalls(f *docker.Fake, prefix string) int {
	n := 0
	for _, c := range f.Calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func waitClosed(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("la copia no llegó al punto esperado")
	}
}

const (
	jobOK     = mcsmv1.JobStatus_JOB_STATUS_OK
	jobFailed = mcsmv1.JobStatus_JOB_STATUS_FAILED
)

func TestBackupNowOnRunningServer(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	if r := e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	if got := strings.Join(e.rc.list(), ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("RCON = %s", got)
	}
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK || fin.Progress != 100 || fin.Type != jobs.TypeBackup {
		t.Fatalf("final = %+v", fin)
	}
	cr := e.col.created()
	if len(cr) != 1 || cr[0].Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_MANUAL || cr[0].ServerId != "a" || cr[0].Sha256 == "" {
		t.Fatalf("BackupCreated = %+v", cr)
	}
	if _, err := os.Stat(filepath.Join(e.backupsDir(), cr[0].Filename)); err != nil {
		t.Fatal(err)
	}
	if e.a.rec.Held("a") {
		t.Fatal("la reserva debe liberarse al terminar")
	}
	if !e.running(t) {
		t.Fatal("una copia en caliente no para el servidor")
	}
}

func TestBackupNowOnStoppedServerCopiesDirectly(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.stopContainer(t)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if cmds := e.rc.list(); len(cmds) != 0 {
		t.Fatalf("parado: sin RCON, hubo %v", cmds)
	}
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK || len(e.col.created()) != 1 {
		t.Fatalf("final = %+v", fin)
	}
}

func TestBackupNowPreMigrationTrigger(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION})
	e.settle(t)
	if cr := e.col.created(); len(cr) != 1 || cr[0].Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION {
		t.Fatalf("BackupCreated = %+v", cr)
	}
}

func TestBackupNowDuplicateJobRunsOnce(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if r := e.handle(11, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"}); r.GetAck() == nil {
		t.Fatalf("el duplicado también recibe Ack: %+v", r)
	}
	e.settle(t)
	if n := strings.Count(strings.Join(e.rc.list(), ","), "save-off"); n != 1 || len(e.col.created()) != 1 {
		t.Fatalf("el duplicado no debe repetir la copia: save-off=%d creadas=%d", n, len(e.col.created()))
	}
	oks := 0
	for _, env := range e.col.all() {
		if p := env.GetJobProgress(); p != nil && p.JobId == "job-1" && p.Status == jobOK {
			oks++
		}
	}
	if oks != 2 {
		t.Fatalf("el duplicado debe reenviar el resultado guardado (OK x2), hubo %d", oks)
	}
}

func TestApplySpecDuringBackupWaitsUntilItEnds(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	reached, unblock := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached) // copia en curso, con save-off enviado
	spec2 := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	r := e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(spec2)}})
	if r.GetAck() == nil {
		t.Fatalf("ApplySpec durante la copia = %+v", r)
	}
	if fakeCalls(e.fake, "Remove") != 0 || fakeCalls(e.fake, "Create") != 1 {
		t.Fatalf("el ApplySpec no debe recrear el contenedor durante la copia: %v", e.fake.Calls)
	}
	if v, _ := e.st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d durante la copia", v)
	}
	unblock()
	e.settle(t)
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
	if fakeCalls(e.fake, "Remove") != 1 || fakeCalls(e.fake, "Create") != 2 {
		t.Fatalf("al terminar la copia se aplica la spec: %v", e.fake.Calls)
	}
	if v, _ := e.st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d tras la copia", v)
	}
}

func TestBackupNowWhileBusy(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	reached, unblock := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached)
	r := e.handle(11, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-2"})
	if r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("resp = %+v", r)
	}
	if r := e.handle(12, &mcsmv1.BackupRestore{ServerId: "a", JobId: "job-3", Filename: "alpha-20261012T040000.000Z-1.tar.zst"}); r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("restaurar durante la copia = %+v", r)
	}
	if r := e.handle(13, &mcsmv1.BackupDelete{ServerId: "a", Filename: "alpha-20261012T040000.000Z-1.tar.zst"}); r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("borrar durante la copia = %+v", r)
	}
	unblock()
	e.settle(t)
	if fin := e.col.final("job-2"); fin == nil || fin.Status != jobFailed {
		t.Fatalf("job-2 = %+v", fin)
	}
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("job-1 = %+v", fin)
	}
}

func TestBackupNowValidation(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	if r := e.handle(10, &mcsmv1.BackupNow{ServerId: "otro", JobId: "j"}); r.GetError().GetCode() != errcode.UnknownServer {
		t.Fatalf("servidor ajeno = %+v", r)
	}
	if r := e.handle(11, &mcsmv1.BackupNow{ServerId: "a", JobId: "j", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_RESTORE}); r.GetError().GetCode() != errcode.InvalidRequest {
		t.Fatalf("trigger no admitido = %+v", r)
	}
	if r := e.handle(12, &mcsmv1.BackupNow{ServerId: "a"}); r.GetError().GetCode() != errcode.InvalidRequest {
		t.Fatalf("sin job_id = %+v", r)
	}
	e.settle(t)
	if e.col.final("j") != nil || e.a.rec.Held("a") {
		t.Fatal("una petición rechazada no crea job ni reserva el servidor")
	}
}

func TestRestoreKeepsPreviousDataAndRestarts(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	e.writeLevel(t, "LEVEL-2")
	e.clk.Advance(time.Hour)
	stops := fakeCalls(e.fake, "Stop")
	if r := e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobOK || fin.Type != jobs.TypeRestore {
		t.Fatalf("final = %+v", fin)
	}
	if readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("no se restauró la copia")
	}
	cr := e.col.created()
	pre := cr[len(cr)-1]
	if pre.Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_RESTORE || !strings.HasPrefix(pre.Filename, "data.pre-restore-") {
		t.Fatalf("pre-restore = %+v", pre)
	}
	if readLevel(t, filepath.Join(e.a.cfg.DataRoot, "alpha", pre.Filename)) != "LEVEL-2" {
		t.Fatal("los datos previos deben conservarse")
	}
	if fakeCalls(e.fake, "Stop") <= stops {
		t.Fatal("debe parar el servidor antes de restaurar")
	}
	if !e.running(t) || e.a.rec.Held("a") {
		t.Fatal("al terminar se libera y vuelve a arrancar (estado deseado running)")
	}
}

func TestRestoreRejectsBadName(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	r := e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: "../../etc/passwd", JobId: "job-r"})
	if r.GetError().GetCode() != errcode.InvalidRequest {
		t.Fatalf("nombre inválido = %+v", r)
	}
	e.settle(t)
	if e.col.final("job-r") != nil || e.a.rec.Held("a") {
		t.Fatal("no debe crear job ni reservar el servidor")
	}
}

// Si la restauración se queda sin data (ErrDataMissing), el servidor no se libera: liberar lo
// arrancaría sobre un data vacío y generaría un mundo nuevo. Queda reservado, parado y con
// el error en Observed hasta que el directorio de datos vuelve; entonces arranca solo.
func TestRestoreDataMissingKeepsServerDown(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	pre := filepath.Join(e.a.cfg.DataRoot, "alpha", "data.pre-restore-20261012T050000.000Z")
	e.a.bk.restore = func(_ context.Context, req backup.RestoreRequest) (backup.Meta, error) {
		// Los dos renombrados del intercambio fallan: data apartado y sin poder volver.
		if err := os.Rename(req.DataDir, pre); err != nil {
			return backup.Meta{}, err
		}
		return backup.Meta{}, fmt.Errorf("%w: activar la copia: simulado; los datos originales siguen en %s", backup.ErrDataMissing, pre)
	}
	e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"})
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, pre) {
		t.Fatalf("final = %+v", fin)
	}
	if !e.a.rec.Held("a") || e.running(t) {
		t.Fatal("el servidor debe quedar reservado y parado")
	}
	ctx := context.Background()
	if obs := e.a.rec.Observe(ctx, "a"); !strings.Contains(obs.Error, "no se arrancará") || !strings.Contains(obs.Error, pre) {
		t.Fatalf("Observed.Error = %q", obs.Error)
	}
	e.a.reconcileAll(ctx) // tick
	waitBackground(t, e.a)
	if e.running(t) {
		t.Fatal("un tick no debe arrancarlo")
	}
	if r := e.handle(30, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_START}); r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("Power = %+v", r)
	}
	// Siguiente revisión: el pre-restore sin .json vuelve a data y el servidor arranca.
	e.a.bk.checkBlocked()
	e.settle(t)
	if e.a.rec.Held("a") || !e.running(t) || readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatalf("con los datos de vuelta debe liberarse y arrancar: held=%v running=%v", e.a.rec.Held("a"), e.running(t))
	}
	if obs := e.a.rec.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("Observed.Error = %q tras recuperar", obs.Error)
	}
}

func TestBackupListSendsInventory(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if r := e.handle(30, &mcsmv1.BackupList{}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	inv := e.col.inventory()
	if inv == nil || len(inv.ServerIds) != 1 || inv.ServerIds[0] != "a" || len(inv.Backups) != 1 {
		t.Fatalf("inventario = %+v", inv)
	}
	if len(inv.Jobs) != 1 || inv.Jobs[0].JobId != "job-1" || inv.Jobs[0].Status != jobOK {
		t.Fatalf("jobs = %+v", inv.Jobs)
	}
	for _, env := range e.col.all() {
		if env.GetBackupInventory() != nil && env.Id != 0 {
			t.Fatalf("el inventario es un mensaje no solicitado (id 0): %d", env.Id)
		}
	}
	if r := e.handle(31, &mcsmv1.BackupList{ServerId: "otro"}); r.GetError().GetCode() != errcode.UnknownServer {
		t.Fatalf("servidor ajeno = %+v", r)
	}
}

// Un inventario mayor que el límite cerraría el WS del panel (maxPayload) y cada reconexión
// lo volvería a pedir: un servidor que no cabe se omite entero (fuera de server_ids, para
// que el panel no marque sus copias como borradas).
func TestBackupInventoryOmitsServersOverLimit(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	e.a.bk.inventoryLimit = 1
	e.handle(30, &mcsmv1.BackupList{})
	if inv := e.col.inventory(); inv == nil || len(inv.ServerIds) != 0 || len(inv.Backups) != 0 || len(inv.Jobs) != 1 {
		t.Fatalf("inventario = %+v", inv)
	}
}

func TestBackupDelete(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	for i, bad := range []string{"../data", "data", "alpha", "beta-20261012T040000.000Z-1.tar.zst"} {
		if r := e.handle(uint64(40+i), &mcsmv1.BackupDelete{ServerId: "a", Filename: bad}); r.GetError().GetCode() != errcode.InvalidRequest {
			t.Errorf("borrar %q = %+v", bad, r)
		}
	}
	if r := e.handle(50, &mcsmv1.BackupDelete{ServerId: "a", Filename: name}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(e.backupsDir(), name)); !os.IsNotExist(err) {
		t.Fatal("la copia debe borrarse")
	}
	if _, err := os.Stat(e.dataDir()); err != nil {
		t.Fatal("los datos no se tocan")
	}
	if r := e.handle(51, &mcsmv1.BackupDelete{ServerId: "otro", Filename: name}); r.GetError().GetCode() != errcode.UnknownServer {
		t.Fatalf("servidor ajeno = %+v", r)
	}
}

func TestScheduledBackupsArePrunedByKeepCount(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON) // * * * * *, keepCount 2, sin onlyIfPlayersSince
	e.a.bk.refreshSchedules()
	if ids := e.a.bk.sched.IDs(); len(ids) != 1 || ids[0] != "a" {
		t.Fatalf("programados = %v", ids)
	}
	for i := 0; i < 3; i++ {
		e.a.bk.onSchedule("a")
		e.settle(t)
		e.clk.Advance(time.Minute)
	}
	metas, _ := backup.List(e.backupsDir(), "alpha")
	if len(metas) != 2 {
		t.Fatalf("keepCount=2 → %d copias", len(metas))
	}
	for _, m := range metas {
		if m.Trigger != backup.TriggerScheduled {
			t.Fatalf("trigger = %s", m.Trigger)
		}
	}
	if d := e.col.deleted(); len(d) != 1 || d[0].Reason != "poda" || d[0].ServerId != "a" {
		t.Fatalf("BackupDeleted = %+v", d)
	}
	// una copia manual no cuenta para keepCount ni se poda
	e.handle(60, &mcsmv1.BackupNow{ServerId: "a", JobId: "manual-1"})
	e.settle(t)
	e.clk.Advance(time.Minute)
	e.a.bk.onSchedule("a")
	e.settle(t)
	if metas, _ = backup.List(e.backupsDir(), "alpha"); len(metas) != 3 {
		t.Fatalf("2 programadas + 1 manual, hay %d", len(metas))
	}
}

// fire vuelve enseguida aunque la copia tenga que esperar (Hold espera, sin plazo, a la
// operación en curso sobre el servidor: aquí un pull largo con el lock tomado). Si no, el
// bucle del programador se quedaría esperando y maxLate saltaría los disparos de otros
// servidores.
func TestScheduleFireReturnsImmediately(t *testing.T) {
	fake := docker.NewFake()
	eng := &slowPull{Fake: fake}
	e := newBackupEnvEngine(t, eng, fake, backupsSpecJSON)
	release := eng.block()
	defer release()
	applied := make(chan struct{})
	go func() {
		defer close(applied)
		spec2 := strings.Replace(backupsSpecJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
		e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(spec2)}})
	}()
	waitClosed(t, eng.entered) // el ApplySpec está en el pull, con el lock del servidor
	returned := make(chan struct{})
	go func() {
		e.a.bk.onSchedule("a")
		close(returned)
	}()
	waitClosed(t, returned)
	release()
	waitClosed(t, applied)
	e.settle(t)
	if metas, _ := backup.List(e.backupsDir(), "alpha"); len(metas) != 1 || metas[0].Trigger != backup.TriggerScheduled {
		t.Fatalf("la copia se hace al quedar libre el servidor: %+v", metas)
	}
}

// Entre el disparo y la ejecución la programación puede haberse desactivado (el refresco aún
// no la quitó) o el servidor puede haberse retirado: se comprueba al ejecutar.
func TestScheduledRechecksAtExecution(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	e.a.bk.refreshSchedules()
	disabled := strings.Replace(backupsSpecJSON, `"enabled":true`, `"enabled":false`, 1)
	e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(disabled)}})
	e.a.bk.onSchedule("a")
	e.a.bk.onSchedule("retirado")
	e.settle(t)
	if metas, _ := backup.List(e.backupsDir(), "alpha"); len(metas) != 0 {
		t.Fatalf("programación desactivada: no debe copiar, hay %d", len(metas))
	}
	for _, env := range e.col.all() {
		if env.GetJobProgress() != nil {
			t.Fatalf("no debe crear jobs: %+v", env)
		}
	}
	e.a.bk.refreshSchedules()
	if ids := e.a.bk.sched.IDs(); len(ids) != 0 {
		t.Fatalf("el refresco quita la programación desactivada: %v", ids)
	}
}

func TestScheduledOnlyIfPlayersSince(t *testing.T) {
	e := newBackupEnv(t, strings.Replace(backupsSpecJSON, `"onlyIfPlayersSince":false`, `"onlyIfPlayersSince":true`, 1))
	count := func() int { m, _ := backup.List(e.backupsDir(), "alpha"); return len(m) }
	e.a.bk.onSchedule("a")
	e.settle(t)
	if count() != 1 {
		t.Fatal("la primera copia siempre se hace")
	}
	e.clk.Advance(time.Minute)
	e.a.bk.onSchedule("a")
	e.settle(t)
	if count() != 1 {
		t.Fatal("sin jugadores desde la última copia se omite")
	}
	e.a.bk.players.Observe("a", 2)
	e.clk.Advance(time.Minute)
	e.a.bk.onSchedule("a")
	e.settle(t)
	if count() != 2 {
		t.Fatal("con jugadores desde la última copia se hace")
	}
}

// Los jugadores llegan con cada estado observado (onObserved).
func TestObservedPlayersFeedTheWatch(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.a.status = func(context.Context, string, uint16) *mcsmv1.McStatus {
		return &mcsmv1.McStatus{Online: true, PlayersOnline: 3}
	}
	e.clk.Advance(time.Minute)
	e.a.rec.Observe(context.Background(), "a")
	if got := e.a.bk.players.LastSeen("a"); !got.Equal(e.clk.Now()) {
		t.Fatalf("LastSeen = %v", got)
	}
}

// La sesión WS medio caída (cada envío se atasca) no frena la copia: los avisos del job van
// por una cola y save-on sale sin esperar a que se entregue ninguno.
func TestJobMessagesNeverBlockTheBackup(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	unstall := e.col.stall()
	defer unstall()
	savedOn := make(chan struct{})
	e.rc.onCmd = func(cmd string) {
		if cmd == "save-on" {
			close(savedOn)
		}
	}
	acked := make(chan struct{})
	go func() { // Begin emite con el mutex del Tracker: tampoco puede esperar al envío
		defer close(acked)
		if r := e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"}); r.GetAck() == nil {
			t.Errorf("resp = %+v", r)
		}
	}()
	waitClosed(t, acked)
	waitClosed(t, savedOn)
	waitClosed(t, e.col.entered) // el primer aviso sigue atascado en el envío
	if e.col.final("job-1") != nil || len(e.col.created()) != 0 {
		t.Fatal("con el envío atascado no puede haberse entregado nada")
	}
	unstall()
	e.settle(t)
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
}

// slowPull bloquea EnsureImage mientras haya una barrera puesta (block) y avisa por entered
// la primera vez que un pull se queda esperando.
type slowPull struct {
	*docker.Fake
	mu      sync.Mutex
	gate    chan struct{}
	entered chan struct{}
	once    sync.Once
}

// block pone la barrera; la función devuelta la quita (se puede llamar más de una vez).
func (e *slowPull) block() (release func()) {
	gate := make(chan struct{})
	e.mu.Lock()
	e.gate, e.entered = gate, make(chan struct{})
	e.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { close(gate) }) }
}

func (e *slowPull) EnsureImage(ctx context.Context, ref string) error {
	e.mu.Lock()
	g, entered := e.gate, e.entered
	e.mu.Unlock()
	if g != nil {
		e.once.Do(func() { close(entered) })
		select {
		case <-g:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return e.Fake.EnsureImage(ctx, ref)
}

// Al liberar la reserva, una reconciliación larga (la spec aplazada exige un pull lento) no
// retiene el job más de releaseWait: el job termina y la reconciliación sigue en segundo
// plano, sin plazo propio, hasta aplicar la spec.
func TestReleaseReconcilesInBackgroundAfterReleaseWait(t *testing.T) {
	fake := docker.NewFake()
	eng := &slowPull{Fake: fake}
	e := newBackupEnvEngine(t, eng, fake, specJSON)
	e.a.bk.releaseWait = 0
	reached, unblock := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached)
	spec2 := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(spec2)}})
	release := eng.block()
	defer release()
	unblock()
	e.col.waitFor(t, "fin del job", func() bool { return e.col.final("job-1") != nil })
	if fin := e.col.final("job-1"); fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
	if v, _ := e.st.Applied("a"); v != 1 {
		t.Fatalf("el pull sigue bloqueado: applied = %d", v)
	}
	release()
	e.settle(t)
	if v, _ := e.st.Applied("a"); v != 2 || !e.running(t) {
		t.Fatalf("la reconciliación en segundo plano termina: applied = %d", v)
	}
}

// Al cerrar el agente (contexto de vida cancelado) una copia en caliente aborta, su defer
// envía save-on y wait la espera; el job queda FAILED «interrumpido» en el store.
func TestShutdownWaitsForBackupAndSendsSaveOn(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	reached, _ := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached)
	e.cancel()
	if !e.a.bk.wait(10 * time.Second) {
		t.Fatal("wait no debe vencer: la copia termina al cancelarse")
	}
	if got := strings.Join(e.rc.list(), ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("RCON = %s", got)
	}
	rec, _ := e.st.GetJob("job-1")
	if rec == nil || rec.Status != jobFailed || !strings.Contains(rec.Message, "interrumpid") {
		t.Fatalf("job = %+v", rec)
	}
	if e.a.bk.spawn(func() {}) {
		t.Fatal("tras wait no se lanzan jobs nuevos")
	}
}

// Al arrancar: save-on a los servidores en marcha cuya copia quedó a medias (antes de marcar
// el job: si el agente vuelve a caer, se reintenta) y después los jobs RUNNING pasan a FAILED.
func TestRecoverResumesSavesAndFailsInterruptedJobs(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	put := func(id, typ string) {
		if err := e.st.PutJob(&mcsmv1.JobRecord{JobId: id, ServerId: "a", Type: typ, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: 1}); err != nil {
			t.Fatal(err)
		}
	}
	put("copia", jobs.TypeBackup)
	put("restauracion", jobs.TypeRestore)
	var statusAtSaveOn mcsmv1.JobStatus
	e.rc.onCmd = func(cmd string) {
		if cmd == "save-on" {
			rec, _ := e.st.GetJob("copia")
			statusAtSaveOn = rec.Status
		}
	}
	e.a.bk.recoverAtStart(context.Background())
	if got := strings.Join(e.rc.list(), ","); got != "save-on" || statusAtSaveOn != mcsmv1.JobStatus_JOB_STATUS_RUNNING {
		t.Fatalf("RCON = %q, estado del job al enviar save-on = %v", got, statusAtSaveOn)
	}
	for _, id := range []string{"copia", "restauracion"} {
		rec, _ := e.st.GetJob(id)
		if rec.Status != jobFailed || !strings.Contains(rec.Message, "interrumpido") {
			t.Fatalf("%s = %+v", id, rec)
		}
	}

	// Con el servidor parado no hace falta save-on.
	e2 := newBackupEnv(t, specJSON)
	e2.stopContainer(t)
	if err := e2.st.PutJob(&mcsmv1.JobRecord{JobId: "copia", ServerId: "a", Type: jobs.TypeBackup, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: 1}); err != nil {
		t.Fatal(err)
	}
	e2.a.bk.recoverAtStart(context.Background())
	if cmds := e2.rc.list(); len(cmds) != 0 {
		t.Fatalf("parado: sin RCON, hubo %v", cmds)
	}
}

// Al arrancar tras un crash entre los dos renombrados de una restauración: los datos
// originales vuelven a data antes de reconciliar y los restos se borran.
func TestRecoverRollsBackInterruptedRestore(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.stopContainer(t) // la restauración lo había parado
	parent := filepath.Dir(e.dataDir())
	pre := filepath.Join(parent, "data.pre-restore-20261012T040000.000Z")
	staging := filepath.Join(parent, "data.restoring-20261012T040000.000Z")
	if err := os.Rename(e.dataDir(), pre); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(staging, "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	partial := filepath.Join(e.backupsDir(), "alpha-20261012T040000.000Z-1.tar.zst.partial")
	if err := os.MkdirAll(e.backupsDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial, []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverAtStart(context.Background())
	if readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("los datos originales deben volver a data")
	}
	for _, p := range []string{pre, staging, partial} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Fatalf("%s debe desaparecer", p)
		}
	}
	if e.a.rec.Held("a") {
		t.Fatal("recuperado: no se bloquea")
	}
	e.a.reconcileAll(context.Background())
	waitBackground(t, e.a)
	if !e.running(t) {
		t.Fatal("tras recuperar, la reconciliación lo arranca")
	}
}

// Si al arrancar no se pueden devolver los datos, el servidor no arranca: queda reservado
// con el error en Observed (sin copias programadas, que solo fallarían) y se libera solo
// cuando data vuelve a existir.
func TestRecoverUnrecoverableDataBlocksServer(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	e.stopContainer(t)
	if err := os.Rename(e.dataDir(), e.dataDir()+".aparte"); err != nil {
		t.Fatal(err)
	}
	failing := func(string, string, string) (backup.Recovery, error) {
		return backup.Recovery{}, fmt.Errorf("%w: simulado", backup.ErrDataMissing)
	}
	e.a.bk.recoverDisk = failing
	e.a.bk.recoverAtStart(context.Background())
	ctx := context.Background()
	if !e.a.rec.Held("a") {
		t.Fatal("debe quedar reservado")
	}
	if obs := e.a.rec.Observe(ctx, "a"); !strings.Contains(obs.Error, "no se arrancará") || !strings.Contains(obs.Error, e.dataDir()) {
		t.Fatalf("Observed.Error = %q", obs.Error)
	}
	e.a.reconcileAll(ctx)
	waitBackground(t, e.a)
	if e.running(t) {
		t.Fatal("no debe arrancar sin datos")
	}
	e.a.bk.onSchedule("a")
	e.a.bk.checkBlocked() // sigue sin datos
	e.settle(t)
	if !e.a.rec.Held("a") {
		t.Fatal("sin datos sigue bloqueado")
	}
	for _, env := range e.col.all() {
		if env.GetJobProgress() != nil {
			t.Fatalf("bloqueado: la copia programada se omite sin crear job: %+v", env)
		}
	}
	if err := os.Rename(e.dataDir()+".aparte", e.dataDir()); err != nil { // alguien los devuelve
		t.Fatal(err)
	}
	e.a.bk.recoverDisk = backup.RecoverInterrupted
	e.a.bk.checkBlocked()
	e.settle(t)
	if e.a.rec.Held("a") || !e.running(t) {
		t.Fatal("con data de vuelta se libera y arranca")
	}
}

// Un servidor bloqueado que el panel retira se libera (el borrado de su contenedor lo
// completa la liberación de la reserva).
func TestBlockedServerRemovedByPanelIsReleased(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.a.bk.recoverDisk = func(string, string, string) (backup.Recovery, error) {
		return backup.Recovery{}, fmt.Errorf("%w: simulado", backup.ErrDataMissing)
	}
	if err := os.RemoveAll(e.dataDir()); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverAtStart(context.Background())
	if !e.a.rec.Held("a") {
		t.Fatal("debe quedar reservado")
	}
	e.a.Handle(context.Background(), syncMsg(5, nil, "a"), e.col.reply)
	waitBackground(t, e.a)
	e.a.bk.checkBlocked()
	e.settle(t)
	if e.a.rec.Held("a") {
		t.Fatal("retirado: se libera")
	}
	if list, _ := e.fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatalf("la liberación completa el borrado: %+v", list)
	}
}

// listFailEngine hace fallar ListManaged mientras fail esté activo (Docker cargado o caído).
type listFailEngine struct {
	*docker.Fake
	mu   sync.Mutex
	fail bool
}

func (e *listFailEngine) setFail(v bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.fail = v
}

func (e *listFailEngine) ListManaged(ctx context.Context) ([]docker.Container, error) {
	e.mu.Lock()
	fail := e.fail
	e.mu.Unlock()
	if fail {
		return nil, fmt.Errorf("docker no responde")
	}
	return e.Fake.ListManaged(ctx)
}

func newListFailEnv(t *testing.T) (*backupEnv, *listFailEngine) {
	fake := docker.NewFake()
	eng := &listFailEngine{Fake: fake}
	return newBackupEnvEngine(t, eng, fake, specJSON), eng
}

// Si no se puede comprobar si el servidor está en marcha, la copia falla: copiar «en frío» un
// servidor que sí está en marcha (sin save-off) daría una copia corrupta con sha256 válido.
func TestBackupFailsWhenDockerCannotBeQueried(t *testing.T) {
	e, eng := newListFailEnv(t)
	eng.setFail(true)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	fin := e.col.final("job-1")
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "no se pudo comprobar") {
		t.Fatalf("final = %+v", fin)
	}
	if cmds := e.rc.list(); len(cmds) != 0 || len(e.col.created()) != 0 {
		t.Fatalf("ni RCON ni copia: %v, %+v", cmds, e.col.created())
	}
	if metas, _ := backup.List(e.backupsDir(), "alpha"); len(metas) != 0 {
		t.Fatalf("no debe quedar copia: %+v", metas)
	}
}

// Si no se puede comprobar el contenedor, la restauración no intercambia data: con el
// servidor en marcha, seguiría escribiendo en el que pasaría a ser el pre-restore.
func TestRestoreFailsWhenDockerCannotBeQueried(t *testing.T) {
	e, eng := newListFailEnv(t)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	e.writeLevel(t, "LEVEL-2")
	e.clk.Advance(time.Hour)
	stops := fakeCalls(e.fake, "Stop")
	eng.setFail(true)
	e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"})
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "no se pudo comprobar") {
		t.Fatalf("final = %+v", fin)
	}
	if readLevel(t, e.dataDir()) != "LEVEL-2" || fakeCalls(e.fake, "Stop") != stops {
		t.Fatal("data intacto y el servidor sin tocar")
	}
	if pre, _ := backup.ListPreRestore(e.dataDir()); len(pre) != 0 {
		t.Fatalf("sin pre-restore: %+v", pre)
	}
}

// Al arrancar, si Docker no responde, save-on se envía igualmente (es idempotente): si no,
// FailInterrupted olvidaría el job y el mundo seguiría en save-off.
func TestRecoverSendsSaveOnWhenDockerCannotBeQueried(t *testing.T) {
	e, eng := newListFailEnv(t)
	if err := e.st.PutJob(&mcsmv1.JobRecord{JobId: "copia", ServerId: "a", Type: jobs.TypeBackup, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: 1}); err != nil {
		t.Fatal(err)
	}
	eng.setFail(true)
	e.a.bk.recoverAtStart(context.Background())
	if got := strings.Join(e.rc.list(), ","); got != "save-on" {
		t.Fatalf("RCON = %q", got)
	}
}

// Sin espacio para la copia, el job falla diciendo cuánto falta y sin tocar el servidor.
func TestBackupWithoutSpaceFailsBeforeSaveOff(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.a.bk.freeSpace = func(string) (uint64, error) { return 1 << 20, nil }
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	fin := e.col.final("job-1")
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "faltan") {
		t.Fatalf("final = %+v", fin)
	}
	if cmds := e.rc.list(); len(cmds) != 0 {
		t.Fatalf("sin espacio no hay save-off: %v", cmds)
	}
}
