package router

import (
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

func build(t *testing.T, sp *mcsmv1.RouterSpec) *Build {
	t.Helper()
	b, err := BuildContainer(sp, ContainerName, "mcsm", "/srv/minecraft/.mcsm-router/docker.sock", "/srv/minecraft/.mcsm-router")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestBuildContainer(t *testing.T) {
	b := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	// S1: el contenedor recibe el socket de Docker: la imagen va fijada por digest, no solo por tag.
	if b.Name != "mcsm-router" || b.Config.Image != "itzg/mc-router:1.47.1@sha256:177433dd91507339924d60205a19ae9a289afd0e69dbad54e1a55d497f7523f8" || ImageRef() != b.Config.Image {
		t.Fatalf("nombre/imagen = %s %s", b.Name, b.Config.Image)
	}
	// S4: el límite por defecto de mc-router (1 conexión/s, global) hace esperar a varios jugadores.
	if !slices.Equal(b.Config.Cmd, []string{"-in-docker", "-port", "25565", "-connection-rate-limit", "10"}) {
		t.Fatalf("cmd = %v", b.Config.Cmd)
	}
	if b.Config.Labels[spec.LabelManaged] != "true" || b.Config.Labels[LabelRouter] != "true" || b.Config.Labels[LabelHash] != b.Hash {
		t.Fatalf("etiquetas = %v", b.Config.Labels)
	}
	if _, ok := b.Config.Labels[spec.LabelServerID]; ok {
		t.Fatal("el router no es un servidor: sin mcsm.server_id")
	}
	binds := b.HostConfig.PortBindings
	if len(binds) != 1 || binds[network.MustParsePort("25565/tcp")][0].HostPort != "25565" {
		t.Fatalf("puertos = %v", binds)
	}
	if _, ok := b.Networking.EndpointsConfig["mcsm"]; !ok {
		t.Fatal("el router va en la red de los servidores")
	}
}

func TestBuildContainerHardening(t *testing.T) {
	h := build(t, &mcsmv1.RouterSpec{HostPort: 25565}).HostConfig
	if !slices.Equal(h.Binds, []string{"/srv/minecraft/.mcsm-router/docker.sock:/var/run/docker.sock"}) {
		t.Fatalf("binds = %v: solo el socket del proxy del agente, nunca el de Docker", h.Binds)
	}
	if !slices.Equal(h.CapDrop, []string{"ALL"}) || len(h.CapAdd) != 0 {
		t.Fatalf("caps = %v %v", h.CapDrop, h.CapAdd)
	}
	if !slices.Equal(h.SecurityOpt, []string{"no-new-privileges:true"}) || !h.ReadonlyRootfs || h.Privileged {
		t.Fatalf("seguridad = %v ro=%v priv=%v", h.SecurityOpt, h.ReadonlyRootfs, h.Privileged)
	}
	if len(h.GroupAdd) != 0 {
		t.Fatalf("groupAdd = %v: el socket del proxy es del usuario del router", h.GroupAdd)
	}
	if h.Resources.Memory != 256<<20 || h.Resources.PidsLimit == nil || *h.Resources.PidsLimit != 256 {
		t.Fatal("límites de memoria y procesos")
	}
	if h.RestartPolicy.Name != "unless-stopped" {
		t.Fatalf("restart = %v", h.RestartPolicy)
	}
	// S5: expuesto a la red y registra cada conexión: logs con rotación.
	if h.LogConfig.Type != "json-file" || h.LogConfig.Config["max-size"] != "10m" || h.LogConfig.Config["max-file"] != "3" {
		t.Fatalf("logs = %+v", h.LogConfig)
	}
	if u := build(t, &mcsmv1.RouterSpec{HostPort: 25565}).Config.User; u != "65532:65532" {
		t.Fatalf("usuario = %q: no root", u)
	}
}

func TestBuildContainerAutoscale(t *testing.T) {
	cmd := build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}).Config.Cmd
	joined := strings.Join(cmd, " ")
	for _, want := range []string{"-auto-scale-up", "-auto-scale-down", "-auto-scale-down-after 10m", "-auto-scale-asleep-motd"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cmd = %v: falta %s", cmd, want)
		}
	}
	cmd = build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleDownAfterMinutes: 30}).Config.Cmd
	if !strings.Contains(strings.Join(cmd, " "), "-auto-scale-down-after 30m") {
		t.Fatalf("cmd = %v", cmd)
	}
	// Los minutos sin autoscale no cambian nada (ni el hash).
	a := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	b := build(t, &mcsmv1.RouterSpec{HostPort: 25565, AutoscaleDownAfterMinutes: 30})
	if a.Hash != b.Hash {
		t.Fatal("sin autoscale, los minutos no cuentan")
	}
}

func TestBuildContainerHash(t *testing.T) {
	base := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	if again := build(t, &mcsmv1.RouterSpec{HostPort: 25565}); again.Hash != base.Hash {
		t.Fatal("el hash debe ser estable")
	}
	for name, other := range map[string]*Build{
		"puerto":    build(t, &mcsmv1.RouterSpec{HostPort: 25570}),
		"autoscale": build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}),
	} {
		if other.Hash == base.Hash {
			t.Errorf("%s debe cambiar el hash", name)
		}
	}
	sock, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "mcsm", "/otro/docker.sock", "/srv/minecraft/.mcsm-router")
	if err != nil || sock.Hash == base.Hash {
		t.Error("la ruta del socket debe cambiar el hash")
	}
	net, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "otra", "/srv/minecraft/.mcsm-router/docker.sock", "/srv/minecraft/.mcsm-router")
	if err != nil || net.Hash == base.Hash {
		t.Error("la red debe cambiar el hash")
	}
}

func TestValidate(t *testing.T) {
	many := make([]string, 1001)
	for i := range many {
		many[i] = "p" + strconv.Itoa(i)
	}
	for _, bad := range []*mcsmv1.RouterSpec{nil, {}, {HostPort: 70000}, {HostPort: 25565, AutoscaleDownAfterMinutes: 1441},
		{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"a b"}},
		{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"demasiado_largo_17"}},
		{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: many}} {
		if err := Validate(bad); err == nil {
			t.Errorf("%v debería ser inválida", bad)
		}
		if _, err := BuildContainer(bad, ContainerName, "mcsm", "/x/docker.sock", ""); err == nil {
			t.Errorf("BuildContainer(%v) debería fallar", bad)
		}
	}
	if err := Validate(&mcsmv1.RouterSpec{HostPort: 1, AutoscaleDownAfterMinutes: 1440}); err != nil {
		t.Fatal(err)
	}
}

// S3: con autoscale, cualquiera que llegue al puerto despierta servidores. Una lista de jugadores
// (nombre o UUID) limita quién despierta: mc-router la lee de un fichero (-auto-scale-allow-deny)
// que el agente escribe en el host y monta de solo lectura.
func TestBuildContainerAllowDeny(t *testing.T) {
	sp := &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"amigo", "0123456789ABCDEF0123456789abcdef"}}
	b := build(t, sp)
	if !strings.Contains(strings.Join(b.Config.Cmd, " "), "-auto-scale-allow-deny /etc/mc-router/allow-deny.json") {
		t.Fatalf("cmd = %v", b.Config.Cmd)
	}
	if !slices.Contains(b.HostConfig.Binds, "/srv/minecraft/.mcsm-router/allow-deny.json:/etc/mc-router/allow-deny.json:ro") || len(b.HostConfig.Binds) != 2 {
		t.Fatalf("binds = %v", b.HostConfig.Binds)
	}
	want := `{"global":{"allowlist":[{"name":"amigo"},{"uuid":"01234567-89ab-cdef-0123-456789abcdef"}]}}`
	if string(b.AllowDeny) != want || b.AllowDenyPath != "/srv/minecraft/.mcsm-router/allow-deny.json" {
		t.Fatalf("allow-deny = %s en %s", b.AllowDeny, b.AllowDenyPath)
	}
	other := build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"amigo"}})
	if other.Hash == b.Hash {
		t.Fatal("cambiar la lista recrea el router (mc-router no relee el fichero)")
	}
	// Sin autoscale la lista no cuenta (ni el hash); con autoscale y sin lista, sin fichero.
	plain := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	ignored := build(t, &mcsmv1.RouterSpec{HostPort: 25565, AutoscaleAllowPlayers: []string{"amigo"}})
	if ignored.Hash != plain.Hash || ignored.AllowDeny != nil {
		t.Fatal("sin autoscale la lista se ignora")
	}
	if open := build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}); open.AllowDeny != nil || len(open.HostConfig.Binds) != 1 {
		t.Fatalf("sin lista: %+v", open.HostConfig.Binds)
	}
	if _, err := BuildContainer(sp, ContainerName, "mcsm", "/x/docker.sock", ""); err == nil {
		t.Fatal("con lista hace falta el directorio del host")
	}
}

func TestBuildContainerNeedsProxySocket(t *testing.T) {
	if _, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "mcsm", "", "/x"); err == nil {
		t.Fatal("sin socket del proxy no hay router")
	}
}
