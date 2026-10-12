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

// Al cerrar, el agente espera a los Files* en curso: una subida cortada por el cierre limpia su
// temporal y responde antes de que el proceso salga.
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
		<-r.Context().Done() // el panel no envía más: la subida sigue en curso hasta que el agente corte
	})
	s := newSink()
	go a.Handle(context.Background(), &mcsmv1.Envelope{Id: 30, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "server.properties", TransferId: xferID, Size: 1000}}}, s.send)
	<-started
	stop() // cierre del agente: se cancela el contexto de vida
	if !a.xfer.wait(5 * time.Second) {
		t.Fatal("la espera venció con la subida aún en curso")
	}
	select {
	case e := <-s.ch:
		if e.Id != 30 || e.GetError() == nil {
			t.Fatalf("resp = %+v", e)
		}
	default:
		t.Fatal("wait volvió antes de que terminara el handler")
	}
	if left := tmpFiles(t, root); len(left) != 0 {
		t.Fatalf("quedan temporales: %v", left)
	}
}

// La espera tiene tope: un handler que no termina no bloquea el cierre.
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
	if a.xfer.wait(20 * time.Millisecond) { // a.life sigue vivo: la subida no termina sola
		t.Fatal("wait dijo que todo terminó con una subida colgada")
	}
	unblock()
	s.waitID(t, 31)
}

// Tras empezar el cierre, los Files* nuevos se rechazan con busy en vez de empezar.
func TestFilesRefusedWhileClosing(t *testing.T) {
	a, _ := filesApp(t)
	if !a.xfer.wait(time.Second) {
		t.Fatal("sin nada en curso la espera debería acabar en el acto")
	}
	e := call(t, a, &mcsmv1.Envelope{Id: 32, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}})
	if errCode(e) != "busy" || !strings.Contains(e.GetError().GetMessage(), "cerrando") {
		t.Fatalf("resp = %+v", e)
	}
}

// Al arrancar se barren los temporales huérfanos (más de 1 h) de los data de los servidores.
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
		t.Fatalf("el temporal viejo sigue ahí (err %v)", err)
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatalf("el temporal reciente se borró: %v", err)
	}
}
