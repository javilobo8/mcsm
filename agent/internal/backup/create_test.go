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
		// Solo cuenta en caliente (con Rcon): el contenedor sigue siendo el mismo y en marcha.
		Running: func(context.Context) error { return nil },
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

// save-on falla con el servidor en marcha: el job falla, así que la copia no se confirma
// (spec §10: un backup fallido borra su parcial); el error pide ejecutar save-on.
func TestCreateSaveOnFailureDiscardsTheBackup(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-on": errors.New("rcon: conectar: connection refused")}}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	meta, err := Create(context.Background(), req)
	if !errors.Is(err, ErrResume) || !strings.Contains(err.Error(), "descartado") {
		t.Fatalf("err = %v", err)
	}
	if strings.Count(err.Error(), "save-on") != 2 { // «(save-on); ejecuta save-on»: una sola vez el motivo
		t.Fatalf("el fallo de save-on se cuenta una vez: %q", err)
	}
	if meta.Filename != "" {
		t.Fatalf("una copia fallida no devuelve metadatos: %+v", meta)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "ATENCIÓN: save-on falló") {
		t.Fatalf("el log debe avisar del save-on: %v", logs)
	}
	assertNoArchives(t, backupsDir)
}

// stopped es lo que devuelve la comprobación del contenedor si se paró durante la copia.
var stopped = fmt.Errorf("%w (su contenedor ya no está en marcha)", ErrServerStopped)

// runningSeq devuelve una comprobación que responde con results en orden (y luego el último).
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

// assertStoppedErr: el mensaje dice que el servidor se paró y que la copia se descartó, y no
// menciona save-on (un servidor parado vuelve a arrancar con el guardado activado).
func assertStoppedErr(t *testing.T, err error, logs []string) {
	t.Helper()
	if !errors.Is(err, ErrServerStopped) || errors.Is(err, ErrResume) {
		t.Fatalf("err = %v; esperaba ErrServerStopped sin ErrResume", err)
	}
	msg := err.Error()
	if !strings.Contains(msg, "se paró") || !strings.Contains(msg, "descartado") || strings.Contains(msg, "save-on") {
		t.Fatalf("mensaje = %q", msg)
	}
	if strings.Contains(strings.Join(logs, "\n"), "ATENCIÓN") {
		t.Fatalf("sin avisos falsos de save-on en el log: %v", logs)
	}
}

// El contenedor se para durante el tar (mc-router por inactividad, docker stop, un fallo):
// Minecraft guarda al parar aunque haya save-off, así que la copia no vale. Se descarta sin
// .json ni nombre final, y save-on no se envía (no hay servidor al que enviarlo).
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
		t.Fatalf("comandos = %s; sin save-on a un servidor parado", got)
	}
	assertNoArchives(t, backupsDir)
}

// La comprobación al cerrar el tar pasa, pero el contenedor ya no está antes del .json (la
// parada empezó durante el tar y Minecraft seguía guardando): se descarta igual.
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
		t.Fatalf("orden = %s; esperado: comprobar al cerrar el tar, save-on, comprobar antes de confirmar", got)
	}
	assertNoArchives(t, backupsDir)
}

// save-on falla porque el servidor se acaba de parar: el motivo es la parada, no save-on.
func TestCreateSaveOnFailsBecauseServerStopped(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{fail: map[string]error{"save-on": errors.New("rcon: conectar: lookup mcsm-survival: server misbehaving")}}
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

// Si Docker no deja comprobar el contenedor, la copia no se da por buena; save-on sale igual.
func TestCreateCannotCheckContainerDiscards(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	var calls []string
	req.Running = runningSeq(&calls, errors.New("docker: i/o timeout"))
	_, err := Create(context.Background(), req)
	if err == nil || errors.Is(err, ErrServerStopped) || !strings.Contains(err.Error(), "no se pudo comprobar") ||
		!strings.Contains(err.Error(), "docker: i/o timeout") || !strings.Contains(err.Error(), "descartado") {
		t.Fatalf("err = %v", err)
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("comandos = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// Una copia en caliente sin comprobación del contenedor es un error de programación.
func TestCreateHotCopyRequiresRunningCheck(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	req.Running = nil
	if _, err := Create(context.Background(), req); err == nil {
		t.Fatal("debe fallar")
	}
	if len(rc.cmds) != 0 {
		t.Fatalf("sin tocar el servidor: %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// growWhileCopying añade a dataDir una región grande e incompresible y hace que crezca
// mientras el tar la lee (en la primera escritura de la copia, que vigila el espacio libre).
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
		if calls == 2 { // 1: antes de save-off; 2: primera escritura de la copia
			f, err := os.OpenFile(big, os.O_WRONLY|os.O_APPEND, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if _, err := f.WriteString("chunk guardado al parar"); err != nil {
				t.Fatal(err)
			}
		}
		return 1 << 50, nil
	}
}

// El caso de la E2E: el servidor se para durante el tar y Minecraft reescribe una región
// mientras se lee. El mensaje cuenta la parada (la causa) y el log, el fichero.
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
		t.Fatalf("el log debe nombrar el fichero que cambió: %v", logs)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush" {
		t.Fatalf("comandos = %s", got)
	}
	assertNoArchives(t, backupsDir)
}

// Un fichero cambia durante la copia con el servidor en marcha: la copia se descarta con el
// nombre del fichero y save-on sale igual.
func TestCreateFileChangedWhileRunningDiscards(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	growWhileCopying(t, &req)
	_, err := Create(context.Background(), req)
	if !errors.Is(err, ErrSourceChanged) || !strings.Contains(err.Error(), "world/region/r.0.0.mca") || !strings.Contains(err.Error(), "descartado") {
		t.Fatalf("err = %v", err)
	}
	if rc.cmds[len(rc.cmds)-1] != "save-on" {
		t.Fatalf("comandos = %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)
}

// En frío nadie escribe (servidor parado y reservado); si algo cambia igualmente, tampoco vale.
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
