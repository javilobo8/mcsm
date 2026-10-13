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

// newMigrateEnv: the backups environment (server "a", slug alpha, running and with a world) with
// credentials for the transfers.
func newMigrateEnv(t *testing.T) *backupEnv {
	t.Helper()
	e := newBackupEnv(t, specJSON)
	if err := e.st.SaveCredentials(store.Credentials{NodeID: "n1", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	return e
}

// migrateEnvelope wraps the migration messages.
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
		panic(fmt.Sprintf("unexpected body %T", body))
	}
	return env
}

// call delivers a migration message and waits, without sleeping, for the response with its id (Ack,
// Error or *Result; some arrive from a background task).
func (e *backupEnv) call(t *testing.T, id uint64, body any) *mcsmv1.Envelope {
	t.Helper()
	e.a.Handle(context.Background(), migrateEnvelope(id, body), e.col.reply)
	var out *mcsmv1.Envelope
	e.col.waitFor(t, fmt.Sprintf("response to %d", id), func() bool {
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

// preMigration makes a pre_migration backup of "a" and returns its notice.
func preMigration(t *testing.T, e *backupEnv) *mcsmv1.BackupInfo {
	t.Helper()
	stopServer(t, e, 9) // migration step 1: the prior backup requires the server stopped
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
			http.Error(w, "method", http.StatusMethodNotAllowed)
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
		t.Fatalf("resp = %+v (the panel received %d bytes)", r, len(got))
	}
}

func TestBackupPushErrors(t *testing.T) {
	e := newMigrateEnv(t)
	name := preMigration(t, e).Filename
	panelFor(t, e.a, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }) // expired or already used
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
			t.Errorf("%d: resp = %+v, wanted %s", c.id, r, c.code)
		}
	}
}

const migFile = "mig-20261012T040000.000Z-3.tar.zst"

// worldArchive packs a world (world/level.dat = level) as a backup does and returns the
// .tar.zst, its sha256 and what it takes extracted.
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

// servePanel serves arch on GET /agent/transfer/{xferID} (with Content-Length) and counts the downloads.
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
		t.Fatalf("marker = %q", b)
	}
	meta, err := backup.ReadMeta(filepath.Join(e.migDir(), "backups"), migFile)
	if err != nil || meta.SHA256 != sum || meta.Trigger != backup.TriggerPreMigration || meta.SpecVersion != 3 {
		t.Fatalf("meta = %+v, %v", meta, err)
	}
	if pre, _ := backup.ListPreRestore(filepath.Join(e.migDir(), "data")); len(pre) != 0 {
		t.Fatalf("without previous data there is no pre-restore: %+v", pre)
	}
	if e.a.rec.Held("m") {
		t.Fatal("the reservation must be released when finished")
	}
	if sp, _ := e.st.GetSpec("m"); sp != nil {
		t.Fatal("receiving does not create the spec: the panel sends it afterwards (ApplySpec)")
	}
	// A repeated job_id does not download again: it resends its state (§5.4).
	if r := e.call(t, 31, receiveMsg("rx-1", arch, sum, data)); r.GetAck() == nil {
		t.Fatalf("repeated = %+v", r)
	}
	e.settle(t)
	if n := gets.Load(); n != 1 {
		t.Fatalf("downloads = %d", n)
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
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "corrupted") {
		t.Fatalf("final = %+v", fin)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the migration directory must disappear: %v", err)
	}
	if e.a.rec.Held("m") {
		t.Fatal("the reservation must be released")
	}
}

func TestMigrateReceiveRefusals(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	gets := servePanel(t, e, arch)
	// <DATA_ROOT>/mig already exists (e.g. a server deleted without its data): it is not touched.
	if err := os.MkdirAll(filepath.Join(e.migDir(), "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 40, receiveMsg("rx-a", arch, sum, data)); errCode(r) != errcode.Exists {
		t.Fatalf("existing directory = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(e.migDir(), "data")); err != nil {
		t.Fatal("the foreign directory must remain")
	}
	// The server is already on this node.
	m := receiveMsg("rx-b", arch, sum, data)
	m.ServerId, m.Slug, m.Filename = "a", "other", "other-20261012T040000.000Z-3.tar.zst"
	if r := e.call(t, 41, m); errCode(r) != errcode.Exists {
		t.Fatalf("known server = %+v", r)
	}
	// The backup plus its extraction does not fit with the margin.
	e.a.bk.freeSpace = func(string) (uint64, error) { return 100 << 20, nil }
	m = receiveMsg("rx-c", arch, sum, data)
	m.Slug, m.Filename = "new", "new-20261012T040000.000Z-3.tar.zst"
	if r := e.call(t, 42, m); errCode(r) != errcode.TooLarge || !strings.Contains(r.GetError().GetMessage(), "space") {
		t.Fatalf("without space = %+v", r)
	}
	// Malformed request.
	m = receiveMsg("rx-d", arch, sum, data)
	m.Sha256 = "xyz"
	if r := e.call(t, 43, m); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("sha256 = %+v", r)
	}
	e.settle(t)
	if n := gets.Load(); n != 0 {
		t.Fatalf("a rejection downloads nothing: %d", n)
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "new")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("without space nothing is created")
	}
}

// A failure when restoring (verified backup but impossible to extract) also deletes the whole migration
// directory and releases the reservation.
func TestMigrateReceiveRestoreFailureLeavesNothing(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	servePanel(t, e, arch)
	e.a.bk.restore = func(context.Context, backup.RestoreRequest) (backup.Meta, error) {
		return backup.Meta{}, errors.New("broken extraction")
	}
	if r := e.call(t, 30, receiveMsg("rx-1", arch, sum, data)); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	fin := e.col.final("rx-1")
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "broken extraction") {
		t.Fatalf("final = %+v", fin)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the migration directory must disappear: %v", err)
	}
	if e.a.rec.Held("m") {
		t.Fatal("the reservation must be released")
	}
}

// If the agent shuts down midway through the download, the receive is cut off, deletes what was received and the job
// ends up "interrupted"; the shutdown wait (bk.wait, inside waitAll) includes it.
func TestMigrateReceiveInterruptedByShutdown(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	reached := make(chan struct{})
	panelFor(t, e.a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(arch)))
		_, _ = w.Write(arch[:len(arch)/2])
		w.(http.Flusher).Flush()
		close(reached)
		<-r.Context().Done() // until the agent cuts the download
	})
	if r := e.call(t, 30, receiveMsg("rx-1", arch, sum, data)); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	waitClosed(t, reached)
	e.cancel()
	if !e.a.bk.wait(10 * time.Second) {
		t.Fatal("wait must not expire: the receive ends when cancelled")
	}
	rec, _ := e.st.GetJob("rx-1")
	if rec == nil || rec.Status != jobFailed || !strings.Contains(rec.Message, "interrupted") {
		t.Fatalf("job = %+v", rec)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the migration directory must disappear: %v", err)
	}
	if e.a.rec.Held("m") {
		t.Fatal("the reservation must be released")
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
		t.Fatal("the target server must have a container")
	}
	abort := &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}
	if r := e.call(t, 32, abort); r.GetAck() == nil {
		t.Fatalf("abort = %+v", r)
	}
	if c, _ := e.a.rec.Container(context.Background(), "m"); c != nil {
		t.Fatal("the target's container must be deleted")
	}
	if sp, _ := e.st.GetSpec("m"); sp != nil {
		t.Fatal("the target's spec must be forgotten")
	}
	if tomb, _ := e.st.HasTombstone("m"); tomb {
		t.Fatal("no pending deletion")
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the directory with this migration's marker must be deleted")
	}
	if r := e.call(t, 33, abort); r.GetAck() == nil {
		t.Fatalf("repeating it does nothing: %+v", r)
	}
}

func TestMigrateAbortKeepsForeignDirAndWaitsForReceive(t *testing.T) {
	e := newMigrateEnv(t)
	if err := os.MkdirAll(e.migDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.migDir(), migrationMarker), []byte("another\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 40, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}); r.GetAck() == nil {
		t.Fatalf("abort = %+v", r)
	}
	if _, err := os.Stat(e.migDir()); err != nil {
		t.Fatal("the directory of another migration is kept")
	}
	// Receive in progress (reservation without a spec): busy, the panel retries.
	release, err := e.a.rec.Hold("m", holdMigration)
	if err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 41, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "another"}); errCode(r) != errcode.Busy {
		t.Fatalf("in progress = %+v", r)
	}
	release(context.Background())
	if r := e.call(t, 42, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "../x", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("slug = %+v", r)
	}
}

func TestMigrateRetireStopsAndSetsAsideData(t *testing.T) {
	e := newMigrateEnv(t)
	if !e.running(t) {
		t.Fatal("precondition: the server is running")
	}
	retire := &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1}
	if r := e.call(t, 50, retire); r.GetAck() == nil {
		t.Fatalf("retire = %+v", r)
	}
	if c, _ := e.a.rec.Container(context.Background(), "a"); c != nil {
		t.Fatal("the source's container must be deleted")
	}
	if sp, _ := e.st.GetSpec("a"); sp != nil {
		t.Fatal("the source's spec must be forgotten")
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the server's directory must be set aside whole (the slug is left free)")
	}
	aside := filepath.Join(e.a.cfg.DataRoot, "alpha.migrated-20261012T040000.000Z", "data")
	if got := readLevel(t, aside); got != "LEVEL-1" {
		t.Fatalf("set aside = %q", got)
	}
	if r := e.call(t, 51, retire); r.GetAck() == nil {
		t.Fatalf("repeating it does nothing: %+v", r)
	}
	if got := readLevel(t, aside); got != "LEVEL-1" {
		t.Fatal("the set-aside directory stays the same")
	}
}

func TestMigrateRetireDeleteData(t *testing.T) {
	e := newMigrateEnv(t)
	if r := e.call(t, 50, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", DeleteData: true, SourceVersion: 1}); r.GetAck() == nil {
		t.Fatalf("retire = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("with \"delete source\", <DATA_ROOT>/alpha disappears entirely")
	}
	if c, _ := e.a.rec.Container(context.Background(), "a"); c != nil {
		t.Fatal("the source's container must be deleted")
	}
}

func TestMigrateRetireRefusals(t *testing.T) {
	e := newMigrateEnv(t)
	if r := e.call(t, 60, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "other", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("another slug = %+v", r)
	}
	release, err := e.a.rec.Hold("a", holdBackup)
	if err != nil {
		t.Fatal(err)
	}
	r := e.call(t, 61, &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1})
	if errCode(r) != errcode.Busy || !strings.Contains(r.GetError().GetMessage(), holdBackup) {
		t.Fatalf("reserved = %+v", r)
	}
	release(context.Background())
	if _, err := os.Stat(e.dataDir()); err != nil {
		t.Fatal("rejected: data stays in place")
	}
	if !e.running(t) {
		t.Fatal("rejected: the server stays as it was")
	}
}

// MigrateAbort of a target that got to start (target_started): it stops and deletes the container
// before deleting the directory.
func TestMigrateAbortRemovesRunningGhost(t *testing.T) {
	e := newMigrateEnv(t)
	arch, sum, data := worldArchive(t, "LEVEL-MIG")
	servePanel(t, e, arch)
	e.call(t, 30, receiveMsg("rx-1", arch, sum, data))
	e.settle(t)
	other := strings.Replace(specJSON, "25565", "25566", 1) // another port: a's is taken
	ghost := &mcsmv1.ServerSpec{ServerId: "m", Slug: "mig", Version: 4, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(other)}
	if r := e.handle(31, &mcsmv1.ApplySpec{Server: ghost}); r.GetAck() == nil {
		t.Fatalf("ApplySpec = %+v", r)
	}
	ins, err := e.fake.Inspect(context.Background(), e.a.rec.ContainerID(context.Background(), "m"))
	if err != nil || !ins.Running {
		t.Fatalf("precondition: the target's copy is running: %+v, %v", ins, err)
	}
	if r := e.call(t, 32, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}); r.GetAck() == nil {
		t.Fatalf("abort = %+v", r)
	}
	if list, _ := e.fake.ListManaged(context.Background()); len(list) != 1 || list[0].Labels["mcsm.server_id"] != "a" {
		t.Fatalf("only a's container remains: %+v", list)
	}
	if _, err := os.Stat(e.migDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the migration directory must be deleted")
	}
}

// As long as the source's container could not be deleted, its data is neither set aside nor
// deleted: busy, and the panel repeats the order. When the deletion finishes, the retry sets it aside.
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
				t.Fatalf("nothing is set aside: %v", m)
			}
			if running := e.running(t); running {
				t.Fatal("the source stays stopped")
			}
			// The tombstone tick ends up deleting the container; the panel's retry completes the retirement.
			eng.setFail(false)
			if err := e.a.rec.Remove(context.Background(), "a", false); err != nil {
				t.Fatal(err)
			}
			if r := e.call(t, 51, retire); r.GetAck() == nil {
				t.Fatalf("retry = %+v", r)
			}
			if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("the slug is left free")
			}
			m, _ := filepath.Glob(filepath.Join(e.a.cfg.DataRoot, "alpha.migrated-*"))
			if del != (len(m) == 0) {
				t.Fatalf("set aside = %v", m)
			}
		})
	}
}

// Neither MigrateAbort nor MigrateRetire touch a directory used by another server on this node.
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
		t.Fatalf("server a stays intact: %q", got)
	}
}

// With the agent shutting down nothing is started: busy.
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

// stopServer stops "a" like migration step 1 (PowerAction stop: desired state stopped).
func stopServer(t *testing.T, e *backupEnv, msgID uint64) {
	t.Helper()
	if r := e.handle(msgID, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}); r.GetAck() == nil {
		t.Fatalf("stop = %+v", r)
	}
	if e.running(t) {
		t.Fatal("precondition: a stopped")
	}
}

// receiveGhost: the target receives the backup of "m" (mig-1) and stores its spec (step 5), stopped.
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

// I1: after MigrateConfirm, a MigrateAbort of that same migration (e.g. from a restored panel
// from a snapshot prior to the commit) touches nothing: neither spec, nor container, nor data nor backups.
func TestMigrateAbortAfterConfirmKeepsLiveServer(t *testing.T) {
	e := newMigrateEnv(t)
	receiveGhost(t, e)
	confirm := &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}
	if r := e.call(t, 32, confirm); r.GetAck() == nil {
		t.Fatalf("confirm = %+v", r)
	}
	if got := readMarkerFile(t, e.migDir(), migrationMarker); got != "committed mig-1" {
		t.Fatalf("marker = %q", got)
	}
	if r := e.call(t, 33, confirm); r.GetAck() == nil {
		t.Fatalf("repeat confirm = %+v", r)
	}
	r := e.call(t, 34, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-1"})
	if errCode(r) != errcode.InvalidRequest {
		t.Fatalf("abort after confirm = %+v", r)
	}
	if sp, _ := e.st.GetSpec("m"); sp == nil {
		t.Fatal("the live server's spec is kept")
	}
	if c, _ := e.a.rec.Container(context.Background(), "m"); c == nil {
		t.Fatal("the live server's container is kept")
	}
	if got := readLevel(t, filepath.Join(e.migDir(), "data")); got != "LEVEL-MIG" {
		t.Fatalf("data = %q", got)
	}
	if m, _ := filepath.Glob(filepath.Join(e.migDir(), "backups", "*.tar.zst")); len(m) != 1 {
		t.Fatalf("the received backup is kept: %v", m)
	}
}

// I1: with the spec on the node, MigrateAbort reads the marker before touching anything: if it is from another
// migration (or there is none), invalid_request and the spec stays.
func TestMigrateAbortReadsMarkerBeforeForgetting(t *testing.T) {
	e := newMigrateEnv(t)
	receiveGhost(t, e)
	if r := e.call(t, 32, &mcsmv1.MigrateAbort{ServerId: "m", Slug: "mig", MigrationId: "mig-2"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("abort of another migration = %+v", r)
	}
	// Server "a" did not arrive by migration (no marker): an abort with its slug does not forget it.
	if r := e.call(t, 33, &mcsmv1.MigrateAbort{ServerId: "a", Slug: "alpha", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("abort of a server without a marker = %+v", r)
	}
	for _, id := range []string{"m", "a"} {
		if sp, _ := e.st.GetSpec(id); sp == nil {
			t.Fatalf("the spec of %s is kept", id)
		}
	}
	if !e.running(t) || readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("a stays intact and running")
	}
}

func TestMigrateConfirmRefusals(t *testing.T) {
	e := newMigrateEnv(t)
	if r := e.call(t, 40, &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "mig", MigrationId: "mig-1"}); r.GetAck() == nil {
		t.Fatalf("nothing to confirm = %+v", r)
	}
	receiveGhost(t, e)
	if r := e.call(t, 41, &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "mig", MigrationId: "mig-2"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("marker of another migration = %+v", r)
	}
	if r := e.call(t, 42, &mcsmv1.MigrateConfirm{ServerId: "m", Slug: "other", MigrationId: "mig-1"}); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("another slug = %+v", r)
	}
	if got := readMarkerFile(t, e.migDir(), migrationMarker); got != "mig-1" {
		t.Fatalf("the marker does not change: %q", got)
	}
}

// I1: the server came back to this node with another migration (another version): the retirement of the
// old migration does not touch it.
func TestMigrateRetireRefusesAnotherVersion(t *testing.T) {
	e := newMigrateEnv(t)
	back := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 3, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)}
	if r := e.handle(2, &mcsmv1.ApplySpec{Server: back}); r.GetAck() == nil {
		t.Fatalf("ApplySpec = %+v", r)
	}
	for i, del := range []bool{false, true} {
		r := e.call(t, uint64(50+i), &mcsmv1.MigrateRetire{ServerId: "a", Slug: "alpha", MigrationId: "mig-1", SourceVersion: 1, DeleteData: del})
		if errCode(r) != errcode.InvalidRequest || !strings.Contains(r.GetError().GetMessage(), "version") {
			t.Fatalf("retire with another version = %+v", r)
		}
	}
	if sp, _ := e.st.GetSpec("a"); sp == nil || !e.running(t) || readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("the live server stays intact and running")
	}
	if _, err := os.Stat(filepath.Join(e.a.cfg.DataRoot, "alpha", retiringMarker)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("without a retirement mark")
	}
}

// m1: a retry of the retirement without a spec only touches a <slug> with this migration's .mcsm-retiring mark;
// a <slug> freshly created by a receive (unconfirmed marker) or a foreign one is not touched.
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
		t.Fatalf("retirement mark = %q", got)
	}
	eng.setFail(false)
	if err := e.a.rec.Remove(context.Background(), "a", false); err != nil {
		t.Fatal(err)
	}
	// Another <slug> takes the place: a receive in progress (unconfirmed marker) and, afterwards, one without marks.
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
		t.Fatalf("receive in progress = %+v", r)
	}
	if err := os.Remove(filepath.Join(dir, migrationMarker)); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 52, retire); errCode(r) != errcode.InvalidRequest {
		t.Fatalf("foreign directory = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); err != nil {
		t.Fatal("the foreign directory stays intact")
	}
	// With its mark, the retry completes the retirement.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(aside, dir); err != nil {
		t.Fatal(err)
	}
	if r := e.call(t, 53, retire); r.GetAck() == nil {
		t.Fatalf("retry = %+v", r)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("with delete_data, <slug> is deleted")
	}
}

// m4: abort, retire and confirm of the same server run one at a time.
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
			t.Fatal("the retire did not get to wait for its turn")
		}
	}
	for _, env := range e.col.all() {
		if env.Id == 50 {
			t.Fatalf("it responded without its turn: %+v", env)
		}
	}
	if sp, _ := e.st.GetSpec("a"); sp == nil || !e.running(t) {
		t.Fatal("without its turn it touches nothing")
	}
	unlock()
	var r *mcsmv1.Envelope
	e.col.waitFor(t, "response to 50", func() bool {
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

// m2: the backup prior to a migration requires the server stopped and waits for the file writes.
func TestBackupNowPreMigrationRefusesRunningServerAndWaitsFileWrites(t *testing.T) {
	e := newMigrateEnv(t)
	pre := func(id uint64, job string) *mcsmv1.Envelope {
		return e.handle(id, &mcsmv1.BackupNow{ServerId: "a", JobId: job, Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION})
	}
	if r := pre(10, "job-1"); errCode(r) != errcode.InvalidRequest || !strings.Contains(r.GetError().GetMessage(), "running") {
		t.Fatalf("running = %+v", r)
	}
	stopServer(t, e, 11)
	e.a.bk.drainWait = 0
	leave := e.a.fileWrites.enter("a")
	if r := pre(12, "job-2"); errCode(r) != errcode.Busy || !strings.Contains(r.GetError().GetMessage(), "file") {
		t.Fatalf("writes in progress = %+v", r)
	}
	leave()
	if r := pre(13, "job-3"); r.GetAck() == nil {
		t.Fatalf("stopped and without writes = %+v", r)
	}
	e.settle(t)
	if cr := e.col.created(); len(cr) != 1 {
		t.Fatalf("a single backup: %+v", cr)
	}
	if e.a.rec.Held("a") {
		t.Fatal("reservation released")
	}
}
