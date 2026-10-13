//go:build integration

package router

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/dockerproxy"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

// handshake is a Minecraft handshake (state 1, status) to addr:port, as a client
// sends it: mc-router reads it to choose the server by addr.
func handshake(addr string, port uint16) []byte {
	varint := func(b *bytes.Buffer, v int) {
		for {
			c := byte(v & 0x7f)
			v >>= 7
			if v != 0 {
				c |= 0x80
			}
			b.WriteByte(c)
			if v == 0 {
				return
			}
		}
	}
	var body bytes.Buffer
	varint(&body, 0x00) // packet id
	varint(&body, 769)  // protocol (1.21.4)
	varint(&body, len(addr))
	body.WriteString(addr)
	_ = binary.Write(&body, binary.BigEndian, port)
	varint(&body, 1) // next state: status
	var pkt bytes.Buffer
	varint(&pkt, body.Len())
	pkt.Write(body.Bytes())
	return pkt.Bytes()
}

// dialRouter connects to the router with the given hostname and returns what the backend answers.
func dialRouter(t *testing.T, port int, host string) string {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 2*time.Second)
	if err != nil {
		return ""
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = c.Write(handshake(host, uint16(port)))
	b, _ := io.ReadAll(c)
	return string(b)
}

// loginRouter sends a login handshake (state 2) and the Login Start with the player's name, like
// a client trying to join; mc-router uses it for the autoscale list.
func loginRouter(t *testing.T, port int, host, player string) string {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 2*time.Second)
	if err != nil {
		return ""
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	hs := handshake(host, uint16(port))
	hs[len(hs)-1] = 2 // next state: login
	var body bytes.Buffer
	body.WriteByte(0x00) // Login Start
	body.WriteByte(byte(len(player)))
	body.WriteString(player)
	body.Write(make([]byte, 16)) // UUID (1.20.2+)
	pkt := append([]byte{byte(body.Len())}, body.Bytes()...)
	_, _ = c.Write(append(hs, pkt...))
	b, _ := io.ReadAll(c)
	return string(b)
}

// syncBuffer is a bytes.Buffer safe for the proxy's log (its goroutines write to it).
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestRouterRoutesByHostname brings up a real mc-router (mcsm-test-router-…) and two backends
// (alpine with nc that answer their name) with mc-router.host labels, and checks that each
// hostname reaches its backend through the router's port. Only mcsm-test-* resources; they are deleted.
func TestRouterRoutesByHostname(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	eng, err := docker.NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	cli, err := client.New(client.FromEnv)
	if err != nil {
		t.Fatal(err)
	}
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	tag := hex.EncodeToString(suffix)
	netName := "mcsm-test-rnet-" + tag
	if err := eng.EnsureNetwork(ctx, netName); err != nil {
		t.Fatal(err)
	}
	var created []string
	t.Cleanup(func() {
		bg := context.Background()
		for _, id := range created {
			_ = eng.Remove(bg, id)
		}
		_, _ = cli.NetworkRemove(bg, netName, client.NetworkRemoveOptions{})
	})
	if err := eng.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	for _, be := range []struct{ name, host string }{{"backend-a", "survival.lan"}, {"backend-b", "creative.lan"}} {
		labels := map[string]string{"mcsm.test": "true", spec.LabelRouterHost: be.host, spec.LabelRouterNetwork: netName}
		id, err := eng.Create(ctx, "mcsm-test-r"+be.name+"-"+tag,
			&container.Config{Image: "alpine:3.22", Cmd: []string{"nc", "-lk", "-p", "25565", "-e", "echo", be.name}, Labels: labels},
			&container.HostConfig{}, &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{netName: {}}})
		if err != nil {
			t.Fatal(err)
		}
		created = append(created, id)
		if err := eng.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
	}

	st, err := store.Open(t.TempDir() + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	name := "mcsm-test-router-" + tag
	// plan-9: mc-router talks to Docker through the agent's allowlist proxy.
	// The router (user 65532) mounts the socket directory: it has to be able to traverse it, like the agent's .mcsm-router
	// (0755); t.TempDir creates it 0700.
	sockDir := t.TempDir()
	if err := os.Chmod(sockDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(sockDir, "docker.sock")
	var proxyLog syncBuffer
	// startProxy starts a proxy at sock (like the agent on startup) and returns how to stop it (like on shutdown:
	// the socket is deleted). The next agent's is another inode in the same directory.
	var pxMu sync.Mutex
	var px *dockerproxy.Proxy
	startProxy := func() (stop func()) {
		p := dockerproxy.New(dockerproxy.Options{Listen: sock, Upstream: HostSocket, UID: 65532, GID: 65532,
			Log: slog.New(slog.NewTextHandler(&proxyLog, nil)),
			Policy: func(ctx context.Context, op dockerproxy.Op, c string) error {
				ins, err := eng.Inspect(ctx, c)
				if err != nil {
					return err
				}
				if ins.Labels[spec.LabelRouterHost] == "" {
					return errors.New("no router hostname")
				}
				return nil
			}})
		if err := p.Listen(); err != nil {
			t.Fatal(err)
		}
		pctx, pcancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			p.Serve(pctx)
			close(done)
		}()
		pxMu.Lock()
		px = p
		pxMu.Unlock()
		return func() {
			pcancel()
			<-done
		}
	}
	stopProxy := startProxy()
	defer func() { stopProxy() }()
	proxyReady := func() error {
		pxMu.Lock()
		defer pxMu.Unlock()
		return px.Ready()
	}
	m := New(eng, st, Options{Name: name, Network: netName, FilesDir: t.TempDir(), ProxySocket: sock, ProxyReady: proxyReady})
	port := freePort(t)
	if err := m.Apply(&mcsmv1.RouterSpec{HostPort: uint32(port)}); err != nil {
		t.Fatal(err)
	}
	obs := m.Reconcile(ctx)
	if obs.ContainerId != "" {
		created = append(created, obs.ContainerId)
	}
	if obs.State != "running" || obs.Error != "" {
		t.Fatalf("observed = %+v", obs)
	}

	// Probing an external resource (mc-router discovery, 1 connection/s limit): waiting is appropriate here.
	poll := func(host, reply string) string {
		got := ""
		for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
			if got = dialRouter(t, port, host); strings.Contains(got, reply) {
				return got
			}
			select {
			case <-ctx.Done():
				return got
			case <-time.After(time.Second):
			}
		}
		return got
	}
	for _, want := range []struct{ host, reply string }{{"survival.lan", "backend-a"}, {"creative.lan", "backend-b"}} {
		if got := poll(want.host, want.reply); !strings.Contains(got, want.reply) {
			t.Fatalf("%s answered %q, expected %s", want.host, got, want.reply)
		}
	}
	<-time.After(time.Second) // mc-router's connection limit
	if got := dialRouter(t, port, "unknown.lan"); strings.Contains(got, "backend") {
		t.Fatalf("a hostname without a server must not reach any: %q", got)
	}

	// m5: the agent restarts (new proxy, another inode in the same directory): the router does NOT restart and mc-router
	// reconnects by itself; it sees a server created afterwards (events and list through the new proxy).
	routerID := obs.ContainerId
	insBefore, err := eng.Inspect(ctx, routerID)
	if err != nil {
		t.Fatal(err)
	}
	stopProxy()
	stopProxy = startProxy()
	if obs := m.Reconcile(ctx); obs.State != "running" || obs.Error != "" || obs.ContainerId != routerID {
		t.Fatalf("after a new proxy: %+v", obs)
	}
	labelsD := map[string]string{"mcsm.test": "true", spec.LabelRouterHost: "after-proxy.lan", spec.LabelRouterNetwork: netName}
	backendD, err := eng.Create(ctx, "mcsm-test-rbackend-d-"+tag,
		&container.Config{Image: "alpine:3.22", Cmd: []string{"nc", "-lk", "-p", "25565", "-e", "echo", "backend-d"}, Labels: labelsD},
		&container.HostConfig{}, &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{netName: {}}})
	if err != nil {
		t.Fatal(err)
	}
	created = append(created, backendD)
	if err := eng.Start(ctx, backendD); err != nil {
		t.Fatal(err)
	}
	got := ""
	for deadline := time.Now().Add(90 * time.Second); time.Now().Before(deadline) && !strings.Contains(got, "backend-d"); {
		<-time.After(time.Second)
		got = dialRouter(t, port, "after-proxy.lan")
	}
	if !strings.Contains(got, "backend-d") {
		t.Fatalf("after a new proxy, mc-router does not see a new server: %q", got)
	}
	if insAfter, err := eng.Inspect(ctx, routerID); err != nil || !insAfter.StartedAt.Equal(insBefore.StartedAt) {
		t.Fatalf("the router does not restart with a new proxy: %v → %+v %v", insBefore.StartedAt, insAfter, err)
	}
	if err := eng.Stop(ctx, backendD, time.Second); err != nil { // outside the autoscale checks
		t.Fatal(err)
	}

	// Autoscale with a player list (S3): an intruder does not wake a sleeping server; a player
	// on the list does. backend-a is the first created. Stops after 1 min without players.
	autoscale := func(players ...string) {
		t.Helper()
		if err := m.Apply(&mcsmv1.RouterSpec{HostPort: uint32(port), Autoscale: true, AutoscaleDownAfterMinutes: 1, AutoscaleAllowPlayers: players}); err != nil {
			t.Fatal(err)
		}
		obs := m.Reconcile(ctx)
		if obs.ContainerId != "" {
			created = append(created, obs.ContainerId)
		}
		if obs.State != "running" || obs.Error != "" {
			t.Fatalf("with autoscale and list: %+v", obs)
		}
	}
	isRunning := func(id string) bool {
		ins, err := eng.Inspect(ctx, id)
		return err == nil && ins.Running
	}
	// wake tries to join as player every second until id is running (max. 30 s).
	wake := func(host, player, id string) bool {
		for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
			_ = loginRouter(t, port, host, player)
			<-time.After(time.Second)
			if isRunning(id) {
				return true
			}
		}
		return false
	}
	autoscale("amigo")
	backendA := created[0]
	if err := eng.Stop(ctx, backendA, time.Second); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ { // one attempt per second for 5 s
		_ = loginRouter(t, port, "survival.lan", "intruder")
		<-time.After(time.Second)
		if isRunning(backendA) {
			t.Fatal("a player not on the list must not wake the server")
		}
	}
	if !wake("survival.lan", "amigo", backendA) {
		t.Fatal("a player on the list wakes the server")
	}

	// Changing the list recreates the router: sleeping servers are still woken up.
	if err := eng.Stop(ctx, backendA, time.Second); err != nil {
		t.Fatal(err)
	}
	autoscale("friend", "other")
	if !wake("survival.lan", "other", backendA) {
		t.Fatal("after recreating the router, a sleeping server wakes up")
	}

	// A freshly created on-demand server (also when releasing a reservation after parking it): mc-router
	// does not see a container that never started, so the agent starts it; mc-router puts it to sleep after a
	// minute without players and afterwards whoever joins wakes it.
	labels := map[string]string{"mcsm.test": "true", spec.LabelRouterHost: "new.lan", spec.LabelRouterNetwork: netName}
	fresh, err := eng.Create(ctx, "mcsm-test-rbackend-c-"+tag,
		&container.Config{Image: "alpine:3.22", Cmd: []string{"nc", "-lk", "-p", "25565", "-e", "echo", "backend-c"}, Labels: labels},
		&container.HostConfig{}, &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{netName: {}}})
	if err != nil {
		t.Fatal(err)
	}
	created = append(created, fresh)
	if err := eng.Start(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	slept := false
	for deadline := time.Now().Add(150 * time.Second); time.Now().Before(deadline) && !slept; {
		<-time.After(5 * time.Second)
		slept = !isRunning(fresh)
	}
	if !slept {
		t.Fatal("mc-router puts to sleep a server that started on its own and that nobody joins")
	}
	if !wake("new.lan", "friend", fresh) {
		t.Fatal("and afterwards a player on the list wakes it")
	}

	// What mc-router asked for and the proxy denied (if anything were missing, it would show up here).
	if l := proxyLog.String(); strings.Contains(l, "denied") || strings.Contains(l, "invalid filters") {
		t.Logf("mc-router requests denied by the proxy:\n%s", proxyLog.String())
	}

	// Nothing can be created through the proxy nor can a container's env be seen.
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
	res, err := hc.Post("http://docker/v1.47/containers/create", "application/json", strings.NewReader(`{"Image":"alpine:3.22"}`))
	if err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("create through the proxy: %v %v", res, err)
	}
	res.Body.Close()
	res, err = hc.Get("http://docker/v1.47/containers/" + created[0] + "/json")
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("inspect through the proxy: %v %v", res, err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if strings.Contains(string(body), `"Env"`) {
		t.Fatal("the inspect through the proxy carries no env")
	}
	// A container without mc-router.host (the router itself) does not exist for the router: neither in the inspect nor in the list.
	res, err = hc.Get("http://docker/v1.47/containers/" + name + "/json")
	if err != nil || res.StatusCode != http.StatusNotFound {
		t.Fatalf("inspect of a foreign container through the proxy: %v %v", res, err)
	}
	res.Body.Close()
	res, err = hc.Get("http://docker/v1.47/containers/json?all=1")
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("list through the proxy: %v %v", res, err)
	}
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if strings.Contains(string(body), name) || !strings.Contains(string(body), "backend-c") {
		t.Fatalf("the list through the proxy only brings the router's servers: %s", body)
	}

	if err := m.Clear(); err != nil {
		t.Fatal(err)
	}
	if obs := m.Reconcile(ctx); obs.State != "missing" || obs.Error != "" {
		t.Fatalf("after Clear: %+v", obs)
	}
}
