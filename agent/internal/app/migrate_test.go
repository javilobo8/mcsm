package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/store"
)

// newMigrateEnv: el entorno de copias (servidor "a", slug alpha, en marcha y con un mundo) con
// credenciales para las transferencias.
func newMigrateEnv(t *testing.T) *backupEnv {
	t.Helper()
	e := newBackupEnv(t, specJSON)
	if err := e.st.SaveCredentials(store.Credentials{NodeID: "n1", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	return e
}

// migrateEnvelope envuelve los mensajes de la migración.
func migrateEnvelope(id uint64, body any) *mcsmv1.Envelope {
	env := &mcsmv1.Envelope{Id: id}
	switch b := body.(type) {
	case *mcsmv1.BackupPush:
		env.Body = &mcsmv1.Envelope_BackupPush{BackupPush: b}
	case *mcsmv1.MigrateReceive:
		env.Body = &mcsmv1.Envelope_MigrateReceive{MigrateReceive: b}
	case *mcsmv1.MigrateAbort:
		env.Body = &mcsmv1.Envelope_MigrateAbort{MigrateAbort: b}
	case *mcsmv1.MigrateRetire:
		env.Body = &mcsmv1.Envelope_MigrateRetire{MigrateRetire: b}
	case *mcsmv1.MigrateConfirm:
		env.Body = &mcsmv1.Envelope_MigrateConfirm{MigrateConfirm: b}
	default:
		panic(fmt.Sprintf("cuerpo no previsto %T", body))
	}
	return env
}

// call entrega un mensaje de la migración y espera, sin dormir, la respuesta con su id (Ack,
// Error o *Result; algunas llegan desde una tarea de fondo).
func (e *backupEnv) call(t *testing.T, id uint64, body any) *mcsmv1.Envelope {
	t.Helper()
	e.a.Handle(context.Background(), migrateEnvelope(id, body), e.col.reply)
	var out *mcsmv1.Envelope
	e.col.waitFor(t, fmt.Sprintf("respuesta a %d", id), func() bool {
		for _, env := range e.col.all() {
			if env.Id == id {
				out = env
				return true
			}
		}
		return false
	})
	return out
}

// preMigration hace una copia pre_migration de "a" y devuelve su aviso.
func preMigration(t *testing.T, e *backupEnv) *mcsmv1.BackupInfo {
	t.Helper()
	stopServer(t, e, 9) // paso 1 de la migración: la copia previa exige el servidor parado
	if r := e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-pre", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION}); r.GetAck() == nil {
		t.Fatalf("BackupNow = %+v", r)
	}
	e.settle(t)
	cr := e.col.created()
	if len(cr) != 1 || cr[0].Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION || cr[0].Sha256 == "" {
		t.Fatalf("BackupCreated = %+v", cr)
	}
	return cr[0]
}

func TestBackupPushSendsArchiveAndMeta(t *testing.T) {
	e := newMigrateEnv(t)
	info := preMigration(t, e)
	var got []byte
	panelFor(t, e.a, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "método", http.StatusMethodNotAllowed)
			return
		}
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	})
	r := e.call(t, 11, &mcsmv1.BackupPush{ServerId: "a", Filename: info.Filename, TransferId: xferID})
	res := r.GetBackupPushResult()
	want, err := os.ReadFile(filepath.Join(e.backupsDir(), info.Filename))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(got)
	if res == nil || !bytes.Equal(got, want) || hex.EncodeToString(sum[:]) != info.Sha256 ||
		res.Sha256 != info.Sha256 || res.SizeBytes != uint64(len(want)) || res.DataBytes == 0 {
		t.Fatalf("resp = %+v (el panel recibió %d bytes)", r, len(got))
	}
}

func TestBackupPushErrors(t *testing.T) {
	e := newMigrateEnv(t)
	name := preMigration(t, e).Filename
	panelFor(t, e.a, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }) // caducada o ya usada
	cases := []struct {
		id   uint64
		m    *mcsmv1.BackupPush
		code string
	}{
		{20, &mcsmv1.BackupPush{ServerId: "zz", Filename: name, TransferId: xferID}, errcode.UnknownServer},
		{21, &mcsmv1.BackupPush{ServerId: "a", Filename: "../../etc/passwd", TransferId: xferID}, errcode.InvalidRequest},
		{22, &mcsmv1.BackupPush{ServerId: "a", Filename: "alpha-20200101T000000.000Z-1.tar.zst", TransferId: xferID}, errcode.BackupFailed},
		{23, &mcsmv1.BackupPush{ServerId: "a", Filename: name, TransferId: xferID}, errcode.TransferFailed},
	}
	for _, c := range cases {
		if r := e.call(t, c.id, c.m); errCode(r) != c.code {
			t.Errorf("%d: resp = %+v, quería %s", c.id, r, c.code)
		}
	}
}

const migFile = "mig-20261012T040000.000Z-3.tar.zst"

// worldArchive empaqueta un mundo (world/level.dat = level) como lo hace una copia y devuelve el
// .tar.zst, su sha256 y lo que ocupa extraído.
func worldArchive(t *testing.T, level string) ([]byte, string, int64) {
	t.Helper()
	src := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "world", "level.dat"), []byte(level), 0o644); err != nil {
		t.Fatal(err)
	}
	excl, err := backup.NewExcluder(nil)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	st, err := backup.WriteArchive(context.Background(), src, &buf, excl, nil)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:]), st.Bytes
}

// servePanel sirve arch en GET /agent/transfer/{xferID} (con Content-Length) y cuenta las descargas.
func servePanel(t *testing.T, e *backupEnv, arch []byte) *atomic.Int32 {
	t.Helper()
	gets := &atomic.Int32{}
	panelFor(t, e.a, func(w http.ResponseWriter, r *http.Request) {
		gets.Add(1)
		w.Header().Set("Content-Length", strconv.Itoa(len(arch)))
		_, _ = w.Write(arch)
	})
	return gets
}

func receiveMsg(job string, arch []byte, sum string, data int64) *mcsmv1.MigrateReceive {
	return &mcsmv1.MigrateReceive{ServerId: "m", Slug: "mig", JobId: job, MigrationId: "mig-1", TransferId: xferID,
		Filename: migFile, SizeBytes: uint64(len(arch)), Sha256: sum, DataBytes: uint64(data)}
}

func (e *backupEnv) migDir() string { return filepath.Join(e.a.cfg.DataRoot, "mig") }

func TestMigrateReceiveRestoresWorld(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	gets := servePanel(t, e, arch)
	if r := e.call(t, 30, receiveMsg("rx-1", arch, sum, data)); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	fin := e.col.final("rx-1")
	if fin == nil || fin.Status != jobOK || fin.Type != jobTypeMigrateIn || fin.ServerId != "m" {
		t.Fatalf("final = %+v", fin)
	}
	if got := readLevel(t, filepath.Join(e.migDir(), "data")); got != "LEVEL-MIG" {
		t.Fatalf("level.dat = %q", got)
	}
	if b, _ := os.ReadFile(filepath.Join(e.migDir(), migrationMarker)); string(b) != "mig-1\n" {
		t.Fatalf("marcador = %q", b)
	}
	meta, err := backup.ReadMeta(filepath.Join(e.migDir(), "backups"), migFile)
	if err != nil || meta.SHA256 != sum || meta.Trigger != backup.TriggerPreMigration || meta.SpecVersion != 3 {
		t.Fatalf("meta = %+v, %v", meta, err)
	}
	if pre, _ := backup.ListPreRestore(filepath.Join(e.migDir(), "data")); len(pre) != 0 {
		t.Fatalf("sin datos previos no hay pre-restore: %+v", pre)
	}
	if e.a.rec.Held("m") {
		t.Fatal("la reserva debe liberarse al terminar")
	}
	if sp, _ := e.st.GetSpec("m"); sp != nil {
		t.Fatal("recibir no crea la spec: la manda el panel después (ApplySpec)")
	}
	// Un job_id repetido no descarga otra vez: reenvía su estado (§5.4).
	if r := e.call(t, 31, receiveMsg("rx-1", arch, sum, data)); r.GetAck() == nil {
		t.Fatalf("repetido = %+v", r)
	}
	e.settle(t)
	if n := gets.Load(); n != 1 {
		t.Fatalf("descargas = %d", n)
	}
}

func TestMigrateReceiveDamagedCopyLeavesNothing(t *testing.T) {
	e := newMigrateEnv(t)
	arch, _, data := worldArchive(t, "LEVEL-MIG")
	servePanel(t, e, arch)
	if r := e.call(t, 30, receiveMsg("rx-1", arch, strings.Repeat("0", 64), data)); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	fin := e.col.final("rx-1")
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "dañada") {
		t.Fatalf("final = %+v", fin)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("el directorio de la migración debe desaparecer: %v", err)
	}
	if e.a.rec.Held("m") {
		t.Fatal("la reserva debe liberarse")
	}
}

func TestMigrateReceiveRefusals(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	gets := servePanel(t, e, arch)
	// Ya existe <DATA_ROOT>/mig (p. ej. un servidor borrado sin sus datos): ni se toca.
	if err := os.MkdirAll(filepath.Join(e.migDir(), "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 40, receiveMsg("rx-a", arch, sum, data)); errCode(r) != errcode.Exists {
		t.Fatalf("directorio existente = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(e.migDir(), "data")); err != nil {
		t.Fatal("el directorio ajeno debe seguir")
	}
	// El servidor ya está en este nodo.
	m := receiveMsg("rx-b", arch, sum, data)
	m.ServerId, m.Slug, m.Filename = "a", "otro", "otro-20261012T040000.000Z-3.tar.zst"
	if r := e.call(t, 41, m); errCode(r) != errcode.Exists {
		t.Fatalf("servidor conocido = %+v", r)
	}
	// No cabe la copia más su extracción con el margen.
	e.a.bk.freeSpace = func(string) (uint64, error) { return 100 << 20, nil }
	m = receiveMsg("rx-c", arch, sum, data)
	m.Slug, m.Filename = "nuevo", "nuevo-20261012T040000.000Z-3.tar.zst"
	if r := e.call(t, 42, m); errCode(r) != errcode.TooLarge || !strings.Contains(r.GetError().GetMessage(), "espacio") {
		t.Fatalf("sin espacio = %+v", r)
	}
	// Petición mal formada.
	m = receiveMsg("rx-d", arch, sum, data)
	m.Sha256 = "xyz"
	if r := e.call(t, 43, m); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("sha256 = %+v", r)
	}
	e.settle(t)
	if n := gets.Load(); n != 0 {
		t.Fatalf("un rechazo no descarga nada: %d", n)
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "nuevo")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("sin espacio no se crea nada")
	}
}

// Un fallo al restaurar (copia verificada pero imposible de extraer) también borra el directorio
// de la migración entero y libera la reserva.
func TestMigrateReceiveRestoreFailureLeavesNothing(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	servePanel(t, e, arch)
	e.a.bk.restore = func(context.Context, backup.RestoreRequest) (backup.Meta, error) {
		return backup.Meta{}, errors.New("extracción rota")
	}
	if r := e.call(t, 30, receiveMsg("rx-1", arch, sum, data)); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	fin := e.col.final("rx-1")
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "extracción rota") {
		t.Fatalf("final = %+v", fin)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("el directorio de la migración debe desaparecer: %v", err)
	}
	if e.a.rec.Held("m") {
		t.Fatal("la reserva debe liberarse")
	}
}

// Si el agente se cierra a mitad de la descarga, la recepción se corta, borra lo recibido y el job
// queda «interrumpido»; la espera del cierre (bk.wait, dentro de waitAll) la incluye.
func TestMigrateReceiveInterruptedByShutdown(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	reached := make(chan struct{})
	panelFor(t, e.a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(arch)))
		_, _ = w.Write(arch[:len(arch)/2])
		w.(http.Flusher).Flush()
		close(reached)
		<-r.Context().Done() // hasta que el agente corte la descarga
	})
	if r := e.call(t, 30, receiveMsg("rx-1", arch, sum, data)); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	waitClosed(t, reached)
	e.cancel()
	if !e.a.bk.wait(10 * time.Second) {
		t.Fatal("wait no debe vencer: la recepción termina al cancelarse")
	}
	rec, _ := e.st.GetJob("rx-1")
	if rec == nil || rec.Status != jobFailed || !strings.Contains(rec.Message, "interrumpid") {
		t.Fatalf("job = %+v", rec)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("el directorio de la migración debe desaparecer: %v", err)
	}
	if e.a.rec.Held("m") {
		t.Fatal("la reserva debe liberarse")
	}
}

func TestMigrateAbortRemovesGhostAndMarkedDir(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	servePanel(t, e, arch)
	e.call(t, 30, receiveMsg("rx-1", arch, sum, data))
	e.settle(t)
	ghost := &mcsmv1.ServerSpec{ServerId: "m", Slug: "mig", Version: 4, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_STOPPED, SpecJson: []byte(specJSON)}
	if r := e.handle(31, &mcsmv1.ApplySpec{Server: ghost}); r.GetAck() == nil {
		t.Fatalf("ApplySpec = %+v", r)
	}
	if c, _ := e.a.rec.Container(context.Background(), "m"); c == nil {
		t.Fatal("el servidor del destino debe tener contenedor")
	}
	abort := &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}
	if r := e.call(t, 32, abort); r.GetAck() == nil {
		t.Fatalf("abort = %+v", r)
	}
	if c, _ := e.a.rec.Container(context.Background(), "m"); c != nil {
		t.Fatal("el contenedor del destino debe borrarse")
	}
	if sp, _ := e.st.GetSpec("m"); sp != nil {
		t.Fatal("la spec del destino debe olvidarse")
	}
	if tomb, _ := e.st.HasTombstone("m"); tomb {
		t.Fatal("sin borrado pendiente")
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("el directorio con el marcador de esta migración debe borrarse")
	}
	if r := e.call(t, 33, abort); r.GetAck() == nil {
		t.Fatalf("repetirlo no hace nada: %+v", r)
	}
}

func TestMigrateAbortKeepsForeignDirAndWaitsForReceive(t *testing.T) {
	e := newMigrateEnv(t)
	if err := os.MkdirAll(e.migDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.migDir(), migrationMarker), []byte("otra\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 40, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}); r.GetAck() == nil {
		t.Fatalf("abort = %+v", r)
	}
	if _, err := os.Stat(e.migDir()); err != nil {
		t.Fatal("el directorio de otra migración se conserva")
	}
	// Recepción en curso (reserva sin spec): busy, el panel reintenta.
	release, err := e.a.rec.Hold("m", holdMigration)
	if err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 41, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "otra"}); errCode(r) != errcode.Busy {
		t.Fatalf("en curso = %+v", r)
	}
	release(context.Background())
	if r := e.call(t, 42, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "../x", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("slug = %+v", r)
	}
}

func TestMigrateRetireStopsAndSetsAsideData(t *testing.T) {
	e := newMigrateEnv(t)
	if !e.running(t) {
		t.Fatal("precondición: el servidor está en marcha")
	}
	retire := &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1}
	if r := e.call(t, 50, retire); r.GetAck() == nil {
		t.Fatalf("retire = %+v", r)
	}
	if c, _ := e.a.rec.Container(context.Background(), "a"); c != nil {
		t.Fatal("el contenedor del origen debe borrarse")
	}
	if sp, _ := e.st.GetSpec("a"); sp != nil {
		t.Fatal("la spec del origen debe olvidarse")
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("el directorio del servidor debe apartarse entero (el slug queda libre)")
	}
	aside := filepath.Join(e.a.cfg.DataRoot, "alpha.migrated-20261012T040000.000Z", "data")
	if got := readLevel(t, aside); got != "LEVEL-1" {
		t.Fatalf("apartado = %q", got)
	}
	if r := e.call(t, 51, retire); r.GetAck() == nil {
		t.Fatalf("repetirlo no hace nada: %+v", r)
	}
	if got := readLevel(t, aside); got != "LEVEL-1" {
		t.Fatal("el apartado sigue igual")
	}
}

func TestMigrateRetireDeleteData(t *testing.T) {
	e := newMigrateEnv(t)
	if r := e.call(t, 50, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", DeleteData: true, SourceVersion: 1}); r.GetAck() == nil {
		t.Fatalf("retire = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("con «borrar origen», <DATA_ROOT>/alpha desaparece entero")
	}
	if c, _ := e.a.rec.Container(context.Background(), "a"); c != nil {
		t.Fatal("el contenedor del origen debe borrarse")
	}
}

func TestMigrateRetireRefusals(t *testing.T) {
	e := newMigrateEnv(t)
	if r := e.call(t, 60, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "otro", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("otro slug = %+v", r)
	}
	release, err := e.a.rec.Hold("a", holdBackup)
	if err != nil {
		t.Fatal(err)
	}
	r := e.call(t, 61, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1})
	if errCode(r) != errcode.Busy || !strings.Contains(r.GetError().GetMessage(), holdBackup) {
		t.Fatalf("reservado = %+v", r)
	}
	release(context.Background())
	if _, err := os.Stat(e.dataDir()); err != nil {
		t.Fatal("rechazado: data sigue en su sitio")
	}
	if !e.running(t) {
		t.Fatal("rechazado: el servidor sigue como estaba")
	}
}

// MigrateAbort de un destino que llegó a arrancar (target_started): para y borra el contenedor
// antes de borrar el directorio.
func TestMigrateAbortRemovesRunningGhost(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	servePanel(t, e, arch)
	e.call(t, 30, receiveMsg("rx-1", arch, sum, data))
	e.settle(t)
	other := strings.Replace(specJSON, "25565", "25566", 1) // otro puerto: el de a está ocupado
	ghost := &mcsmv1.ServerSpec{ServerId: "m", Slug: "mig", Version: 4, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(other)}
	if r := e.handle(31, &mcsmv1.ApplySpec{Server: ghost}); r.GetAck() == nil {
		t.Fatalf("ApplySpec = %+v", r)
	}
	ins, err := e.fake.Inspect(context.Background(), e.a.rec.ContainerID(context.Background(), "m"))
	if err != nil || !ins.Running {
		t.Fatalf("precondición: la copia del destino está en marcha: %+v, %v", ins, err)
	}
	if r := e.call(t, 32, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}); r.GetAck() == nil {
		t.Fatalf("abort = %+v", r)
	}
	if list, _ := e.fake.ListManaged(context.Background()); len(list) != 1 || list[0].Labels["mcsm.server_id"] != "a" {
		t.Fatalf("solo queda el contenedor de a: %+v", list)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("el directorio de la migración debe borrarse")
	}
}

// Mientras el contenedor del origen no se haya podido borrar, sus datos no se apartan ni se
// borran: busy, y el panel repite la orden. Cuando el borrado termina, el reintento los aparta.
func TestMigrateRetireKeepsDataWhileContainerExists(t *testing.T) {
	for _, del := range []bool{false, true} {
		t.Run(fmt.Sprintf("delete_data=%v", del), func(t *testing.T) {
			fake := docker.NewFake()
			eng := &failRemoveEngine{Fake: fake}
			e := newBackupEnvEngine(t, eng, fake, specJSON)
			eng.setFail(true)
			retire := &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", DeleteData: del, SourceVersion: 1}
			if r := e.call(t, 50, retire); errCode(r) != errcode.Busy {
				t.Fatalf("retire = %+v", r)
			}
			if got := readLevel(t, e.dataDir()); got != "LEVEL-1" {
				t.Fatalf("data = %q", got)
			}
			if m, _ := filepath.Glob(filepath.Join(e.a.cfg.DataRoot, "alpha.migrated-*")); len(m) != 0 {
				t.Fatalf("no se aparta nada: %v", m)
			}
			if running := e.running(t); running {
				t.Fatal("el origen queda parado")
			}
			// El tick de lápidas acaba borrando el contenedor; el reintento del panel completa la retirada.
			eng.setFail(false)
			if err := e.a.rec.Remove(context.Background(), "a", false); err != nil {
				t.Fatal(err)
			}
			if r := e.call(t, 51, retire); r.GetAck() == nil {
				t.Fatalf("reintento = %+v", r)
			}
			if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("el slug queda libre")
			}
			m, _ := filepath.Glob(filepath.Join(e.a.cfg.DataRoot, "alpha.migrated-*"))
			if del != (len(m) == 0) {
				t.Fatalf("apartados = %v", m)
			}
		})
	}
}

// Ni MigrateAbort ni MigrateRetire tocan un directorio que usa otro servidor de este nodo.
func TestMigrateNeverTouchesAnotherServersDir(t *testing.T) {
	e := newMigrateEnv(t)
	if err := os.WriteFile(filepath.Join(e.a.cfg.DataRoot, "alpha", migrationMarker), []byte("mig-1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 70, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "alpha", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("abort = %+v", r)
	}
	for i, del := range []bool{false, true} {
		r := e.call(t, uint64(71+i), &mcsmv1.MigrateRetire{ServerId: "zz", Slug: "alpha", MigrationId: "mig-1", DeleteData: del})
		if errCode(r) != errcode.InvalidRequest {
			t.Fatalf("retire = %+v", r)
		}
	}
	if got := readLevel(t, e.dataDir()); got != "LEVEL-1" || !e.running(t) {
		t.Fatalf("el servidor a sigue intacto: %q", got)
	}
}

// Con el agente cerrándose no se empieza nada: busy.
func TestMigrateAbortAndRetireWhileClosing(t *testing.T) {
	e := newMigrateEnv(t)
	e.cancel()
	if !e.a.bk.wait(5 * time.Second) {
		t.Fatal("wait")
	}
	if r := e.call(t, 80, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}); errCode(r) != errcode.Busy {
		t.Fatalf("abort = %+v", r)
	}
	if r := e.call(t, 81, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1}); errCode(r) != errcode.Busy {
		t.Fatalf("retire = %+v", r)
	}
	if got := readLevel(t, e.dataDir()); got != "LEVEL-1" {
		t.Fatalf("data = %q", got)
	}
}

// stopServer para "a" como el paso 1 de la migración (PowerAction stop: estado deseado parado).
func stopServer(t *testing.T, e *backupEnv, msgID uint64) {
	t.Helper()
	if r := e.handle(msgID, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}); r.GetAck() == nil {
		t.Fatalf("stop = %+v", r)
	}
	if e.running(t) {
		t.Fatal("precondición: a parado")
	}
}

// receiveGhost: el destino recibe la copia de "m" (mig-1) y guarda su spec (paso 5), parada.
func receiveGhost(t *testing.T, e *backupEnv) {
	t.Helper()
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	servePanel(t, e, arch)
	e.call(t, 30, receiveMsg("rx-1", arch, sum, data))
	e.settle(t)
	ghost := &mcsmv1.ServerSpec{ServerId: "m", Slug: "mig", Version: 4, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_STOPPED, SpecJson: []byte(specJSON)}
	if r := e.handle(31, &mcsmv1.ApplySpec{Server: ghost}); r.GetAck() == nil {
		t.Fatalf("ApplySpec = %+v", r)
	}
}

func readMarkerFile(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

// I1: tras MigrateConfirm, un MigrateAbort de esa misma migración (p. ej. de un panel restaurado
// desde una foto anterior al commit) no toca nada: ni spec, ni contenedor, ni datos ni copias.
func TestMigrateAbortAfterConfirmKeepsLiveServer(t *testing.T) {
	e := newMigrateEnv(t)
	receiveGhost(t, e)
	confirm := &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}
	if r := e.call(t, 32, confirm); r.GetAck() == nil {
		t.Fatalf("confirm = %+v", r)
	}
	if got := readMarkerFile(t, e.migDir(), migrationMarker); got != "committed mig-1" {
		t.Fatalf("marcador = %q", got)
	}
	if r := e.call(t, 33, confirm); r.GetAck() == nil {
		t.Fatalf("repetir confirm = %+v", r)
	}
	r := e.call(t, 34, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"})
	if errCode(r) != errcode.InvalidRequest {
		t.Fatalf("abort tras confirm = %+v", r)
	}
	if sp, _ := e.st.GetSpec("m"); sp == nil {
		t.Fatal("la spec del servidor vivo se conserva")
	}
	if c, _ := e.a.rec.Container(context.Background(), "m"); c == nil {
		t.Fatal("el contenedor del servidor vivo se conserva")
	}
	if got := readLevel(t, filepath.Join(e.migDir(), "data")); got != "LEVEL-MIG" {
		t.Fatalf("data = %q", got)
	}
	if m, _ := filepath.Glob(filepath.Join(e.migDir(), "backups", "*.tar.zst")); len(m) != 1 {
		t.Fatalf("la copia recibida se conserva: %v", m)
	}
}

// I1: con la spec en el nodo, MigrateAbort lee el marcador antes de tocar nada: si es de otra
// migración (o no hay), invalid_request y la spec sigue.
func TestMigrateAbortReadsMarkerBeforeForgetting(t *testing.T) {
	e := newMigrateEnv(t)
	receiveGhost(t, e)
	if r := e.call(t, 32, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-2"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("abort de otra migración = %+v", r)
	}
	// El servidor "a" no llegó por migración (sin marcador): un abort con su slug no lo olvida.
	if r := e.call(t, 33, &mcsmv1.MigrateAbort{ServerId: "a", Slug: "alpha", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("abort de un servidor sin marcador = %+v", r)
	}
	for _, id := range []string{"m", "a"} {
		if sp, _ := e.st.GetSpec(id); sp == nil {
			t.Fatalf("la spec de %s se conserva", id)
		}
	}
	if !e.running(t) || readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("a sigue intacto y en marcha")
	}
}

func TestMigrateConfirmRefusals(t *testing.T) {
	e := newMigrateEnv(t)
	if r := e.call(t, 40, &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}); r.GetAck() == nil {
		t.Fatalf("sin nada que confirmar = %+v", r)
	}
	receiveGhost(t, e)
	if r := e.call(t, 41, &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "mig", MigrationId: "mig-2"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("marcador de otra migración = %+v", r)
	}
	if r := e.call(t, 42, &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "otro", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("otro slug = %+v", r)
	}
	if got := readMarkerFile(t, e.migDir(), migrationMarker); got != "mig-1" {
		t.Fatalf("el marcador no cambia: %q", got)
	}
}

// I1: el servidor volvió a este nodo con otra migración (otra versión): la retirada de la
// migración antigua no lo toca.
func TestMigrateRetireRefusesAnotherVersion(t *testing.T) {
	e := newMigrateEnv(t)
	back := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 3, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)}
	if r := e.handle(2, &mcsmv1.ApplySpec{Server: back}); r.GetAck() == nil {
		t.Fatalf("ApplySpec = %+v", r)
	}
	for i, del := range []bool{false, true} {
		r := e.call(t, uint64(50+i), &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1, DeleteData: del})
		if errCode(r) != errcode.InvalidRequest || !strings.Contains(r.GetError().GetMessage(), "versión") {
			t.Fatalf("retire con otra versión = %+v", r)
		}
	}
	if sp, _ := e.st.GetSpec("a"); sp == nil || !e.running(t) || readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("el servidor vivo sigue intacto y en marcha")
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha", retiringMarker)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("sin marca de retirada")
	}
}

// m1: un reintento de la retirada sin spec solo toca un <slug> con la marca .mcsm-retiring de esta
// migración; un <slug> recién creado por una recepción (marcador sin confirmar) o ajeno no se toca.
func TestMigrateRetireRetryOnlyTouchesItsMarkedDir(t *testing.T) {
	fake := docker.NewFake()
	eng := &failRemoveEngine{Fake: fake}
	e := newBackupEnvEngine(t, eng, fake, specJSON)
	eng.setFail(true)
	retire := &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1, DeleteData: true}
	if r := e.call(t, 50, retire); errCode(r) != errcode.Busy {
		t.Fatalf("retire = %+v", r)
	}
	dir := filepath.Join(e.a.cfg.DataRoot, "alpha")
	if got := readMarkerFile(t, dir, retiringMarker); got != "mig-1" {
		t.Fatalf("marca de retirada = %q", got)
	}
	eng.setFail(false)
	if err := e.a.rec.Remove(context.Background(), "a", false); err != nil {
		t.Fatal(err)
	}
	// Otro <slug> ocupa el sitio: una recepción en curso (marcador sin confirmar) y, después, uno sin marcas.
	aside := dir + ".kept"
	if err := os.Rename(dir, aside); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, migrationMarker), []byte("mig-9\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 51, retire); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("recepción en curso = %+v", r)
	}
	if err := os.Remove(filepath.Join(dir, migrationMarker)); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 52, retire); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("directorio ajeno = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); err != nil {
		t.Fatal("el directorio ajeno sigue intacto")
	}
	// Con su marca, el reintento completa la retirada.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(aside, dir); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 53, retire); r.GetAck() == nil {
		t.Fatalf("reintento = %+v", r)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("con delete_data, <slug> se borra")
	}
}

// m4: abort, retire y confirm del mismo servidor se ejecutan de uno en uno.
func TestMigrateOpsSerializedPerServer(t *testing.T) {
	e := newMigrateEnv(t)
	unlock, err := e.a.bk.migLocks.lock(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	notify := make(chan struct{}, 1)
	e.a.bk.migLocks.mu.Lock()
	e.a.bk.migLocks.notify = notify
	e.a.bk.migLocks.mu.Unlock()
	e.a.Handle(context.Background(), migrateEnvelope(50, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1}), e.col.reply)
	deadline := time.After(5 * time.Second)
	for e.a.bk.migLocks.waiting("a") != 1 {
		select {
		case <-notify:
		case <-deadline:
			t.Fatal("el retire no llegó a esperar su turno")
		}
	}
	for _, env := range e.col.all() {
		if env.Id == 50 {
			t.Fatalf("respondió sin su turno: %+v", env)
		}
	}
	if sp, _ := e.st.GetSpec("a"); sp == nil || !e.running(t) {
		t.Fatal("sin su turno no toca nada")
	}
	unlock()
	var r *mcsmv1.Envelope
	e.col.waitFor(t, "respuesta a 50", func() bool {
		for _, env := range e.col.all() {
			if env.Id == 50 {
				r = env
				return true
			}
		}
		return false
	})
	if r.GetAck() == nil {
		t.Fatalf("retire = %+v", r)
	}
}

// m2: la copia previa a una migración exige el servidor parado y espera a las escrituras de archivos.
func TestBackupNowPreMigrationRefusesRunningServerAndWaitsFileWrites(t *testing.T) {
	e := newMigrateEnv(t)
	pre := func(id uint64, job string) *mcsmv1.Envelope {
		return e.handle(id, &mcsmv1.BackupNow{ServerId: "a", JobId: job, Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION})
	}
	if r := pre(10, "job-1"); errCode(r) != errcode.InvalidRequest || !strings.Contains(r.GetError().GetMessage(), "en marcha") {
		t.Fatalf("en marcha = %+v", r)
	}
	stopServer(t, e, 11)
	e.a.bk.drainWait = 0
	leave := e.a.fileWrites.enter("a")
	if r := pre(12, "job-2"); errCode(r) != errcode.Busy || !strings.Contains(r.GetError().GetMessage(), "archivos") {
		t.Fatalf("escrituras en curso = %+v", r)
	}
	leave()
	if r := pre(13, "job-3"); r.GetAck() == nil {
		t.Fatalf("parado y sin escrituras = %+v", r)
	}
	e.settle(t)
	if cr := e.col.created(); len(cr) != 1 {
		t.Fatalf("una sola copia: %+v", cr)
	}
	if e.a.rec.Held("a") {
		t.Fatal("reserva liberada")
	}
}
