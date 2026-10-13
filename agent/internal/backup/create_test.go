package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRcon records the commands and the state of the context each one arrived with.
type fakeRcon struct {
	mu     sync.Mutex
	cmds   []string
	ctxErr map[string]error
	fail   map[string]error
	reply  map[string]string // server reply; "ok" if none
}

func (f *fakeRcon) run(ctx context.Context, cmd string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, cmd)
	if f.ctxErr == nil {
		f.ctxErr = map[string]error{}
	}
	f.ctxErr[cmd] = ctx.Err()
	if r, ok := f.reply[cmd]; ok {
		return r, f.fail[cmd]
	}
	return "ok", f.fail[cmd]
}

var t0 = time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)

// newWorld creates <root>/survival/data with a minimal world and returns data and backups.
func newWorld(t *testing.T) (dataDir, backupsDir string) {
	t.Helper()
	root := t.TempDir()
	dataDir = filepath.Join(root, "survival", "data")
	backupsDir = filepath.Join(root, "survival", "backups")
	mustWrite(t, filepath.Join(dataDir, "server.properties"), "motd=hola\n", 0o644)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-1", 0o644)
	mustWrite(t, filepath.Join(dataDir, "logs", "latest.log"), "noise", 0o644)
	return dataDir, backupsDir
}

func baseReq(dataDir, backupsDir string) CreateRequest {
	return CreateRequest{
		ServerID: "srv-1", Slug: "survival", SpecVersion: 3, Trigger: TriggerManual,
		DataDir: dataDir, BackupsDir: backupsDir, Excludes: []string{"logs"},
		Now:   func() time.Time { return t0 },
		Sleep: func(context.Context, time.Duration) error { return nil },
		// Only counts when hot (with Rcon): the container is still the same and running.
		Running: func(context.Context) error { return nil },
	}
}

// assertNoArchives checks that no backups or partials remain.
func assertNoArchives(t *testing.T, backupsDir string) {
	t.Helper()
	ents, _ := os.ReadDir(backupsDir)
	if len(ents) != 0 {
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Fatalf("files remain: %v", names)
	}
}

func TestCreateRunningServerQuiescesWithRcon(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var slept time.Duration
	req.Sleep = func(_ context.Context, d time.Duration) error { slept = d; return nil }
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	meta, err := Create(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("RCON commands = %s", got)
	}
	if slept != FlushWait {
		t.Fatalf("wait after flush = %v", slept)
	}
	if meta.Filename != "survival-20261012T040000.000Z-3.tar.zst" || meta.Trigger != TriggerManual || meta.ServerID != "srv-1" {
		t.Fatalf("meta = %+v", meta)
	}
	data, err := os.ReadFile(filepath.Join(backupsDir, meta.Filename))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != meta.SHA256 || int64(len(data)) != meta.SizeBytes {
		t.Fatal("sha256 or size do not match the file")
	}
	if onDisk, err := ReadMeta(backupsDir, meta.Filename); err != nil || onDisk.SHA256 != meta.SHA256 {
		t.Fatalf(".json = %+v, %v", onDisk, err)
	}
	out := filepath.Join(t.TempDir(), "x")
	if err := os.Mkdir(out, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), out, nil); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(out, "world", "level.dat")) != "LEVEL-1" || exists(filepath.Join(out, "logs")) {
		t.Fatal("wrong backup content")
	}
	if ents, _ := os.ReadDir(backupsDir); len(ents) != 2 {
		t.Fatalf("the .tar.zst and its .json must remain: %d", len(ents))
	}
	if !strings.Contains(strings.Join(logs, "\n"), "save-on") {
		t.Fatalf("the job log must record the save-on: %v", logs)
	}
}

func TestCreateCancelledStillSendsSaveOn(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	req.Sleep = func(ctx context.Context, d time.Duration) error { cancel(); return ctx.Err() }
	if _, err := Create(ctx, req); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("commands = %v", rc.cmds)
	}
	if rc.ctxErr["save-on"] != nil {
		t.Fatal("save-on must go with a live context even if the job is cancelled")
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateSaveOffFailureStillSendsSaveOn(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-off": errors.New("rcon: connect: timeout")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "save-off") {
		t.Fatalf("err = %v", err)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-on" {
		t.Fatalf("commands = %s", got)
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateFailureMidCopyRemovesPartial(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	req.Progress = func(pct uint32, _ string) {
		if pct > 2 { // after the first file
			cancel()
		}
	}
	if _, err := Create(ctx, req); err == nil {
		t.Fatal("it must fail")
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("commands = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// save-on fails with the server running: the job fails, so the backup is not confirmed
// (spec §10: a failed backup deletes its partial); the error asks to run save-on.
func TestCreateSaveOnFailureDiscardsTheBackup(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-on": errors.New("rcon: connect: connection refused")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	meta, err := Create(context.Background(), req)
	if !errors.Is(err, ErrResume) || !strings.Contains(err.Error(), "discarded") {
		t.Fatalf("err = %v", err)
	}
	if strings.Count(err.Error(), "save-on") != 2 { // "(save-on); run save-on": the reason only once
		t.Fatalf("the save-on failure is counted once: %q", err)
	}
	if meta.Filename != "" {
		t.Fatalf("a failed backup returns no metadata: %+v", meta)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "WARNING: save-on failed") {
		t.Fatalf("the log must warn about the save-on: %v", logs)
	}
	assertNoArchives(t, backupsDir)
}

// stopped is what the container check returns if it stopped during the backup.
var stopped = fmt.Errorf("%w (its container is no longer running)", ErrServerStopped)

// runningSeq returns a check that answers with results in order (and then the last one).
func runningSeq(calls *[]string, results ...error) func(context.Context) error {
	return func(ctx context.Context) error {
		*calls = append(*calls, "check")
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r := results[0]
		if len(results) > 1 {
			results = results[1:]
		}
		return r
	}
}

// assertStoppedErr: the message says the server stopped and the backup was discarded, and it does not
// mention save-on (a stopped server starts again with autosave enabled).
func assertStoppedErr(t *testing.T, err error, logs []string) {
	t.Helper()
	if !errors.Is(err, ErrServerStopped) || errors.Is(err, ErrResume) {
		t.Fatalf("err = %v; expected ErrServerStopped without ErrResume", err)
	}
	msg := err.Error()
	if !strings.Contains(msg, "stopped") || !strings.Contains(msg, "discarded") || strings.Contains(msg, "save-on") {
		t.Fatalf("message = %q", msg)
	}
	if strings.Contains(strings.Join(logs, "\n"), "WARNING") {
		t.Fatalf("no false save-on warnings in the log: %v", logs)
	}
}

// The container stops during the tar (mc-router for inactivity, docker stop, a crash):
// Minecraft saves when stopping even with save-off, so the backup is not valid. It is discarded without
// .json or final name, and save-on is not sent (there is no server to send it to).
func TestCreateServerStoppedDuringCopyDiscards(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var calls []string
	req.Running = runningSeq(&calls, stopped)
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	meta, err := Create(context.Background(), req)
	assertStoppedErr(t, err, logs)
	if meta.Filename != "" {
		t.Fatalf("meta = %+v", meta)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush" {
		t.Fatalf("commands = %s; no save-on to a stopped server", got)
	}
	assertNoArchives(t, backupsDir)
}

// The check when closing the tar passes, but the container is gone before the .json (the
// stop started during the tar and Minecraft was still saving): it is discarded all the same.
func TestCreateServerStoppedBeforeCommitDiscards(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	var calls []string
	req := baseReq(dataDir, backupsDir)
	req.Rcon = func(_ context.Context, cmd string) (string, error) { calls = append(calls, cmd); return "", nil }
	req.Running = runningSeq(&calls, nil, stopped)
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	_, err := Create(context.Background(), req)
	assertStoppedErr(t, err, logs)
	if got := strings.Join(calls, ","); got != "save-off,save-all flush,check,save-on,check" {
		t.Fatalf("order = %s; expected: check when closing the tar, save-on, check before confirming", got)
	}
	assertNoArchives(t, backupsDir)
}

// save-on fails because the server just stopped: the reason is the stop, not save-on.
func TestCreateSaveOnFailsBecauseServerStopped(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-on": errors.New("rcon: connect: lookup mcsm-survival: server misbehaving")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var calls []string
	req.Running = runningSeq(&calls, nil, stopped)
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	_, err := Create(context.Background(), req)
	assertStoppedErr(t, err, logs)
	assertNoArchives(t, backupsDir)
}

// If Docker does not allow checking the container, the backup is not accepted; save-on goes out anyway.
func TestCreateCannotCheckContainerDiscards(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var calls []string
	req.Running = runningSeq(&calls, errors.New("docker: i/o timeout"))
	_, err := Create(context.Background(), req)
	if err == nil || errors.Is(err, ErrServerStopped) || !strings.Contains(err.Error(), "could not check") ||
		!strings.Contains(err.Error(), "docker: i/o timeout") || !strings.Contains(err.Error(), "discarded") {
		t.Fatalf("err = %v", err)
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("commands = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// A hot backup without a container check is a programming error.
func TestCreateHotCopyRequiresRunningCheck(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	req.Running = nil
	if _, err := Create(context.Background(), req); err == nil {
		t.Fatal("it must fail")
	}
	if len(rc.cmds) != 0 {
		t.Fatalf("without touching the server: %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// growWhileCopying adds to dataDir a large, incompressible region and makes it grow
// while the tar reads it (on the backup's first write, which watches the free space).
func growWhileCopying(t *testing.T, req *CreateRequest) {
	t.Helper()
	noise := make([]byte, 4<<20)
	rng := rand.New(rand.NewPCG(5, 6))
	for i := range noise {
		noise[i] = byte(rng.Uint32())
	}
	big := filepath.Join(req.DataDir, "world", "region", "r.0.0.mca")
	mustWrite(t, big, string(noise), 0o644)
	calls := 0
	req.FreeSpace = func(string) (uint64, error) {
		calls++
		if calls == 2 { // 1: before save-off; 2: the backup's first write
			f, err := os.OpenFile(big, os.O_WRONLY|os.O_APPEND, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if _, err := f.WriteString("chunk saved when stopping"); err != nil {
				t.Fatal(err)
			}
		}
		return 1 << 50, nil
	}
}

// The E2E case: the server stops during the tar and Minecraft rewrites a region
// while it is being read. The message tells the stop (the cause) and the log, the file.
func TestCreateFileChangedBecauseServerStopped(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	growWhileCopying(t, &req)
	var calls []string
	req.Running = runningSeq(&calls, stopped)
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	_, err := Create(context.Background(), req)
	assertStoppedErr(t, err, logs)
	if !strings.Contains(strings.Join(logs, "\n"), "world/region/r.0.0.mca") {
		t.Fatalf("the log must name the file that changed: %v", logs)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush" {
		t.Fatalf("commands = %s", got)
	}
	assertNoArchives(t, backupsDir)
}

// A file changes during the backup with the server running: the backup is discarded with the
// file's name and save-on goes out anyway.
func TestCreateFileChangedWhileRunningDiscards(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	growWhileCopying(t, &req)
	_, err := Create(context.Background(), req)
	if !errors.Is(err, ErrSourceChanged) || !strings.Contains(err.Error(), "world/region/r.0.0.mca") || !strings.Contains(err.Error(), "discarded") {
		t.Fatalf("err = %v", err)
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("commands = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// Cold, nobody writes (server stopped and reserved); if something changes anyway, it is not valid either.
func TestCreateColdFileChangedDiscards(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	req := baseReq(dataDir, backupsDir) // Rcon nil
	growWhileCopying(t, &req)
	if _, err := Create(context.Background(), req); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("err = %v", err)
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateStoppedServerSkipsRcon(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	meta, err := Create(context.Background(), baseReq(dataDir, backupsDir)) // Rcon nil
	if err != nil || !exists(filepath.Join(backupsDir, meta.Filename)) {
		t.Fatalf("meta = %+v, %v", meta, err)
	}
}

func TestCreateWithoutData(t *testing.T) {
	root := t.TempDir()
	req := baseReq(filepath.Join(root, "survival", "data"), filepath.Join(root, "survival", "backups"))
	if _, err := Create(context.Background(), req); err == nil || !strings.Contains(err.Error(), "has no data") {
		t.Fatalf("err = %v", err)
	}
	req = baseReq(filepath.Join(root, "x"), filepath.Join(root, "y"))
	req.Slug = "../etc"
	if _, err := Create(context.Background(), req); err == nil {
		t.Fatal("an invalid slug must be rejected")
	}
}

// If the backup fails AND save-on also fails, the error must say both things: the world
// has been left without autosave and someone has to know.
func TestCreateCopyAndSaveOnFailureReportsBoth(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	rc := &fakeRcon{fail: map[string]error{"save-on": errors.New("rcon: connect: connection refused")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	req.Sleep = func(ctx context.Context, _ time.Duration) error { cancel(); return ctx.Err() }
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	meta, err := Create(ctx, req)
	if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrResume) {
		t.Fatalf("err = %v; it must wrap the cancellation and ErrResume", err)
	}
	if strings.Contains(err.Error(), "\n") {
		t.Fatalf("the error reaches the job and the UI: a single line: %q", err)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "may still be disabled") {
		t.Fatalf("the log must warn that autosave may still be disabled: %v", logs)
	}
	if meta.Filename != "" {
		t.Fatalf("without a backup there is no metadata: %+v", meta)
	}
	assertNoArchives(t, backupsDir)
}

// save-on goes with its own bounded context (resumeTimeout), not with the job's;
// save-off and save-all flush go with the caller's, whose deadline rules (a flush on a
// large world takes more than 5 s).
func TestCreateRconContexts(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	start := time.Now()
	ctx, cancel := context.WithDeadline(context.Background(), start.Add(2*time.Minute))
	defer cancel()
	deadlines := map[string]time.Time{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = func(c context.Context, cmd string) (string, error) {
		dl, ok := c.Deadline()
		if !ok {
			t.Errorf("%s without a deadline", cmd)
		}
		if c.Err() != nil {
			t.Errorf("%s with the context already finished", cmd)
		}
		deadlines[cmd] = dl
		return "", nil
	}
	if _, err := Create(ctx, req); err != nil {
		t.Fatal(err)
	}
	end := time.Now()
	for _, cmd := range []string{"save-off", "save-all flush"} {
		if !deadlines[cmd].Equal(start.Add(2 * time.Minute)) {
			t.Errorf("%s: deadline %v; it must be the caller's", cmd, deadlines[cmd])
		}
	}
	on := deadlines["save-on"]
	if on.Before(start.Add(resumeTimeout)) || on.After(end.Add(resumeTimeout)) {
		t.Errorf("save-on: deadline %v; it must be its own of %v", on, resumeTimeout)
	}
}

func TestCreateProgressAndUncompressedSize(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var pcts []uint32
	req.Progress = func(p uint32, _ string) { pcts = append(pcts, p) }
	meta, err := Create(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if len(pcts) < 3 || pcts[0] != 1 || pcts[1] != 2 || pcts[len(pcts)-1] != 99 {
		t.Fatalf("progress = %v; expected 1 (save-off), 2–97 (copy), 99 (written)", pcts)
	}
	for i := 1; i < len(pcts); i++ {
		if pcts[i] < pcts[i-1] {
			t.Fatalf("progress must not go backwards: %v", pcts)
		}
	}
	const want = int64(len("motd=hola\n") + len("LEVEL-1")) // logs excluded
	if meta.DataBytes != want {
		t.Fatalf("DataBytes = %d, want %d", meta.DataBytes, want)
	}
	if onDisk, err := ReadMeta(backupsDir, meta.Filename); err != nil || onDisk.DataBytes != want {
		t.Fatalf(".json = %+v, %v", onDisk, err)
	}
}

func TestCreateFlushFailureStillSendsSaveOn(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-all flush": errors.New("rcon: execute: i/o timeout")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "save-all flush") {
		t.Fatalf("err = %v", err)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("commands = %s", got)
	}
	assertNoArchives(t, backupsDir)
}

// Spec §6.5: tar; save-on; sha256; .json. The world must not stay without autosave during
// the fsync of a multi-GiB file, the rename and the metadata.
func TestCreateSaveOnRightAfterArchive(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	final := filepath.Join(backupsDir, Filename("survival", t0, 3))
	var cmds []string
	var partialAtSaveOn, finalAtSaveOn bool
	req := baseReq(dataDir, backupsDir)
	req.Rcon = func(_ context.Context, cmd string) (string, error) {
		cmds = append(cmds, cmd)
		if cmd == "save-on" {
			partialAtSaveOn, finalAtSaveOn = exists(final+partialExt), exists(final)
		}
		return "", nil
	}
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(cmds, ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("save-on only once: %s", got)
	}
	if !partialAtSaveOn || finalAtSaveOn {
		t.Fatalf("save-on must go out when the tar is closed, before renaming (partial=%v final=%v)", partialAtSaveOn, finalAtSaveOn)
	}
}

func TestCreateLogsRconReplies(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{reply: map[string]string{
		"save-off":       "Automatic saving is now disabled",
		"save-all flush": "Unable to save the game\n(no space)",
		"save-on":        "Automatic saving is now enabled",
	}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(logs, "\n")
	for _, want := range []string{"Automatic saving is now disabled", "WARNING", "Unable to save the game (no space)", "Automatic saving is now enabled"} {
		if !strings.Contains(all, want) {
			t.Errorf("%q missing from the log: %v", want, logs)
		}
	}
	if strings.Count(all, "WARNING") != 1 {
		t.Errorf("only the failure reply carries WARNING: %v", logs)
	}
}

func TestCreateRenameFailureRemovesPartialAndMeta(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	stubRename(t, func(oldpath, newpath string) error {
		if strings.HasSuffix(newpath, Ext) {
			return errors.New("simulated failure")
		}
		return os.Rename(oldpath, newpath)
	})
	if _, err := Create(context.Background(), req); err == nil || !strings.Contains(err.Error(), "simulated failure") {
		t.Fatalf("err = %v", err)
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("commands = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// The inventory (List) must never see the backup without its .json: it is written before the final name.
func TestCreateMetaBeforeArchiveIsVisible(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	var metaFirst bool
	stubRename(t, func(oldpath, newpath string) error {
		if strings.HasSuffix(newpath, Ext) {
			m, err := ReadMeta(backupsDir, filepath.Base(newpath))
			metaFirst = err == nil && m.SHA256 != ""
		}
		return os.Rename(oldpath, newpath)
	})
	if _, err := Create(context.Background(), baseReq(dataDir, backupsDir)); err != nil {
		t.Fatal(err)
	}
	if !metaFirst {
		t.Fatal("the .json must exist (with its sha256) before the backup has its final name")
	}
}

func TestCreateRejectsSymlinkedData(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	target := filepath.Join(filepath.Dir(dataDir), "real-data")
	if err := os.Rename(dataDir, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, dataDir); err != nil {
		t.Fatal(err)
	}
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	if _, err := Create(context.Background(), req); err == nil || !strings.Contains(err.Error(), "is not a directory") {
		t.Fatalf("err = %v", err)
	}
	if len(rc.cmds) != 0 {
		t.Fatalf("with nothing to copy autosave is not touched: %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateUnreadableDataIsNotMissing(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root does not get EACCES")
	}
	dataDir, backupsDir := newWorld(t)
	parent := filepath.Dir(dataDir)
	if err := os.Chmod(parent, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o755) })
	backupsDir = filepath.Join(t.TempDir(), "backups")
	_, err := Create(context.Background(), baseReq(dataDir, backupsDir))
	if err == nil || strings.Contains(err.Error(), "has no data") || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("an EACCES is reported as such: %v", err)
	}
}
