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
