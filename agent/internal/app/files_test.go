package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/store"
)

var xferID = strings.Repeat("T", 43)

// filesApp prepara un agente con el servidor "a" (slug alpha) y su carpeta de datos.
func filesApp(t *testing.T) (*App, string) {
	t.Helper()
	a, _, st := newApp(t)
	if err := st.PutSpec(specMsg("a", "alpha", 1)); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(a.cfg.DataRoot, "alpha", "data")
	if err := os.MkdirAll(filepath.Join(root, "mods"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "server.properties"), []byte("motd=hola\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCredentials(store.Credentials{NodeID: "n1", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	return a, root
}

// panelFor arranca un panel falso para /agent/transfer/{id} y apunta el agente a él.
func panelFor(t *testing.T, a *App, h http.HandlerFunc) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/agent/transfer/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.PathValue("id") != xferID {
			http.NotFound(w, r)
			return
		}
		h(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	a.cfg.PanelURL = srv.URL
}

func call(t *testing.T, a *App, env *mcsmv1.Envelope) *mcsmv1.Envelope {
	t.Helper()
	return callCtx(t, a, context.Background(), env)
}

// callCtx entrega env con ctx como contexto de la sesión WS y espera su respuesta.
func callCtx(t *testing.T, a *App, ctx context.Context, env *mcsmv1.Envelope) *mcsmv1.Envelope {
	t.Helper()
	s := newSink()
	a.Handle(ctx, env, s.send)
	return s.waitID(t, env.Id)
}

func errCode(e *mcsmv1.Envelope) string { return e.GetError().GetCode() }

func TestFilesListReadWrite(t *testing.T) {
	a, root := filesApp(t)
	e := call(t, a, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}})
	list := e.GetFilesListResult()
	if list == nil || len(list.Entries) != 2 || list.Entries[0].Name != "mods" || !list.Entries[0].Dir || list.Entries[1].Name != "server.properties" || list.Entries[1].Size != 10 {
		t.Fatalf("list = %+v", e)
	}
	e = call(t, a, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_FilesRead{FilesRead: &mcsmv1.FilesRead{ServerId: "a", Path: "server.properties"}}})
	if string(e.GetFilesReadResult().GetContent()) != "motd=hola\n" || e.GetFilesReadResult().GetSize() != 10 {
		t.Fatalf("read = %+v", e)
	}
	e = call(t, a, &mcsmv1.Envelope{Id: 4, Body: &mcsmv1.Envelope_FilesWrite{FilesWrite: &mcsmv1.FilesWrite{ServerId: "a", Path: "server.properties", Content: []byte("motd=adiós\n")}}})
	if e.GetAck() == nil {
		t.Fatalf("write = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=adiós\n" {
		t.Fatalf("fichero = %q", b)
	}
	e = call(t, a, &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_FilesMkdir{FilesMkdir: &mcsmv1.FilesMkdir{ServerId: "a", Path: "plugins"}}})
	if e.GetAck() == nil {
		t.Fatalf("mkdir = %+v", e)
	}
	e = call(t, a, &mcsmv1.Envelope{Id: 6, Body: &mcsmv1.Envelope_FilesRename{FilesRename: &mcsmv1.FilesRename{ServerId: "a", From: "plugins", To: "plugins-old"}}})
	if e.GetAck() == nil {
		t.Fatalf("rename = %+v", e)
	}
	e = call(t, a, &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_FilesStat{FilesStat: &mcsmv1.FilesStat{ServerId: "a", Path: "plugins-old"}}})
	if !e.GetFilesStatResult().GetEntry().GetDir() {
		t.Fatalf("stat = %+v", e)
	}
	e = call(t, a, &mcsmv1.Envelope{Id: 8, Body: &mcsmv1.Envelope_FilesDelete{FilesDelete: &mcsmv1.FilesDelete{ServerId: "a", Path: "plugins-old"}}})
	if e.GetAck() == nil {
		t.Fatalf("delete = %+v", e)
	}
}

func TestFilesErrors(t *testing.T) {
	a, _ := filesApp(t)
	cases := []struct {
		env  *mcsmv1.Envelope
		code string
	}{
		{&mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_FilesRead{FilesRead: &mcsmv1.FilesRead{ServerId: "a", Path: "../../etc/passwd"}}}, "invalid_path"},
		{&mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "otro", Path: "/"}}}, "unknown_server"},
		{&mcsmv1.Envelope{Id: 4, Body: &mcsmv1.Envelope_FilesRead{FilesRead: &mcsmv1.FilesRead{ServerId: "a", Path: "no-existe"}}}, "not_found"},
		{&mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_FilesDelete{FilesDelete: &mcsmv1.FilesDelete{ServerId: "a", Path: "/"}}}, "root"},
		{&mcsmv1.Envelope{Id: 6, Body: &mcsmv1.Envelope_FilesMkdir{FilesMkdir: &mcsmv1.FilesMkdir{ServerId: "a", Path: "mods"}}}, "exists"},
	}
	for _, c := range cases {
		if got := errCode(call(t, a, c.env)); got != c.code {
			t.Errorf("id %d: code = %q; quiero %q", c.env.Id, got, c.code)
		}
	}
}

func TestFilesUploadStreamsFromPanel(t *testing.T) {
	a, root := filesApp(t)
	const size = 50 << 20
	want := sha256.New()
	_, _ = io.Copy(want, io.LimitReader(&pattern{}, size))
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(size))
		_, _ = io.Copy(w, io.LimitReader(&pattern{}, size))
	})
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	e := call(t, a, &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "/mods/grande.jar", TransferId: xferID, Size: size}}})
	runtime.ReadMemStats(&after)
	if e.GetAck() == nil {
		t.Fatalf("upload = %+v", e)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 16<<20 {
		t.Fatalf("%d bytes reservados para 50 MiB: la subida no va en streaming", alloc)
	}
	f, _ := os.Open(filepath.Join(root, "mods", "grande.jar"))
	defer f.Close()
	got := sha256.New()
	n, _ := io.Copy(got, f)
	if n != size || !bytes.Equal(want.Sum(nil), got.Sum(nil)) {
		t.Fatalf("fichero de %d bytes con otro contenido", n)
	}
}

func TestFilesUploadTruncatedDoesNotReplace(t *testing.T) {
	a, root := filesApp(t)
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write(bytes.Repeat([]byte("x"), 10)) // corta a los 10 bytes
	})
	e := call(t, a, &mcsmv1.Envelope{Id: 10, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}})
	if errCode(e) != "transfer_failed" {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("el original cambió: %q", b)
	}
}

func TestFilesUploadInvalidTargetDoesNotConsumeTransfer(t *testing.T) {
	a, _ := filesApp(t)
	var hit atomic.Bool
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) { hit.Store(true) })
	e := call(t, a, &mcsmv1.Envelope{Id: 11, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "no-existe/x.jar", TransferId: xferID, Size: -1}}})
	if errCode(e) != "not_found" || hit.Load() {
		t.Fatalf("resp = %+v, transferencia consumida = %v", e, hit.Load())
	}
}

func TestFilesDownloadPutsToPanel(t *testing.T) {
	a, _ := filesApp(t)
	var got []byte
	var gotLen int64
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.NotFound(w, r)
			return
		}
		got, _ = io.ReadAll(r.Body)
		gotLen = r.ContentLength
		w.WriteHeader(http.StatusNoContent)
	})
	e := call(t, a, &mcsmv1.Envelope{Id: 12, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}})
	if e.GetAck() == nil || string(got) != "motd=hola\n" || gotLen != 10 {
		t.Fatalf("resp=%+v got=%q len=%d", e, got, gotLen)
	}
	e = call(t, a, &mcsmv1.Envelope{Id: 13, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "mods", TransferId: xferID}}})
	if errCode(e) != "is_dir" {
		t.Fatalf("descargar carpeta = %+v", e)
	}
}

// El panel anuncia un tamaño en FilesUpload y su GET trae otro: no se escribe nada.
func TestFilesUploadSizeMismatchDoesNotReplace(t *testing.T) {
	a, root := filesApp(t)
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "5")
		_, _ = w.Write([]byte("nuevo"))
	})
	e := call(t, a, &mcsmv1.Envelope{Id: 14, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 10}}})
	if errCode(e) != "transfer_failed" {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("el original cambió: %q", b)
	}
}

// Un corte del WebSocket no aborta las operaciones de disco ni las transferencias: usan el
// contexto de vida del agente. La respuesta sigue saliendo por el send de la sesión.
func TestFilesSurviveSessionCancel(t *testing.T) {
	a, root := filesApp(t)
	var put atomic.Value
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Length", "5")
			_, _ = w.Write([]byte("nuevo"))
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			put.Store(string(b))
			w.WriteHeader(http.StatusNoContent)
		}
	})
	session, cancel := context.WithCancel(context.Background())
	cancel() // la sesión ya se cortó cuando el handler llega al disco o al panel

	e := callCtx(t, a, session, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/n.jar", TransferId: xferID, Size: 5}}})
	if e.GetAck() == nil {
		t.Fatalf("upload con la sesión cortada = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "mods", "n.jar")); string(b) != "nuevo" {
		t.Fatalf("subido = %q", b)
	}
	e = callCtx(t, a, session, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}})
	if e.GetAck() == nil || put.Load() != "motd=hola\n" {
		t.Fatalf("download con la sesión cortada = %+v, panel recibió %v", e, put.Load())
	}
	e = callCtx(t, a, session, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_FilesWrite{FilesWrite: &mcsmv1.FilesWrite{ServerId: "a", Path: "server.properties", Content: []byte("x=1\n")}}})
	if e.GetAck() == nil {
		t.Fatalf("write con la sesión cortada = %+v", e)
	}
}

// tmpFiles devuelve los temporales de escritura atómica que quedan en dir.
func tmpFiles(t *testing.T, dir string) []os.DirEntry {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []os.DirEntry
	for _, de := range des {
		if strings.HasPrefix(de.Name(), ".mcsm-tmp-") {
			out = append(out, de)
		}
	}
	return out
}

// Si el agente se para a mitad de una subida, la transferencia se corta, el temporal se
// borra y el fichero original queda intacto.
func TestFilesUploadAbortedByAgentShutdown(t *testing.T) {
	a, root := filesApp(t)
	life, stop := context.WithCancel(context.Background())
	defer stop()
	a.life = life
	release := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write(bytes.Repeat([]byte("x"), 100))
		w.(http.Flusher).Flush()
		select { // el resto no llega nunca
		case <-r.Context().Done():
		case <-release:
		}
	})
	t.Cleanup(func() { close(release) }) // antes que srv.Close (orden inverso)
	s := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 15, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}}, s.send)

	// Espera con condición: el temporal existe y ya tiene los 100 bytes recibidos.
	deadline := time.After(3 * time.Second)
	for written := false; !written; {
		for _, de := range tmpFiles(t, root) {
			if info, err := de.Info(); err == nil && info.Size() == 100 {
				written = true
			}
		}
		if written {
			break
		}
		select {
		case <-deadline:
			t.Fatal("la subida no empezó a escribir")
		case <-time.After(time.Millisecond):
		}
	}
	stop()
	e := s.waitID(t, 15)
	if errCode(e) != "transfer_failed" {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("el original cambió: %q", b)
	}
	if left := tmpFiles(t, root); len(left) != 0 {
		t.Fatalf("quedan temporales: %v", left)
	}
}

// Un nombre de fichero que no es UTF-8 no rompe el listado: proto3 rechaza string con UTF-8
// inválido y la respuesta entera se perdería.
func TestFilesListNonUTF8NameStillMarshals(t *testing.T) {
	a, root := filesApp(t)
	if err := os.WriteFile(filepath.Join(root, "caf\xe9.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := call(t, a, &mcsmv1.Envelope{Id: 16, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}})
	if _, err := proto.Marshal(e); err != nil {
		t.Fatalf("respuesta no serializable: %v", err)
	}
	found := false
	for _, en := range e.GetFilesListResult().GetEntries() {
		found = found || en.Name == "caf�.txt"
	}
	if !found {
		t.Fatalf("list = %+v", e)
	}
}

// patternBlock es un ciclo de 251 bytes repetido; pattern lo copia sin reservar memoria.
var patternBlock = func() []byte {
	b := make([]byte, 64<<10+251)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}()

// pattern genera bytes deterministas (hasta 64 KiB por lectura) sin reservar memoria.
type pattern struct{ off int }

func (p *pattern) Read(b []byte) (int, error) {
	n := copy(b, patternBlock[p.off%251:])
	p.off += n
	return n, nil
}
