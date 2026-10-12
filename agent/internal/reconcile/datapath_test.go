package reconcile

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

// H1: el agente solo monta un dataPath si es la carpeta que verificó al adoptar el contenedor de ese
// servidor. Un panel comprometido no puede montar /root (ni nada) en un contenedor.

func TestUnverifiedDataPathCreatesNothing(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec("", impOpts{noAdopt: true, dataPath: "/root/mc"})))
	err := r.Reconcile(context.Background(), "a")
	if !errors.Is(err, ErrDataPathUnverified) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create")+calls(fake, "EnsureImage") != 0 {
		t.Fatalf("sin verificar no se toca Docker: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "/root/mc") {
		t.Fatalf("observed = %+v", o)
	}
}

func TestDataPathOtherThanVerifiedIsRefused(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	if p, _ := st.ExternalPath("a"); p != extDataPath {
		t.Fatalf("adoptar registra la carpeta verificada: %q", p)
	}
	fake.Calls = nil
	err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{dataPath: "/root/mc", memory: "3G"})))
	if !errors.Is(err, ErrDataPathUnverified) {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fake.Containers[id]; !ok || calls(fake, "Stop")+calls(fake, "Remove")+calls(fake, "Create") != 0 {
		t.Fatalf("el original sigue intacto: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "/root/mc") {
		t.Fatalf("observed = %+v", o)
	}
}

// El registro sobrevive a reiniciar el agente: la primera recreación tras el reinicio monta la carpeta.
func TestVerifiedDataPathSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	dbPath, root := filepath.Join(dir, "agent.db"), filepath.Join(dir, "data")
	fake := docker.NewFake()
	newRec := func(st *store.Store) *Reconciler {
		r := New(st, fake, root, "mcsm", stubStatus, nil)
		r.now = func() time.Time { return time.Unix(1_000_000, 0) }
		r.log = slog.New(slog.NewTextHandler(io.Discard, nil))
		return r
	}
	ctx := context.Background()
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	id := external(t, fake, "mc", extDataPath, true)
	if err := newRec(st).Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := newRec(st).Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{dataPath: extDataPath, memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Name != "mcsm-alpha" {
		t.Fatalf("gestionado = %+v", list)
	}
	if src := dataSource(t, fake, list[0].ID); src != extDataPath {
		t.Fatalf("/data = %q", src)
	}
}

// Store perdido y original desaparecido: nada demuestra que la carpeta sea la del importado.
func TestStoreLostAndOriginalGoneCreatesNothing(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(docker.FakeID(42), impOpts{dataPath: extDataPath})))
	if err := r.Reconcile(context.Background(), "a"); !errors.Is(err, ErrDataPathUnverified) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create") != 0 {
		t.Fatalf("no se crea nada: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "vuelve a importar") {
		t.Fatalf("observed = %+v", o)
	}
}

// Store perdido con el original vivo: la readopción vuelve a verificar y registra la carpeta.
func TestStoreLostReadoptRegistersDataPath(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	id := external(t, fake, "mc", extDataPath, true)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{dataPath: extDataPath})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if p, _ := st.ExternalPath("a"); p != extDataPath {
		t.Fatalf("ruta = %q", p)
	}
}

// Store perdido tras la recreación: el gestionado (solo lo crea el agente, con la carpeta ya
// verificada) la sigue montando; se recupera el registro sin recrear.
func TestStoreLostRecoversFromManagedContainer(t *testing.T) {
	r, _, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{dataPath: extDataPath, memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	// Agente nuevo (store vacío) sobre el mismo Docker.
	r2, st2, _, _, _ := setup(t)
	r2.eng, r2.dataRoot = fake, r.dataRoot
	put(t, st2, "a", "alpha", 2, desiredRunning, string(importedSpec(id, impOpts{dataPath: extDataPath, memory: "3G"})))
	fake.Calls = nil
	if err := r2.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create")+calls(fake, "Remove") != 0 {
		t.Fatalf("no recrea: %v", fake.Calls)
	}
	if p, _ := st2.ExternalPath("a"); p != extDataPath {
		t.Fatalf("ruta recuperada = %q", p)
	}
}

// dataSource es la carpeta del host montada en /data de un contenedor del fake (Binds o Mounts).
func dataSource(t *testing.T, fake *docker.Fake, id string) string {
	t.Helper()
	info, err := fake.InspectImport(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range info.Mounts {
		if m.Destination == "/data" {
			return m.Source
		}
	}
	return ""
}
