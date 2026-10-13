package app

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/errcode"
)

// With the server reserved (backup, restore or blocked without data), file
// mutations answer busy without touching the disk or claiming the transfer; reads continue
// (the restore swaps data with rename: each read sees the old or the new data, whole).
func TestFilesMutationsBusyWhileHeld(t *testing.T) {
	a, root := filesApp(t)
	var claimed atomic.Bool
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		claimed.Store(true)
		_, _ = w.Write([]byte("x"))
	})
	release, err := a.rec.Hold("a", "restore")
	if err != nil {
		t.Fatal(err)
	}
	mutations := []*mcsmv1.Envelope{
		{Id: 2, Body: &mcsmv1.Envelope_FilesWrite{FilesWrite: &mcsmv1.FilesWrite{ServerId: "a", Path: "server.properties", Content: []byte("motd=other\n")}}},
		{Id: 3, Body: &mcsmv1.Envelope_FilesMkdir{FilesMkdir: &mcsmv1.FilesMkdir{ServerId: "a", Path: "plugins"}}},
		{Id: 4, Body: &mcsmv1.Envelope_FilesRename{FilesRename: &mcsmv1.FilesRename{ServerId: "a", From: "mods", To: "mods-old"}}},
		{Id: 5, Body: &mcsmv1.Envelope_FilesDelete{FilesDelete: &mcsmv1.FilesDelete{ServerId: "a", Path: "mods"}}},
		{Id: 6, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "new.txt", TransferId: xferID, Size: 1}}},
	}
	for _, env := range mutations {
		if got := errCode(call(t, a, env)); got != errcode.Busy {
			t.Errorf("id %d (%T): code = %q; want busy", env.Id, env.Body, got)
		}
	}
	if claimed.Load() {
		t.Fatal("a rejected upload must not claim the transfer")
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("the file changed: %q", b)
	}
	for _, p := range []string{"mods", "plugins", "mods-old", "new.txt"} {
		_, err := os.Stat(filepath.Join(root, p))
		if want := p == "mods"; (err == nil) != want {
			t.Errorf("%s: exists = %v; want %v", p, err == nil, want)
		}
	}
	if l := call(t, a, &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}}); l.GetFilesListResult() == nil {
		t.Fatalf("listing with the reservation held = %+v", l)
	}
	if n := a.fileWrites.count("a"); n != 0 {
		t.Fatalf("mutations in progress after responding = %d", n)
	}
	release(context.Background())
	if e := call(t, a, mutations[0]); e.GetAck() == nil {
		t.Fatalf("without a reservation the write works: %+v", e)
	}
}

// A server blocked without data (failed restore): Mkdir cannot "unblock" it
// by creating an empty data.
func TestFilesMkdirOnBlockedServerWithoutDataIsBusy(t *testing.T) {
	a, root := filesApp(t)
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	release, err := a.rec.Hold("a", "no data directory")
	if err != nil {
		t.Fatal(err)
	}
	defer release(context.Background())
	e := call(t, a, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_FilesMkdir{FilesMkdir: &mcsmv1.FilesMkdir{ServerId: "a", Path: "world"}}})
	if errCode(e) != errcode.Busy {
		t.Fatalf("resp = %+v", e)
	}
	// The reason is the reservation's, not "another backup or restore".
	if msg := e.GetError().GetMessage(); !strings.Contains(msg, "no data directory") || strings.Contains(msg, "another backup") {
		t.Fatalf("message = %q", msg)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("data was created: %v", err)
	}
}

func TestFileWritesCounter(t *testing.T) {
	var w fileWrites
	select {
	case <-w.drained("a"):
	default:
		t.Fatal("without mutations, drained is closed")
	}
	l1 := w.enter("a")
	l2 := w.enter("a")
	other := w.enter("b")
	ch := w.drained("a")
	l1()
	l1() // idempotent
	select {
	case <-ch:
		t.Fatal("a mutation remains in progress on a")
	default:
	}
	if n := w.count("a"); n != 1 {
		t.Fatalf("count(a) = %d", n)
	}
	l2()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("drained was not closed when the last one finished")
	}
	if n := w.count("b"); n != 1 {
		t.Fatalf("count(b) = %d (each server counts separately)", n)
	}
	other()
}
