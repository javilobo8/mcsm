package router

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

func newManager(t *testing.T) (*Manager, *docker.Fake, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := docker.NewFake()
	m := New(fake, st, Options{Network: "mcsm", SocketGID: func() (uint32, error) { return 967, nil },
		Now: func() time.Time { return time.UnixMilli(1000) }, FilesDir: filepath.Join(t.TempDir(), ".mcsm-router")})
	return m, fake, st
}

// routerContainer devuelve el contenedor del router del fake (nil si no hay).
func routerContainer(t *testing.T, fake *docker.Fake) *docker.Container {
	t.Helper()
	list, _ := fake.ListManaged(context.Background())
	var found *docker.Container
	for i := range list {
		if list[i].Labels[LabelRouter] == "true" {
			if found != nil {
				t.Fatal("hay dos contenedores del router")
			}
			found = &list[i]
		}
	}
	return found
}

func calls(fake *docker.Fake, prefix string) int {
	n := 0
	for _, c := range fake.Calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func TestReconcileCreatesAndIsIdempotent(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	if err := m.Apply(&mcsmv1.RouterSpec{HostPort: 25565}); err != nil {
		t.Fatal(err)
	}
	obs := m.Reconcile(ctx)
	if obs.Error != "" || obs.State != "running" || !obs.Configured || obs.HostPort != 25565 || obs.Image != ImageRef() || obs.ContainerId == "" {
		t.Fatalf("observed = %+v", obs)
	}
	c := routerContainer(t, fake)
	if c == nil || c.Name != "mcsm-router" {
		t.Fatalf("contenedor = %+v", c)
	}
	if len(fake.Pulled) != 1 || fake.Pulled[0] != ImageRef() {
		t.Fatalf("imagen = %v", fake.Pulled)
	}
	before := len(fake.Calls)
	obs = m.Reconcile(ctx)
	if obs.State != "running" || obs.Error != "" {
		t.Fatalf("observed = %+v", obs)
	}
	for _, call := range fake.Calls[before:] {
		if strings.HasPrefix(call, "Create") || strings.HasPrefix(call, "Remove") || strings.HasPrefix(call, "Start") || strings.HasPrefix(call, "Stop") {
			t.Fatalf("una segunda pasada no toca Docker: %v", fake.Calls[before:])
		}
	}
}

func TestReconcileRecoversManualChanges(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	m.Reconcile(ctx)

	// Parado a mano: se arranca.
	c := routerContainer(t, fake)
	_ = fake.Stop(ctx, c.ID, time.Second)
	if obs := m.Reconcile(ctx); obs.State != "running" {
		t.Fatalf("tras parar a mano: %+v", obs)
	}
	// Borrado a mano: se recrea.
	_ = fake.Remove(ctx, c.ID)
	obs := m.Reconcile(ctx)
	if obs.State != "running" || obs.ContainerId == c.ID {
		t.Fatalf("tras borrar a mano: %+v", obs)
	}
}

func TestReconcilePortBusy(t *testing.T) {
	m, fake, _ := newManager(t)
	now := time.UnixMilli(1000)
	m.opts.Now = func() time.Time { return now }
	ctx := context.Background()
	// Un contenedor ajeno ya publica el 25565 del host.
	port := network.MustParsePort("25565/tcp")
	other, err := fake.Create(ctx, "ajeno", &container.Config{Image: "x"},
		&container.HostConfig{PortBindings: network.PortMap{port: {{HostPort: "25565"}}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = fake.Start(ctx, other)

	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	obs := m.Reconcile(ctx)
	if obs.State != "missing" || !strings.Contains(obs.Error, "port is already allocated") || !strings.Contains(obs.Error, "25565") {
		t.Fatalf("observed = %+v", obs)
	}
	// El contenedor que no pudo arrancar se borra: Docker lo arrancaría después sin publicar el puerto.
	if routerContainer(t, fake) != nil {
		t.Fatal("el contenedor fallido no se conserva")
	}
	// Con la misma spec no se reintenta antes de RetryAfter (los eventos del fallo no hacen bucle).
	if obs := m.Reconcile(ctx); obs.Error == "" || calls(fake, "Create mcsm-router") != 1 {
		t.Fatalf("reintento inmediato: %+v, creados %d", obs, calls(fake, "Create mcsm-router"))
	}
	// Pasado RetryAfter con el puerto libre, arranca.
	_ = fake.Stop(ctx, other, time.Second)
	now = now.Add(RetryAfter)
	if obs := m.Reconcile(ctx); obs.State != "running" || obs.Error != "" {
		t.Fatalf("tras liberar el puerto: %+v", obs)
	}
	// Una spec nueva se intenta al momento, aunque el último intento fallara.
	port2 := network.MustParsePort("25570/tcp")
	other2, _ := fake.Create(ctx, "ajeno2", &container.Config{Image: "x"},
		&container.HostConfig{PortBindings: network.PortMap{port2: {{HostPort: "25570"}}}}, nil)
	_ = fake.Start(ctx, other2)
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25570})
	if obs := m.Reconcile(ctx); !strings.Contains(obs.Error, "25570") {
		t.Fatalf("el 25570 está ocupado: %+v", obs)
	}
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25590})
	if obs := m.Reconcile(ctx); obs.State != "running" || obs.HostPort != 25590 || obs.Error != "" {
		t.Fatalf("en otro puerto: %+v", obs)
	}
}

func TestReconcileRecreatesOnSpecOrImageChange(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	first := m.Reconcile(ctx).ContainerId

	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true})
	obs := m.Reconcile(ctx)
	if obs.ContainerId == first || obs.State != "running" || !obs.Autoscale {
		t.Fatalf("autoscale: %+v", obs)
	}
	if _, ok := fake.Containers[first]; ok {
		t.Fatal("el contenedor anterior se borra")
	}
	if !strings.Contains(strings.Join(fake.Containers[obs.ContainerId].Config.Cmd, " "), "-auto-scale-up") {
		t.Fatal("el nuevo lleva el autoscale")
	}

	// Un router de una versión anterior del agente (otra imagen, otro hash) se sustituye.
	c := fake.Containers[obs.ContainerId]
	c.Config.Image = "itzg/mc-router:1.0.0"
	c.Config.Labels[LabelHash] = "obsoleto"
	obs = m.Reconcile(ctx)
	if obs.ContainerId == c.ID || fake.Containers[obs.ContainerId].Config.Image != ImageRef() {
		t.Fatalf("actualización de imagen: %+v", obs)
	}
}

func TestReconcileWithoutSpecRemoves(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	if obs := m.Reconcile(ctx); obs.Configured || obs.State != "missing" || len(fake.Calls) != 0 {
		t.Fatalf("sin spec ni contenedor no se toca Docker: %+v %v", obs, fake.Calls)
	}
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	m.Reconcile(ctx)
	if err := m.Clear(); err != nil {
		t.Fatal(err)
	}
	obs := m.Reconcile(ctx)
	if obs.Configured || obs.State != "missing" || obs.Error != "" || routerContainer(t, fake) != nil {
		t.Fatalf("tras Clear: %+v", obs)
	}
}

func TestReconcileNeverTouchesServers(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	id, _ := fake.Create(ctx, "mcsm-survival", &container.Config{Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": "s1"}}, &container.HostConfig{}, nil)
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	m.Reconcile(ctx)
	_ = m.Clear()
	m.Reconcile(ctx)
	if _, ok := fake.Containers[id]; !ok {
		t.Fatal("el router nunca borra un servidor")
	}
}

func TestReconcileNameConflict(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	// Un contenedor del usuario llamado mcsm-router, sin nuestras etiquetas: no se toca.
	foreign, _ := fake.Create(ctx, "mcsm-router", &container.Config{Image: "otro"}, &container.HostConfig{}, nil)
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	obs := m.Reconcile(ctx)
	if !strings.Contains(obs.Error, "mcsm-router") || obs.State != "missing" {
		t.Fatalf("observed = %+v", obs)
	}
	if _, ok := fake.Containers[foreign]; !ok {
		t.Fatal("el contenedor ajeno sigue")
	}
}

func TestReconcileSocketGIDError(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	fake := docker.NewFake()
	m := New(fake, st, Options{Network: "mcsm", SocketGID: func() (uint32, error) { return 0, errors.New("no existe") }})
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	obs := m.Reconcile(context.Background())
	if !strings.Contains(obs.Error, "/var/run/docker.sock") || routerContainer(t, fake) != nil {
		t.Fatalf("observed = %+v", obs)
	}
}

func TestApplyValidatesAndRestartKeepsState(t *testing.T) {
	m, fake, st := newManager(t)
	if err := m.Apply(&mcsmv1.RouterSpec{HostPort: 0}); err == nil {
		t.Fatal("puerto 0 inválido")
	}
	if sp, _ := st.RouterSpec(); sp != nil {
		t.Fatal("una spec inválida no se guarda")
	}
	if err := m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}); err != nil {
		t.Fatal(err)
	}
	if !m.Autoscale() {
		t.Fatal("autoscale")
	}
	// Reinicio del agente: otro Manager sobre el mismo store recuerda la spec y recrea lo que falte.
	m2 := New(fake, st, Options{Network: "mcsm", SocketGID: func() (uint32, error) { return 967, nil }})
	if !m2.Autoscale() {
		t.Fatal("el autoscale se carga del store")
	}
	if obs := m2.Reconcile(context.Background()); obs.State != "running" {
		t.Fatalf("observed = %+v", obs)
	}
	_ = m2.Clear()
	if m2.Autoscale() {
		t.Fatal("Clear quita el autoscale")
	}
}

func TestReconcileConcurrent(t *testing.T) {
	m, fake, _ := newManager(t)
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() { m.Reconcile(context.Background()) })
	}
	wg.Wait()
	if n := calls(fake, "Create"); n != 1 {
		t.Fatalf("creados = %d", n)
	}
}

// Docker 29.7.2: si la política de reinicio (o alguien) intentó arrancar el router con el puerto
// ocupado, los arranques siguientes no publican el puerto. El router se recrea, tanto si lo
// encuentra parado (lo arrancaría sin puerto) como si ya está en marcha sin él.
func TestReconcileRecreatesRouterLeftWithoutPorts(t *testing.T) {
	for _, alreadyRunning := range []bool{false, true} {
		m, fake, _ := newManager(t)
		ctx := context.Background()
		_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
		first := m.Reconcile(ctx).ContainerId
		_ = fake.Stop(ctx, first, time.Second) // el host se reinicia
		port := network.MustParsePort("25565/tcp")
		other, _ := fake.Create(ctx, "ajeno", &container.Config{Image: "x"},
			&container.HostConfig{PortBindings: network.PortMap{port: {{HostPort: "25565"}}}}, nil)
		_ = fake.Start(ctx, other)
		if err := fake.Start(ctx, first); err == nil { // unless-stopped con el puerto ocupado
			t.Fatal("el puerto está ocupado")
		}
		_ = fake.Stop(ctx, other, time.Second)
		if alreadyRunning {
			_ = fake.Start(ctx, first) // la política lo vuelve a intentar: en marcha, sin puerto
		}
		obs := m.Reconcile(ctx)
		if obs.State != "running" || obs.Error != "" || obs.ContainerId == first {
			t.Fatalf("en marcha=%v: %+v", alreadyRunning, obs)
		}
		if ins, _ := fake.Inspect(ctx, obs.ContainerId); ins.PortsMissing {
			t.Fatalf("en marcha=%v: el router nuevo publica el puerto", alreadyRunning)
		}
		if _, ok := fake.Containers[first]; ok {
			t.Fatalf("en marcha=%v: el contaminado se borra", alreadyRunning)
		}
	}
}

func TestReconcileWritesAllowDenyFile(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	path := filepath.Join(m.opts.FilesDir, "allow-deny.json")
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"amigo"}})
	obs := m.Reconcile(ctx)
	if obs.State != "running" || obs.Error != "" {
		t.Fatalf("observed = %+v", obs)
	}
	if got, _ := os.ReadFile(path); string(got) != `{"global":{"allowlist":[{"name":"amigo"}]}}` {
		t.Fatalf("fichero = %q", got)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o644 {
		t.Fatalf("mc-router (usuario 65532) debe poder leerlo: %v %v", fi, err)
	}
	if !slices.Equal(obs.Spec.GetAutoscaleAllowPlayers(), []string{"amigo"}) || !obs.Spec.GetAutoscale() {
		t.Fatalf("la spec aplicada viaja en RouterObserved: %+v", obs.Spec)
	}
	first := obs.ContainerId

	// Otra lista: fichero nuevo y router recreado (mc-router no lo relee).
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"amigo", "otro"}})
	obs = m.Reconcile(ctx)
	if got, _ := os.ReadFile(path); !strings.Contains(string(got), "otro") || obs.ContainerId == first {
		t.Fatalf("fichero = %q, contenedor %s", got, obs.ContainerId)
	}
	// Si alguien lo borra, la siguiente pasada lo repone (Docker crearía un directorio en su lugar).
	_ = os.Remove(path)
	m.Reconcile(ctx)
	if _, err := os.Stat(path); err != nil {
		t.Fatal("el fichero se repone")
	}
	// Sin lista, el fichero sobra.
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true})
	m.Reconcile(ctx)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("sin lista no queda fichero: %v", err)
	}
	if c := fake.Containers[m.Reconcile(ctx).ContainerId]; len(c.HostConfig.Binds) != 1 {
		t.Fatalf("binds = %v", c.HostConfig.Binds)
	}
}
