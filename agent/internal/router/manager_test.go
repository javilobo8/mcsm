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
	m := New(fake, st, Options{Network: "mcsm", ProxySocket: "/srv/minecraft/.mcsm-router/docker.sock",
		Now: func() time.Time { return time.UnixMilli(1000) }, FilesDir: filepath.Join(t.TempDir(), ".mcsm-router")})
	return m, fake, st
}

// routerContainer returns the fake's router container (nil if there is none).
func routerContainer(t *testing.T, fake *docker.Fake) *docker.Container {
	t.Helper()
	list, _ := fake.ListManaged(context.Background())
	var found *docker.Container
	for i := range list {
		if list[i].Labels[LabelRouter] == "true" {
			if found != nil {
				t.Fatal("there are two router containers")
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
		t.Fatalf("container = %+v", c)
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
			t.Fatalf("a second pass does not touch Docker: %v", fake.Calls[before:])
		}
	}
}

func TestReconcileRecoversManualChanges(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	m.Reconcile(ctx)

	// Stopped by hand: it is started.
	c := routerContainer(t, fake)
	_ = fake.Stop(ctx, c.ID, time.Second)
	if obs := m.Reconcile(ctx); obs.State != "running" {
		t.Fatalf("after stopping by hand: %+v", obs)
	}
	// Deleted by hand: it is recreated.
	_ = fake.Remove(ctx, c.ID)
	obs := m.Reconcile(ctx)
	if obs.State != "running" || obs.ContainerId == c.ID {
		t.Fatalf("after deleting by hand: %+v", obs)
	}
}

// TestReconcileDuringManualRemoval: a manual `docker rm -f` emits kill and die before destroy, and the
// pass they trigger finds the router half-deleted (the list gives it as exited). It is not a failure:
// no attempt is made to start it (Docker rejects it) and the destroy's pass recreates it without waiting for RetryAfter.
func TestReconcileDuringManualRemoval(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	first := m.Reconcile(ctx).ContainerId

	fake.BeginRemoval(first)
	before := len(fake.Calls)
	if obs := m.Reconcile(ctx); obs.Error != "" { // die event
		t.Fatalf("a half-deleted router is not a failure: %+v", obs)
	}
	for _, call := range fake.Calls[before:] {
		if strings.HasPrefix(call, "Start") || strings.HasPrefix(call, "Remove") || strings.HasPrefix(call, "Create") {
			t.Fatalf("with the deletion in progress the container is not touched: %v", fake.Calls[before:])
		}
	}
	fake.FinishRemoval(first)
	obs := m.Reconcile(ctx) // destroy event, at the same instant (fixed Now)
	if obs.Error != "" || obs.State != "running" || obs.ContainerId == "" || obs.ContainerId == first {
		t.Fatalf("after the destroy it is recreated immediately: %+v", obs)
	}
}

func TestReconcilePortBusy(t *testing.T) {
	m, fake, _ := newManager(t)
	now := time.UnixMilli(1000)
	m.opts.Now = func() time.Time { return now }
	ctx := context.Background()
	// A foreign container already publishes the host's 25565.
	port := network.MustParsePort("25565/tcp")
	other, err := fake.Create(ctx, "foreign", &container.Config{Image: "x"},
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
	// The container that could not start is deleted: Docker would start it later without publishing the port.
	if routerContainer(t, fake) != nil {
		t.Fatal("the failed container is not kept")
	}
	// With the same spec it is not retried before RetryAfter (the failure's events do not loop).
	if obs := m.Reconcile(ctx); obs.Error == "" || calls(fake, "Create mcsm-router") != 1 {
		t.Fatalf("immediate retry: %+v, created %d", obs, calls(fake, "Create mcsm-router"))
	}
	// Once RetryAfter has passed with the port free, it starts.
	_ = fake.Stop(ctx, other, time.Second)
	now = now.Add(RetryAfter)
	if obs := m.Reconcile(ctx); obs.State != "running" || obs.Error != "" {
		t.Fatalf("after freeing the port: %+v", obs)
	}
	// A new spec is tried immediately, even if the last attempt failed.
	port2 := network.MustParsePort("25570/tcp")
	other2, _ := fake.Create(ctx, "foreign2", &container.Config{Image: "x"},
		&container.HostConfig{PortBindings: network.PortMap{port2: {{HostPort: "25570"}}}}, nil)
	_ = fake.Start(ctx, other2)
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25570})
	if obs := m.Reconcile(ctx); !strings.Contains(obs.Error, "25570") {
		t.Fatalf("25570 is taken: %+v", obs)
	}
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25590})
	if obs := m.Reconcile(ctx); obs.State != "running" || obs.HostPort != 25590 || obs.Error != "" {
		t.Fatalf("on another port: %+v", obs)
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
		t.Fatal("the previous container is deleted")
	}
	if !strings.Contains(strings.Join(fake.Containers[obs.ContainerId].Config.Cmd, " "), "-auto-scale-up") {
		t.Fatal("the new one carries the autoscale")
	}

	// A router from an earlier agent version (another image, another hash) is replaced.
	c := fake.Containers[obs.ContainerId]
	c.Config.Image = "itzg/mc-router:1.0.0"
	c.Config.Labels[LabelHash] = "obsolete"
	obs = m.Reconcile(ctx)
	if obs.ContainerId == c.ID || fake.Containers[obs.ContainerId].Config.Image != ImageRef() {
		t.Fatalf("image update: %+v", obs)
	}
}

func TestReconcileWithoutSpecRemoves(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	if obs := m.Reconcile(ctx); obs.Configured || obs.State != "missing" || len(fake.Calls) != 0 {
		t.Fatalf("without a spec or container Docker is not touched: %+v %v", obs, fake.Calls)
	}
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	m.Reconcile(ctx)
	if err := m.Clear(); err != nil {
		t.Fatal(err)
	}
	obs := m.Reconcile(ctx)
	if obs.Configured || obs.State != "missing" || obs.Error != "" || routerContainer(t, fake) != nil {
		t.Fatalf("after Clear: %+v", obs)
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
		t.Fatal("the router never deletes a server")
	}
}

func TestReconcileNameConflict(t *testing.T) {
	m, fake, _ := newManager(t)
	ctx := context.Background()
	// A user's container named mcsm-router, without our labels: it is not touched.
	foreign, _ := fake.Create(ctx, "mcsm-router", &container.Config{Image: "other"}, &container.HostConfig{}, nil)
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	obs := m.Reconcile(ctx)
	if !strings.Contains(obs.Error, "mcsm-router") || obs.State != "missing" {
		t.Fatalf("observed = %+v", obs)
	}
	if _, ok := fake.Containers[foreign]; !ok {
		t.Fatal("the foreign container remains")
	}
}

func TestApplyValidatesAndRestartKeepsState(t *testing.T) {
	m, fake, st := newManager(t)
	if err := m.Apply(&mcsmv1.RouterSpec{HostPort: 0}); err == nil {
		t.Fatal("port 0 invalid")
	}
	if sp, _ := st.RouterSpec(); sp != nil {
		t.Fatal("an invalid spec is not stored")
	}
	if err := m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}); err != nil {
		t.Fatal(err)
	}
	if !m.Autoscale() {
		t.Fatal("autoscale")
	}
	// Agent restart: another Manager over the same store remembers the spec and recreates what is missing.
	m2 := New(fake, st, Options{Network: "mcsm", ProxySocket: "/srv/minecraft/.mcsm-router/docker.sock"})
	if !m2.Autoscale() {
		t.Fatal("the autoscale is loaded from the store")
	}
	if obs := m2.Reconcile(context.Background()); obs.State != "running" {
		t.Fatalf("observed = %+v", obs)
	}
	_ = m2.Clear()
	if m2.Autoscale() {
		t.Fatal("Clear removes the autoscale")
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
		t.Fatalf("created = %d", n)
	}
}

// Docker 29.7.2: if the restart policy (or someone) tried to start the router with the port
// taken, the following starts do not publish the port. The router is recreated, whether it
// finds it stopped (it would start it without the port) or already running without it.
func TestReconcileRecreatesRouterLeftWithoutPorts(t *testing.T) {
	for _, alreadyRunning := range []bool{false, true} {
		m, fake, _ := newManager(t)
		ctx := context.Background()
		_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
		first := m.Reconcile(ctx).ContainerId
		_ = fake.Stop(ctx, first, time.Second) // the host restarts
		port := network.MustParsePort("25565/tcp")
		other, _ := fake.Create(ctx, "foreign", &container.Config{Image: "x"},
			&container.HostConfig{PortBindings: network.PortMap{port: {{HostPort: "25565"}}}}, nil)
		_ = fake.Start(ctx, other)
		if err := fake.Start(ctx, first); err == nil { // unless-stopped with the port taken
			t.Fatal("the port is taken")
		}
		_ = fake.Stop(ctx, other, time.Second)
		if alreadyRunning {
			_ = fake.Start(ctx, first) // the policy tries again: running, without the port
		}
		obs := m.Reconcile(ctx)
		if obs.State != "running" || obs.Error != "" || obs.ContainerId == first {
			t.Fatalf("running=%v: %+v", alreadyRunning, obs)
		}
		if ins, _ := fake.Inspect(ctx, obs.ContainerId); ins.PortsMissing {
			t.Fatalf("running=%v: the new router publishes the port", alreadyRunning)
		}
		if _, ok := fake.Containers[first]; ok {
			t.Fatalf("running=%v: the tainted one is deleted", alreadyRunning)
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
		t.Fatalf("file = %q", got)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o644 {
		t.Fatalf("mc-router (user 65532) must be able to read it: %v %v", fi, err)
	}
	if !slices.Equal(obs.Spec.GetAutoscaleAllowPlayers(), []string{"amigo"}) || !obs.Spec.GetAutoscale() {
		t.Fatalf("the applied spec travels in RouterObserved: %+v", obs.Spec)
	}
	first := obs.ContainerId

	// Another list: new file and recreated router (mc-router does not re-read it).
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"friend", "other"}})
	obs = m.Reconcile(ctx)
	if got, _ := os.ReadFile(path); !strings.Contains(string(got), "other") || obs.ContainerId == first {
		t.Fatalf("file = %q, container %s", got, obs.ContainerId)
	}
	// If someone deletes it, the next pass restores it (Docker would create a directory in its place).
	_ = os.Remove(path)
	m.Reconcile(ctx)
	if _, err := os.Stat(path); err != nil {
		t.Fatal("the file is restored")
	}
	// Without a list, the file is left over.
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true})
	m.Reconcile(ctx)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("without a list no file remains: %v", err)
	}
	if c := fake.Containers[m.Reconcile(ctx).ContainerId]; len(c.HostConfig.Binds) != 1 {
		t.Fatalf("binds = %v", c.HostConfig.Binds)
	}
}

func TestReconcileWaitsForTheProxy(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	fake := docker.NewFake()
	m := New(fake, st, Options{Network: "mcsm", ProxySocket: "/x/docker.sock", ProxyReady: func() error { return errors.New("not listening") }})
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	obs := m.Reconcile(context.Background())
	if !strings.Contains(obs.Error, "proxy") || routerContainer(t, fake) != nil {
		t.Fatalf("observed = %+v", obs)
	}
}

// m5: the proxy that starts listening (Run retries) deploys the router immediately: the RetryAfter wait
// is to not repeat a Docker failure with the same thing, not for a proxy that is already ready.
func TestReconcileDeploysAsSoonAsTheProxyListens(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	fake := docker.NewFake()
	ready := errors.New("not listening")
	m := New(fake, st, Options{Network: "mcsm", ProxySocket: "/x/docker.sock", ProxyReady: func() error { return ready },
		Now: func() time.Time { return time.UnixMilli(1000) }})
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	if obs := m.Reconcile(context.Background()); !strings.Contains(obs.Error, "proxy") {
		t.Fatalf("observed = %+v", obs)
	}
	ready = nil // without time passing
	if obs := m.Reconcile(context.Background()); obs.State != "running" || obs.Error != "" {
		t.Fatalf("observed = %+v", obs)
	}
}

// S2: if the proxy is not listening, a router of an earlier version (Plan 8's mounts the real Docker socket) does not
// stay running: it is deleted and the error remains in the router's state. One of this version (it mounts the
// proxy socket) is left alone.
func TestProxyNotReadyRemovesAnOldRouter(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	fake := docker.NewFake()
	ctx := context.Background()
	old, err := fake.Create(ctx, ContainerName, &container.Config{Labels: map[string]string{
		"mcsm.managed": "true", LabelRouter: "true", LabelHash: "plan-8-hash"}},
		&container.HostConfig{Binds: []string{HostSocket + ":" + HostSocket + ":ro"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.Start(ctx, old); err != nil {
		t.Fatal(err)
	}
	ready := errors.New("not listening")
	m := New(fake, st, Options{Network: "mcsm", ProxySocket: "/x/docker.sock", ProxyReady: func() error { return ready }})
	_ = m.Apply(&mcsmv1.RouterSpec{HostPort: 25565})
	obs := m.Reconcile(ctx)
	if !strings.Contains(obs.Error, "proxy") || obs.State != "missing" {
		t.Fatalf("observed = %+v", obs)
	}
	if _, ok := fake.Containers[old]; ok {
		t.Fatal("the router with Docker's real socket is deleted")
	}

	// One of this version (created with the proxy ready) stays even if the proxy stops listening.
	ready = nil
	m.failedAt = time.Time{} // without waiting for RetryAfter
	if obs := m.Reconcile(ctx); obs.State != "running" {
		t.Fatalf("observed = %+v", obs)
	}
	ready = errors.New("not listening")
	m.failedAt = time.Time{}
	if obs := m.Reconcile(ctx); !strings.Contains(obs.Error, "proxy") || obs.State != "running" {
		t.Fatalf("observed = %+v", obs)
	}
}
