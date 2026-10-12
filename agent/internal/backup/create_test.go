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
	reply  map[string]string // respuesta del servidor; "ok" si no hay
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
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	meta, err := Create(ctx, req)
	if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrResume) {
		t.Fatalf("err = %v; debe envolver la cancelación y ErrResume", err)
	}
	if strings.Contains(err.Error(), "\n") {
		t.Fatalf("el error llega al job y a la UI: una sola línea: %q", err)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "puede seguir desactivado") {
		t.Fatalf("el log debe avisar de que el autoguardado puede seguir desactivado: %v", logs)
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

func TestCreateFlushFailureStillSendsSaveOn(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-all flush": errors.New("rcon: ejecutar: i/o timeout")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "save-all flush") {
		t.Fatalf("err = %v", err)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("comandos = %s", got)
	}
	assertNoArchives(t, backupsDir)
}

// Spec §6.5: tar; save-on; sha256; .json. El mundo no debe seguir sin autoguardado durante
// el fsync de un fichero de varios GiB, el renombrado y los metadatos.
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
		t.Fatalf("save-on una sola vez: %s", got)
	}
	if !partialAtSaveOn || finalAtSaveOn {
		t.Fatalf("save-on debe salir al cerrar el tar, antes de renombrar (parcial=%v final=%v)", partialAtSaveOn, finalAtSaveOn)
	}
}

func TestCreateLogsRconReplies(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{reply: map[string]string{
		"save-off":       "Automatic saving is now disabled",
		"save-all flush": "Unable to save the game\n(no hay espacio)",
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
	for _, want := range []string{"Automatic saving is now disabled", "ATENCIÓN", "Unable to save the game (no hay espacio)", "Automatic saving is now enabled"} {
		if !strings.Contains(all, want) {
			t.Errorf("falta %q en el log: %v", want, logs)
		}
	}
	if strings.Count(all, "ATENCIÓN") != 1 {
		t.Errorf("solo la respuesta de fallo lleva ATENCIÓN: %v", logs)
	}
}

func TestCreateRenameFailureRemovesPartialAndMeta(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	stubRename(t, func(oldpath, newpath string) error {
		if strings.HasSuffix(newpath, Ext) {
			return errors.New("fallo simulado")
		}
		return os.Rename(oldpath, newpath)
	})
	if _, err := Create(context.Background(), req); err == nil || !strings.Contains(err.Error(), "fallo simulado") {
		t.Fatalf("err = %v", err)
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("comandos = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// El inventario (List) nunca debe ver la copia sin su .json: se escribe antes del nombre final.
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
		t.Fatal("el .json debe existir (con su sha256) antes de que la copia tenga su nombre final")
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
	if _, err := Create(context.Background(), req); err == nil || !strings.Contains(err.Error(), "no es un directorio") {
		t.Fatalf("err = %v", err)
	}
	if len(rc.cmds) != 0 {
		t.Fatalf("sin nada que copiar no se toca el autoguardado: %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateUnreadableDataIsNotMissing(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root no recibe EACCES")
	}
	dataDir, backupsDir := newWorld(t)
	parent := filepath.Dir(dataDir)
	if err := os.Chmod(parent, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o755) })
	backupsDir = filepath.Join(t.TempDir(), "backups")
	_, err := Create(context.Background(), baseReq(dataDir, backupsDir))
	if err == nil || strings.Contains(err.Error(), "aún no tiene datos") || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("un EACCES se informa como tal: %v", err)
	}
}
