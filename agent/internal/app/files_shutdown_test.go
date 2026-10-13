package app

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// On shutdown, the agent waits for the Files* in progress: an upload cut by the shutdown cleans up its
// temporary and responds before the process exits.
func TestShutdownWaitsForFileOps(t *testing.T) {
	a, root := filesApp(t)
	life, stop := context.WithCancel(context.Background())
	a.life = life
	started := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write([]byte(strings.Repeat("x", 100)))
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done() // the panel sends no more: the upload stays in progress until the agent cuts it
	})
	s := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 30, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}}, s.send)
	<-started
	stop() // agent shutdown: the life context is cancelled
	if !a.xfer.wait(5 * time.Second) {
		t.Fatal("the wait expired with the upload still in progress")
	}
	select {
	case e := <-s.ch:
		if e.Id != 30 || e.GetError() == nil {
			t.Fatalf("resp = %+v", e)
		}
	default:
		t.Fatal("wait returned before the handler finished")
	}
	if left := tmpFiles(t, root); len(left) != 0 {
		t.Fatalf("temporaries remain: %v", left)
	}
}

// The wait has a cap: a handler that does not finish does not block the shutdown.
func TestShutdownWaitHasCap(t *testing.T) {
	a, _ := filesApp(t)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	started := make(chan struct{})
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write([]byte(strings.Repeat("x", 100)))
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	s := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 31, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}}, s.send)
	<-started
	if a.xfer.wait(20 * time.Millisecond) { // a.life is still alive: the upload does not finish by itself
		t.Fatal("wait said everything finished with a hung upload")
	}
	unblock()
	s.waitID(t, 31)
}

// Once the shutdown has begun, new Files* are rejected with busy instead of starting.
func TestFilesRefusedWhileClosing(t *testing.T) {
	a, _ := filesApp(t)
	if !a.xfer.wait(time.Second) {
		t.Fatal("with nothing in progress the wait should end immediately")
	}
	e := call(t, a, &mcsmv1.Envelope{Id: 32, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}})
	if errCode(e) != "busy" || !strings.Contains(e.GetError().GetMessage(), "shutting down") {
		t.Fatalf("resp = %+v", e)
	}
}

// At startup the orphaned temporaries (older than 1 h) in the servers' data are swept.
func TestStartupSweepsOrphanTemps(t *testing.T) {
	a, root := filesApp(t)
	old := filepath.Join(root, "mods", ".mcsm-tmp-0123456789abcdef")
	recent := filepath.Join(root, ".mcsm-tmp-fedcba9876543210")
	for _, p := range []string{old, recent} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	a.sweepTemps(context.Background())
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("the old temporary is still there (err %v)", err)
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatalf("the recent temporary was deleted: %v", err)
	}
}
