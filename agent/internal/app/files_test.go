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

// filesApp prepares an agent with server "a" (slug alpha) and its data folder.
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

// panelFor starts a fake panel for /agent/transfer/{id} and points the agent at it.
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

// callCtx delivers env with ctx as the WS session's context and waits for its response.
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
		t.Fatalf("file = %q", b)
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
		{&mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "other", Path: "/"}}}, "unknown_server"},
		{&mcsmv1.Envelope{Id: 4, Body: &mcsmv1.Envelope_FilesRead{FilesRead: &mcsmv1.FilesRead{ServerId: "a", Path: "nonexistent"}}}, "not_found"},
		{&mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_FilesDelete{FilesDelete: &mcsmv1.FilesDelete{ServerId: "a", Path: "/"}}}, "root"},
		{&mcsmv1.Envelope{Id: 6, Body: &mcsmv1.Envelope_FilesMkdir{FilesMkdir: &mcsmv1.FilesMkdir{ServerId: "a", Path: "mods"}}}, "exists"},
	}
	for _, c := range cases {
		if got := errCode(call(t, a, c.env)); got != c.code {
			t.Errorf("id %d: code = %q; want %q", c.env.Id, got, c.code)
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
	e := call(t, a, &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "/mods/big.jar", TransferId: xferID, Size: size}}})
	runtime.ReadMemStats(&after)
	if e.GetAck() == nil {
		t.Fatalf("upload = %+v", e)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 16<<20 {
		t.Fatalf("%d bytes reserved for 50 MiB: the upload is not streaming", alloc)
	}
	f, _ := os.Open(filepath.Join(root, "mods", "big.jar"))
	defer f.Close()
	got := sha256.New()
	n, _ := io.Copy(got, f)
	if n != size || !bytes.Equal(want.Sum(nil), got.Sum(nil)) {
		t.Fatalf("file of %d bytes with other content", n)
	}
}

func TestFilesUploadTruncatedDoesNotReplace(t *testing.T) {
	a, root := filesApp(t)
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write(bytes.Repeat([]byte("x"), 10)) // cuts off at 10 bytes
	})
	e := call(t, a, &mcsmv1.Envelope{Id: 10, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}})
	if errCode(e) != "transfer_failed" {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("the original changed: %q", b)
	}
}

func TestFilesUploadInvalidTargetDoesNotConsumeTransfer(t *testing.T) {
	a, _ := filesApp(t)
	var hit atomic.Bool
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) { hit.Store(true) })
	e := call(t, a, &mcsmv1.Envelope{Id: 11, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "nonexistent/x.jar", TransferId: xferID, Size: -1}}})
	if errCode(e) != "not_found" || hit.Load() {
		t.Fatalf("resp = %+v, transfer consumed = %v", e, hit.Load())
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
		t.Fatalf("download folder = %+v", e)
	}
}

// The panel announces one size in FilesUpload and its GET brings another: nothing is written.
func TestFilesUploadSizeMismatchDoesNotReplace(t *testing.T) {
	a, root := filesApp(t)
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "5")
		_, _ = w.Write([]byte("fresh"))
	})
	e := call(t, a, &mcsmv1.Envelope{Id: 14, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 10}}})
	if errCode(e) != "transfer_failed" {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("the original changed: %q", b)
	}
}

// A WebSocket drop does not abort disk operations or transfers: they use the
// agent's life context. The response still goes out through the session's send.
func TestFilesSurviveSessionCancel(t *testing.T) {
	a, root := filesApp(t)
	var put atomic.Value
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Length", "5")
			_, _ = w.Write([]byte("fresh"))
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			put.Store(string(b))
			w.WriteHeader(http.StatusNoContent)
		}
	})
	session, cancel := context.WithCancel(context.Background())
	cancel() // the session was already cut when the handler reaches the disk or the panel

	e := callCtx(t, a, session, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/n.jar", TransferId: xferID, Size: 5}}})
	if e.GetAck() == nil {
		t.Fatalf("upload with the session cut = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "mods", "n.jar")); string(b) != "fresh" {
		t.Fatalf("uploaded = %q", b)
	}
	e = callCtx(t, a, session, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}})
	if e.GetAck() == nil || put.Load() != "motd=hola\n" {
		t.Fatalf("download with the session cut = %+v, panel received %v", e, put.Load())
	}
	e = callCtx(t, a, session, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_FilesWrite{FilesWrite: &mcsmv1.FilesWrite{ServerId: "a", Path: "server.properties", Content: []byte("x=1\n")}}})
	if e.GetAck() == nil {
		t.Fatalf("write with the session cut = %+v", e)
	}
}

// tmpFiles returns the atomic write temporaries left in dir.
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

// If the agent stops midway through an upload, the transfer is cut, the temporary is
// deleted and the original file is left intact.
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
		select { // the rest never arrives
		case <-r.Context().Done():
		case <-release:
		}
	})
	t.Cleanup(func() { close(release) }) // before srv.Close (reverse order)
	s := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 15, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}}, s.send)

	// Wait on a condition: the temporary exists and already has the 100 bytes received.
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
			t.Fatal("the upload did not start writing")
		case <-time.After(time.Millisecond):
		}
	}
	stop()
	e := s.waitID(t, 15)
	if errCode(e) != "transfer_failed" {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("the original changed: %q", b)
	}
	if left := tmpFiles(t, root); len(left) != 0 {
		t.Fatalf("temporaries remain: %v", left)
	}
}

// A file name that is not UTF-8 does not break the listing: proto3 rejects strings with invalid
// UTF-8 and the whole response would be lost.
func TestFilesListNonUTF8NameStillMarshals(t *testing.T) {
	a, root := filesApp(t)
	if err := os.WriteFile(filepath.Join(root, "caf\xe9.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := call(t, a, &mcsmv1.Envelope{Id: 16, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}})
	if _, err := proto.Marshal(e); err != nil {
		t.Fatalf("response not serializable: %v", err)
	}
	found := false
	for _, en := range e.GetFilesListResult().GetEntries() {
		found = found || en.Name == "caf�.txt"
	}
	if !found {
		t.Fatalf("list = %+v", e)
	}
}

// chunked sends data without Content-Length (Transfer-Encoding: chunked).
func chunked(data []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		half := len(data) / 2
		_, _ = w.Write(data[:half])
		w.(http.Flusher).Flush() // already without Content-Length
		_, _ = w.Write(data[half:])
	}
}

// Without a known size (FilesUpload.size = -1 and chunked response) the upload has a hard
// cap: an endless source does not fill the node's disk.
func TestFilesUploadUnknownSizeIsCapped(t *testing.T) {
	a, root := filesApp(t)
	a.cfg.UploadMax = 1000
	panelFor(t, a, chunked(bytes.Repeat([]byte("x"), 2000)))
	e := call(t, a, &mcsmv1.Envelope{Id: 17, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/endless.jar", TransferId: xferID, Size: -1}}})
	if errCode(e) != "too_large" {
		t.Fatalf("resp = %+v", e)
	}
	if _, err := os.Stat(filepath.Join(root, "mods", "endless.jar")); !os.IsNotExist(err) {
		t.Fatalf("the file must not remain: %v", err)
	}
	if left := tmpFiles(t, filepath.Join(root, "mods")); len(left) != 0 {
		t.Fatalf("temporaries remain: %v", left)
	}
}

// A chunked upload within the cap is written in full.
func TestFilesUploadUnknownSizeWithinCap(t *testing.T) {
	a, root := filesApp(t)
	a.cfg.UploadMax = 1000
	panelFor(t, a, chunked(bytes.Repeat([]byte("y"), 1000)))
	e := call(t, a, &mcsmv1.Envelope{Id: 18, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/ok.jar", TransferId: xferID, Size: -1}}})
	if e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "mods", "ok.jar")); len(b) != 1000 {
		t.Fatalf("%d bytes written", len(b))
	}
}

// An announced size above the cap is rejected without consuming the transfer.
func TestFilesUploadKnownSizeOverCapDoesNotConsumeTransfer(t *testing.T) {
	a, _ := filesApp(t)
	a.cfg.UploadMax = 1000
	var hit atomic.Bool
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) { hit.Store(true) })
	e := call(t, a, &mcsmv1.Envelope{Id: 19, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/x.jar", TransferId: xferID, Size: 1001}}})
	if errCode(e) != "too_large" || hit.Load() {
		t.Fatalf("resp = %+v, transfer consumed = %v", e, hit.Load())
	}
}

func TestLoadConfigUploadMax(t *testing.T) {
	t.Setenv("PANEL_URL", "http://p")
	t.Setenv("UPLOAD_MAX_BYTES", "")
	cfg, err := LoadConfig("x")
	if err != nil || cfg.UploadMax != 4<<30 {
		t.Fatalf("default: cfg.UploadMax=%d err=%v", cfg.UploadMax, err)
	}
	t.Setenv("UPLOAD_MAX_BYTES", "1048576")
	if cfg, err = LoadConfig("x"); err != nil || cfg.UploadMax != 1<<20 {
		t.Fatalf("cfg.UploadMax=%d err=%v", cfg.UploadMax, err)
	}
	for _, bad := range []string{"0", "-5", "4G", "abc"} {
		t.Setenv("UPLOAD_MAX_BYTES", bad)
		if _, err := LoadConfig("x"); err == nil {
			t.Fatalf("UPLOAD_MAX_BYTES=%q must fail", bad)
		}
	}
}

// The node serves at most maxTransfers transfers at a time; the next one gets busy
// instantly and without consuming its transfer. When one finishes, there is room again.
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
	t.Cleanup(open) // before srv.Close (reverse order)
	s := newSink()
	for i := 1; i <= maxTransfers; i++ {
		go a.Handle(context.Background(), &mcsmv1.Envelope{Id: uint64(i), Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/" + strconv.Itoa(i) + ".jar", TransferId: xferID, Size: 1}}}, s.send)
	}
	for i := 0; i < maxTransfers; i++ {
		select {
		case <-hits:
		case <-time.After(3 * time.Second):
			t.Fatalf("only %d transfers in progress", i)
		}
	}
	// All 4 have a slot and are at the panel: one more upload and one more download do not fit. They go in
	// goroutines so that, if the limit failed, the test fails at 3 s and not at the HTTP deadline.
	extra := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 10, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "mods/extra.jar", TransferId: xferID, Size: 1}}}, extra.send)
	if e := extra.waitID(t, 10); errCode(e) != "busy" {
		t.Fatalf("extra upload = %+v", e)
	}
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 11, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}}, extra.send)
	if e := extra.waitID(t, 11); errCode(e) != "busy" {
		t.Fatalf("extra download = %+v", e)
	}
	if len(hits) != 0 {
		t.Fatal("the rejected ones must not consume their transfer")
	}
	// Inline operations do not count.
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
		t.Fatalf("uploaded = %q", b)
	}
	if e := call(t, a, &mcsmv1.Envelope{Id: 13, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}}); e.GetAck() == nil {
		t.Fatalf("after releasing = %+v", e)
	}
}

// fakeIdle replaces the idle watchdog's clock: each period is a channel that the
// test fires by hand.
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
		t.Fatal("the idle watchdog did not start")
		return nil
	}
}

// An upload that stops receiving bytes for a whole period is cut off; a period with
// progress does not cut it.
func TestFilesUploadIdleIsCut(t *testing.T) {
	a, root := filesApp(t)
	timers := fakeIdle(a)
	release := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write(bytes.Repeat([]byte("x"), 100))
		w.(http.Flusher).Flush()
		select { // the panel hangs without closing the connection
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
			t.Fatal("the upload did not start writing")
		case <-time.After(time.Millisecond):
		}
	}
	first <- time.Time{}                // there was progress in this period: it continues
	nextTimer(t, timers) <- time.Time{} // whole period without bytes: it is cut off
	e := s.waitID(t, 20)
	if errCode(e) != "transfer_failed" || !strings.Contains(e.GetError().GetMessage(), "without any byte moving") {
		t.Fatalf("resp = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("the original changed: %q", b)
	}
	if left := tmpFiles(t, root); len(left) != 0 {
		t.Fatalf("temporaries remain: %v", left)
	}
}

// A download whose panel stops reading (or does not respond) is cut off all the same.
func TestFilesDownloadIdleIsCut(t *testing.T) {
	a, _ := filesApp(t)
	timers := fakeIdle(a)
	read := make(chan struct{})
	release := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadFull(r.Body, make([]byte, 1))
		close(read)
		select { // never responds
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
		t.Fatal("the panel received nothing")
	}
	first <- time.Time{}
	nextTimer(t, timers) <- time.Time{}
	if e := s.waitID(t, 21); errCode(e) != "transfer_failed" || !strings.Contains(e.GetError().GetMessage(), "without any byte moving") {
		t.Fatalf("resp = %+v", e)
	}
}

// The Error that reaches the panel (and the browser) carries neither the URL, the transfer_id nor the IP.
func TestFilesTransferErrorHidesURL(t *testing.T) {
	a, _ := filesApp(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.Listener.Addr().String()
	srv.Close() // nobody listening
	a.cfg.PanelURL = "http://" + addr
	e := call(t, a, &mcsmv1.Envelope{Id: 22, Body: &mcsmv1.Envelope_FilesDownload{FilesDownload: &mcsmv1.FilesDownload{ServerId: "a", Path: "server.properties", TransferId: xferID}}})
	msg := e.GetError().GetMessage()
	if errCode(e) != "transfer_failed" || strings.Contains(msg, xferID) || strings.Contains(msg, addr) || strings.Contains(msg, "127.0.0.1") {
		t.Fatalf("resp = %+v", e)
	}
}

// patternBlock is a repeated 251-byte cycle; pattern copies it without reserving memory.
var patternBlock = func() []byte {
	b := make([]byte, 64<<10+251)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}()

// pattern generates deterministic bytes (up to 64 KiB per read) without reserving memory.
type pattern struct{ off int }

func (p *pattern) Read(b []byte) (int, error) {
	n := copy(b, patternBlock[p.off%251:])
	p.off += n
	return n, nil
}

// If fn panics, its context is left cancelled: the idle watchdog does not stay
// alive waiting for a period that, with this clock, never expires.
func TestWithIdleGuardCancelsOnPanic(t *testing.T) {
	a, _ := filesApp(t)
	fakeIdle(a)
	var got context.Context
	func() {
		defer func() { _ = recover() }()
		_ = a.withIdleGuard(context.Background(), func(ctx context.Context, _ func(io.Reader) io.Reader) error {
			got = ctx
			panic("boom")
		})
	}()
	if got == nil || got.Err() == nil {
		t.Fatal("the watchdog's context is still alive after the panic")
	}
}
