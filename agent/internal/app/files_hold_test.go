package app

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/errcode"
)

// Con el servidor reservado (copia, restauración o bloqueado sin datos), las mutaciones de
// archivos responden busy sin tocar el disco ni reclamar la transferencia; las lecturas siguen
// (la restauración intercambia data con rename: cada lectura ve el data viejo o el nuevo, entero).
func TestFilesMutationsBusyWhileHeld(t *testing.T) {
	a, root := filesApp(t)
	var claimed atomic.Bool
	panelFor(t, a, func(w http.ResponseWriter, r *http.Request) {
		claimed.Store(true)
		_, _ = w.Write([]byte("x"))
	})
	release, err := a.rec.Hold("a", "restauración")
	if err != nil {
		t.Fatal(err)
	}
	mutations := []*mcsmv1.Envelope{
		{Id: 2, Body: &mcsmv1.Envelope_FilesWrite{FilesWrite: &mcsmv1.FilesWrite{ServerId: "a", Path: "server.properties", Content: []byte("motd=otro\n")}}},
		{Id: 3, Body: &mcsmv1.Envelope_FilesMkdir{FilesMkdir: &mcsmv1.FilesMkdir{ServerId: "a", Path: "plugins"}}},
		{Id: 4, Body: &mcsmv1.Envelope_FilesRename{FilesRename: &mcsmv1.FilesRename{ServerId: "a", From: "mods", To: "mods-old"}}},
		{Id: 5, Body: &mcsmv1.Envelope_FilesDelete{FilesDelete: &mcsmv1.FilesDelete{ServerId: "a", Path: "mods"}}},
		{Id: 6, Body: &mcsmv1.Envelope_FilesUpload{FilesUpload: &mcsmv1.FilesUpload{ServerId: "a", Path: "nuevo.txt", TransferId: xferID, Size: 1}}},
	}
	for _, env := range mutations {
		if got := errCode(call(t, a, env)); got != errcode.Busy {
			t.Errorf("id %d (%T): code = %q; quiero busy", env.Id, env.Body, got)
		}
	}
	if claimed.Load() {
		t.Fatal("una subida rechazada no debe reclamar la transferencia")
	}
	if b, _ := os.ReadFile(filepath.Join(root, "server.properties")); string(b) != "motd=hola\n" {
		t.Fatalf("el fichero cambió: %q", b)
	}
	for _, p := range []string{"mods", "plugins", "mods-old", "nuevo.txt"} {
		_, err := os.Stat(filepath.Join(root, p))
		if want := p == "mods"; (err == nil) != want {
			t.Errorf("%s: existe = %v; quiero %v", p, err == nil, want)
		}
	}
	if l := call(t, a, &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "a", Path: "/"}}}); l.GetFilesListResult() == nil {
		t.Fatalf("listar con la reserva tomada = %+v", l)
	}
	release(context.Background())
	if e := call(t, a, mutations[0]); e.GetAck() == nil {
		t.Fatalf("sin reserva la escritura funciona: %+v", e)
	}
}

// Un servidor bloqueado sin data (restauración fallida): Mkdir no puede «desbloquearlo»
// creando un data vacío.
func TestFilesMkdirOnBlockedServerWithoutDataIsBusy(t *testing.T) {
	a, root := filesApp(t)
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	release, err := a.rec.Hold("a", "sin directorio de datos")
	if err != nil {
		t.Fatal(err)
	}
	defer release(context.Background())
	e := call(t, a, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_FilesMkdir{FilesMkdir: &mcsmv1.FilesMkdir{ServerId: "a", Path: "world"}}})
	if errCode(e) != errcode.Busy {
		t.Fatalf("resp = %+v", e)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("se creó data: %v", err)
	}
}
