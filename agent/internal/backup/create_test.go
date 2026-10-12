package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRcon registra los comandos y el estado del contexto con el que llegó cada uno.
type fakeRcon struct {
	mu     sync.Mutex
	cmds   []string
	ctxErr map[string]error
	fail   map[string]error
}

func (f *fakeRcon) run(ctx context.Context, cmd string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, cmd)
	if f.ctxErr == nil {
		f.ctxErr = map[string]error{}
	}
	f.ctxErr[cmd] = ctx.Err()
	return "ok", f.fail[cmd]
}

var t0 = time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)

// newWorld crea <root>/survival/data con un mundo mínimo y devuelve data y backups.
func newWorld(t *testing.T) (dataDir, backupsDir string) {
	t.Helper()
	root := t.TempDir()
	dataDir = filepath.Join(root, "survival", "data")
	backupsDir = filepath.Join(root, "survival", "backups")
	mustWrite(t, filepath.Join(dataDir, "server.properties"), "motd=hola\n", 0o644)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-1", 0o644)
	mustWrite(t, filepath.Join(dataDir, "logs", "latest.log"), "ruido", 0o644)
	return dataDir, backupsDir
}

func baseReq(dataDir, backupsDir string) CreateRequest {
	return CreateRequest{
		ServerID: "srv-1", Slug: "survival", SpecVersion: 3, Trigger: TriggerManual,
		DataDir: dataDir, BackupsDir: backupsDir, Excludes: []string{"logs"},
		Now:   func() time.Time { return t0 },
		Sleep: func(context.Context, time.Duration) error { return nil },
	}
}

// assertNoArchives comprueba que no quedan copias ni parciales.
func assertNoArchives(t *testing.T, backupsDir string) {
	t.Helper()
	ents, _ := os.ReadDir(backupsDir)
	if len(ents) != 0 {
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Fatalf("quedan ficheros: %v", names)
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
		t.Fatalf("comandos RCON = %s", got)
	}
	if slept != FlushWait {
		t.Fatalf("espera tras flush = %v", slept)
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
		t.Fatal("sha256 o tamaño no coinciden con el fichero")
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
		t.Fatal("contenido de la copia incorrecto")
	}
	if ents, _ := os.ReadDir(backupsDir); len(ents) != 2 {
		t.Fatalf("deben quedar el .tar.zst y su .json: %d", len(ents))
	}
	if !strings.Contains(strings.Join(logs, "\n"), "save-on") {
		t.Fatalf("el log del job debe registrar el save-on: %v", logs)
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
		t.Fatalf("comandos = %v", rc.cmds)
	}
	if rc.ctxErr["save-on"] != nil {
		t.Fatal("save-on debe ir con un contexto vivo aunque el job se cancele")
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateSaveOffFailureStillSendsSaveOn(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-off": errors.New("rcon: conectar: timeout")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "save-off") {
		t.Fatalf("err = %v", err)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-on" {
		t.Fatalf("comandos = %s", got)
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
		if pct > 2 { // tras el primer fichero
			cancel()
		}
	}
	if _, err := Create(ctx, req); err == nil {
		t.Fatal("debe fallar")
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("comandos = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateSaveOnFailureKeepsTheBackup(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-on": errors.New("rcon: conectar: connection refused")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	meta, err := Create(context.Background(), req)
	if !errors.Is(err, ErrResume) {
		t.Fatalf("err = %v", err)
	}
	if meta.Filename == "" || !exists(filepath.Join(backupsDir, meta.Filename)) {
		t.Fatal("la copia escrita se conserva aunque save-on falle")
	}
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
	if _, err := Create(context.Background(), req); err == nil || !strings.Contains(err.Error(), "aún no tiene datos") {
		t.Fatalf("err = %v", err)
	}
	req = baseReq(filepath.Join(root, "x"), filepath.Join(root, "y"))
	req.Slug = "../etc"
	if _, err := Create(context.Background(), req); err == nil {
		t.Fatal("slug inválido debe rechazarse")
	}
}

// Si la copia falla Y además save-on falla, el error debe decir las dos cosas: el mundo
// se ha quedado sin autoguardado y alguien tiene que saberlo.
func TestCreateCopyAndSaveOnFailureReportsBoth(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	rc := &fakeRcon{fail: map[string]error{"save-on": errors.New("rcon: conectar: connection refused")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	req.Sleep = func(ctx context.Context, _ time.Duration) error { cancel(); return ctx.Err() }
	meta, err := Create(ctx, req)
	if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrResume) {
		t.Fatalf("err = %v; debe envolver la cancelación y ErrResume", err)
	}
	if meta.Filename != "" {
		t.Fatalf("sin copia no hay metadatos: %+v", meta)
	}
	assertNoArchives(t, backupsDir)
}

// save-on va con un contexto propio y acotado (resumeTimeout), no con el del job;
// save-off y save-all flush van con el del llamante, cuyo plazo manda (un flush en un
// mundo grande tarda más de 5 s).
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
			t.Errorf("%s sin plazo", cmd)
		}
		if c.Err() != nil {
			t.Errorf("%s con el contexto ya terminado", cmd)
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
			t.Errorf("%s: plazo %v; debe ser el del llamante", cmd, deadlines[cmd])
		}
	}
	on := deadlines["save-on"]
	if on.Before(start.Add(resumeTimeout)) || on.After(end.Add(resumeTimeout)) {
		t.Errorf("save-on: plazo %v; debe ser propio de %v", on, resumeTimeout)
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
		t.Fatalf("avance = %v; esperado 1 (save-off), 2–97 (copia), 99 (escrita)", pcts)
	}
	for i := 1; i < len(pcts); i++ {
		if pcts[i] < pcts[i-1] {
			t.Fatalf("el avance no debe retroceder: %v", pcts)
		}
	}
	const want = int64(len("motd=hola\n") + len("LEVEL-1")) // logs excluido
	if meta.DataBytes != want {
		t.Fatalf("DataBytes = %d, want %d", meta.DataBytes, want)
	}
	if onDisk, err := ReadMeta(backupsDir, meta.Filename); err != nil || onDisk.DataBytes != want {
		t.Fatalf(".json = %+v, %v", onDisk, err)
	}
}
