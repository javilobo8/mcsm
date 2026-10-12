package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
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
