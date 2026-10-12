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
	"sync"
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

// chunked envía data sin Content-Length (Transfer-Encoding: chunked).
func chunked(data []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		half := len(data) / 2
		_, _ = w.Write(data[:half])
		w.(http.Flusher).Flush() // ya sin Content-Length
		_, _ = w.Write(data[half:])
	}
}

// Sin tamaño conocido (FilesUpload.size = -1 y respuesta chunked) la subida tiene un tope
// duro: un origen sin fin no llena el disco del nodo.
func TestFilesUploadUnknownSizeIsCapped(t *testing.T) {
	a, root := filesApp(t)
	a.cfg.UploadMax = 1000
	panelFor(t, a, chunked(bytes.Repeat([]byte("x"), 2000)))
	e := call(t, a, &mcsmv1.Envelope{Id: 17, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/sin-fin.jar", TransferId: xferID, Size: -1}}})
	if errCode(e) != "too_large" {
		t.Fatalf("resp = %+v", e)
	}
	if _, err := os.Stat(filepath.Join(root, "mods", "sin-fin.jar")); !os.IsNotExist(err) {
		t.Fatalf("no debe quedar el fichero: %v", err)
	}
	if left := tmpFiles(t, filepath.Join(root, "mods")); len(left) != 0 {
		t.Fatalf("quedan temporales: %v", left)
	}
}

// Una subida chunked dentro del tope se escribe entera.
func TestFilesUploadUnknownSizeWithinCap(t *testing.T) {
	a, root := filesApp(t)
	a.cfg.UploadMax = 1000
	panelFor(t, a, chunked(bytes.Repeat([]byte("y"), 1000)))
	e := call(t, a, &mcsmv1.Envelope{Id: 18, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/ok.jar", TransferId: xferID, Size: -1}}})
	if e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "mods", "ok.jar")); len(b) != 1000 {
		t.Fatalf("escritos %d bytes", len(b))
	}
}

// Un tamaño anunciado por encima del tope se rechaza sin consumir la transferencia.
func TestFilesUploadKnownSizeOverCapDoesNotConsumeTransfer(t *testing.T) {
	a, _ := filesApp(t)
	a.cfg.UploadMax = 1000
	var hit atomic.Bool
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) { hit.Store(true) })
	e := call(t, a, &mcsmv1.Envelope{Id: 19, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/x.jar", TransferId: xferID, Size: 1001}}})
	if errCode(e) != "too_large" || hit.Load() {
		t.Fatalf("resp = %+v, transferencia consumida = %v", e, hit.Load())
	}
}

func TestLoadConfigUploadMax(t *testing.T) {
	t.Setenv("PANEL_URL", "http://p")
	t.Setenv("UPLOAD_MAX_BYTES", "")
	cfg, err := LoadConfig("x")
	if err != nil || cfg.UploadMax != 4<<30 {
		t.Fatalf("por defecto: cfg.UploadMax=%d err=%v", cfg.UploadMax, err)
	}
	t.Setenv("UPLOAD_MAX_BYTES", "1048576")
	if cfg, err = LoadConfig("x"); err != nil || cfg.UploadMax != 1<<20 {
		t.Fatalf("cfg.UploadMax=%d err=%v", cfg.UploadMax, err)
	}
	for _, bad := range []string{"0", "-5", "4G", "abc"} {
		t.Setenv("UPLOAD_MAX_BYTES", bad)
		if _, err := LoadConfig("x"); err == nil {
			t.Fatalf("UPLOAD_MAX_BYTES=%q debe fallar", bad)
		}
	}
}

// El nodo atiende como mucho maxTransfers transferencias a la vez; la siguiente recibe busy
// al instante y sin consumir su transferencia. Al terminar una, hay sitio otra vez.
func TestFilesTransfersAreLimited(t *testing.T) {
	a, root := filesApp(t)
	hits := make(chan string, 2*maxTransfers)
	release := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		hits <- r.Method
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		if r.Method == http.MethodPut {
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Length", "1")
		_, _ = w.Write([]byte("z"))
	})
	var once sync.Once
	open := func() { once.Do(func() { close(release) }) }
	t.Cleanup(open) // antes que srv.Close (orden inverso)
	s := newSink()
	for i := 1; i <= maxTransfers; i++ {
		go a.Handle(context.Background(), &mcsmv1.Envelope{Id: uint64(i), Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/" + strconv.Itoa(i) + ".jar", TransferId: xferID, Size: 1}}}, s.send)
	}
	for i := 0; i < maxTransfers; i++ {
		select {
		case <-hits:
		case <-time.After(3 * time.Second):
			t.Fatalf("solo %d transferencias en curso", i)
		}
	}
	// Las 4 tienen hueco y están en el panel: una subida y una descarga más no caben. Van en
	// goroutines para que, si el límite fallara, el test falle a los 3 s y no al plazo HTTP.
	extra := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 10, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/extra.jar", TransferId: xferID, Size: 1}}}, extra.send)
	if e := extra.waitID(t, 10); errCode(e) != "busy" {
		t.Fatalf("subida de más = %+v", e)
	}
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 11, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}}, extra.send)
	if e := extra.waitID(t, 11); errCode(e) != "busy" {
		t.Fatalf("descarga de más = %+v", e)
	}
	if len(hits) != 0 {
		t.Fatal("las rechazadas no deben consumir su transferencia")
	}
	// Las operaciones inline no cuentan.
	if e := call(t, a, &mcsmv1.Envelope{Id: 12, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}}); e.GetFilesListResult() == nil {
		t.Fatalf("list = %+v", e)
	}
	open()
	for i := 0; i < maxTransfers; i++ {
		if e := s.next(t); e.GetAck() == nil {
			t.Fatalf("resp = %+v", e)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "mods", "1.jar")); string(b) != "z" {
		t.Fatalf("subido = %q", b)
	}
	if e := call(t, a, &mcsmv1.Envelope{Id: 13, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}}); e.GetAck() == nil {
		t.Fatalf("tras liberar = %+v", e)
	}
}

// fakeIdle sustituye el reloj del vigilante de inactividad: cada periodo es un canal que el
// test dispara a mano.
func fakeIdle(a *App) chan chan time.Time {
	timers := make(chan chan time.Time, 16)
	a.xfer.after = func(time.Duration) <-chan time.Time {
		ch := make(chan time.Time, 1)
		timers <- ch
		return ch
	}
	return timers
}

func nextTimer(t *testing.T, timers chan chan time.Time) chan time.Time {
	t.Helper()
	select {
	case ch := <-timers:
		return ch
	case <-time.After(3 * time.Second):
		t.Fatal("el vigilante de inactividad no arrancó")
		return nil
	}
}

// Una subida que deja de recibir bytes durante un periodo entero se corta; un periodo con
// progreso no la corta.
func TestFilesUploadIdleIsCut(t *testing.T) {
	a, root := filesApp(t)
	timers := fakeIdle(a)
	release := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write(bytes.Repeat([]byte("x"), 100))
		w.(http.Flusher).Flush()
		select { // el panel se cuelga sin cerrar la conexión
		case <-r.Context().Done():
		case <-release:
		}
	})
	t.Cleanup(func() { close(release) })
	s := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 20, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}}, s.send)
	first := nextTimer(t, timers)
	deadline := time.After(3 * time.Second)
	for len(tmpFiles(t, root)) == 0 || func() bool { info, err := tmpFiles(t, root)[0].Info(); return err != nil || info.Size() != 100 }() {
		select {
		case <-deadline:
			t.Fatal("la subida no empezó a escribir")
		case <-time.After(time.Millisecond):
		}
	}
	first <- time.Time{}                // hubo progreso en este periodo: sigue
	nextTimer(t, timers) <- time.Time{} // periodo entero sin bytes: se corta
	e := s.waitID(t, 20)
	if errCode(e) != "transfer_failed" || !strings.Contains(e.GetError().GetMessage(), "sin moverse") {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("el original cambió: %q", b)
	}
	if left := tmpFiles(t, root); len(left) != 0 {
		t.Fatalf("quedan temporales: %v", left)
	}
}

// Una descarga cuyo panel deja de leer (o no responde) se corta igual.
func TestFilesDownloadIdleIsCut(t *testing.T) {
	a, _ := filesApp(t)
	timers := fakeIdle(a)
	read := make(chan struct{})
	release := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadFull(r.Body, make([]byte, 1))
		close(read)
		select { // nunca responde
		case <-r.Context().Done():
		case <-release:
		}
	})
	t.Cleanup(func() { close(release) })
	s := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 21, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}}, s.send)
	first := nextTimer(t, timers)
	select {
	case <-read:
	case <-time.After(3 * time.Second):
		t.Fatal("el panel no recibió nada")
	}
	first <- time.Time{}
	nextTimer(t, timers) <- time.Time{}
	if e := s.waitID(t, 21); errCode(e) != "transfer_failed" || !strings.Contains(e.GetError().GetMessage(), "sin moverse") {
		t.Fatalf("resp = %+v", e)
	}
}

// El Error que llega al panel (y al navegador) no lleva la URL, el transfer_id ni la IP.
func TestFilesTransferErrorHidesURL(t *testing.T) {
	a, _ := filesApp(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.Listener.Addr().String()
	srv.Close() // nadie escucha
	a.cfg.PanelURL = "http://" + addr
	e := call(t, a, &mcsmv1.Envelope{Id: 22, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}})
	msg := e.GetError().GetMessage()
	if errCode(e) != "transfer_failed" || strings.Contains(msg, xferID) || strings.Contains(msg, addr) || strings.Contains(msg, "127.0.0.1") {
		t.Fatalf("resp = %+v", e)
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
