//go:build integration

package router

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

// handshake es un handshake de Minecraft (estado 1, status) hacia addr:port, como lo envía un
// cliente: mc-router lo lee para elegir el servidor por addr.
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
	varint(&body, 0x00) // id del paquete
	varint(&body, 769)  // protocolo (1.21.4)
	varint(&body, len(addr))
	body.WriteString(addr)
	_ = binary.Write(&body, binary.BigEndian, port)
	varint(&body, 1) // siguiente estado: status
	var pkt bytes.Buffer
	varint(&pkt, body.Len())
	pkt.Write(body.Bytes())
	return pkt.Bytes()
}

// dialRouter conecta al router con el hostname dado y devuelve lo que responde el backend.
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

// loginRouter envía un handshake de login (estado 2) y el Login Start con el nombre del jugador, como
// un cliente que intenta entrar; mc-router lo usa para la lista del autoscale.
func loginRouter(t *testing.T, port int, host, player string) string {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 2*time.Second)
	if err != nil {
		return ""
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	hs := handshake(host, uint16(port))
	hs[len(hs)-1] = 2 // siguiente estado: login
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

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestRouterRoutesByHostname levanta un mc-router real (mcsm-test-router-…) y dos backends
// (alpine con nc que responden su nombre) con etiquetas mc-router.host, y comprueba que cada
// hostname llega a su backend por el puerto del router. Solo recursos mcsm-test-*; se borran.
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
	for _, be := range []struct{ name, host string }{{"backend-a", "survival.lan"}, {"backend-b", "creativo.lan"}} {
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
	m := New(eng, st, Options{Name: name, Network: netName, FilesDir: t.TempDir()})
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

	// Sondeo de un recurso externo (descubrimiento de mc-router, límite de 1 conexión/s): aquí sí se espera.
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
	for _, want := range []struct{ host, reply string }{{"survival.lan", "backend-a"}, {"creativo.lan", "backend-b"}} {
		if got := poll(want.host, want.reply); !strings.Contains(got, want.reply) {
			t.Fatalf("%s respondió %q, se esperaba %s", want.host, got, want.reply)
		}
	}
	<-time.After(time.Second) // límite de conexiones de mc-router
	if got := dialRouter(t, port, "desconocido.lan"); strings.Contains(got, "backend") {
		t.Fatalf("un hostname sin servidor no debe llegar a ninguno: %q", got)
	}

	// Autoscale con lista de jugadores (S3): un intruso no despierta un servidor dormido; un jugador
	// de la lista sí. backend-a es el primero creado.
	if err := m.Apply(&mcsmv1.RouterSpec{HostPort: uint32(port), Autoscale: true, AutoscaleAllowPlayers: []string{"amigo"}}); err != nil {
		t.Fatal(err)
	}
	obs = m.Reconcile(ctx)
	if obs.ContainerId != "" {
		created = append(created, obs.ContainerId)
	}
	if obs.State != "running" || obs.Error != "" {
		t.Fatalf("con autoscale y lista: %+v", obs)
	}
	backendA := created[0]
	if err := eng.Stop(ctx, backendA, time.Second); err != nil {
		t.Fatal(err)
	}
	running := func() bool {
		ins, err := eng.Inspect(ctx, backendA)
		return err == nil && ins.Running
	}
	for i := 0; i < 5; i++ { // un intento por segundo durante 5 s
		_ = loginRouter(t, port, "survival.lan", "intruso")
		<-time.After(time.Second)
		if running() {
			t.Fatal("un jugador fuera de la lista no debe despertar el servidor")
		}
	}
	woke := false
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline) && !woke; {
		_ = loginRouter(t, port, "survival.lan", "amigo")
		<-time.After(time.Second)
		woke = running()
	}
	if !woke {
		t.Fatal("un jugador de la lista despierta el servidor")
	}

	if err := m.Clear(); err != nil {
		t.Fatal(err)
	}
	if obs := m.Reconcile(ctx); obs.State != "missing" || obs.Error != "" {
		t.Fatalf("tras Clear: %+v", obs)
	}
}
