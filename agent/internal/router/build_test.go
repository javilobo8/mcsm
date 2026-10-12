package router

import (
	"slices"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

func build(t *testing.T, sp *mcsmv1.RouterSpec) *Build {
	t.Helper()
	b, err := BuildContainer(sp, ContainerName, "mcsm", 967)
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
	if !slices.Equal(h.Binds, []string{"/var/run/docker.sock:/var/run/docker.sock:ro"}) {
		t.Fatalf("binds = %v: solo el socket", h.Binds)
	}
	if !slices.Equal(h.CapDrop, []string{"ALL"}) || len(h.CapAdd) != 0 {
		t.Fatalf("caps = %v %v", h.CapDrop, h.CapAdd)
	}
	if !slices.Equal(h.SecurityOpt, []string{"no-new-privileges:true"}) || !h.ReadonlyRootfs || h.Privileged {
		t.Fatalf("seguridad = %v ro=%v priv=%v", h.SecurityOpt, h.ReadonlyRootfs, h.Privileged)
	}
	if !slices.Equal(h.GroupAdd, []string{"967"}) {
		t.Fatalf("groupAdd = %v: el grupo del socket", h.GroupAdd)
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
	gid, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "mcsm", 999)
	if err != nil || gid.Hash == base.Hash {
		t.Error("el grupo del socket debe cambiar el hash")
	}
	net, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "otra", 967)
	if err != nil || net.Hash == base.Hash {
		t.Error("la red debe cambiar el hash")
	}
}

func TestValidate(t *testing.T) {
	for _, bad := range []*mcsmv1.RouterSpec{nil, {}, {HostPort: 70000}, {HostPort: 25565, AutoscaleDownAfterMinutes: 1441}} {
		if err := Validate(bad); err == nil {
			t.Errorf("%v debería ser inválida", bad)
		}
		if _, err := BuildContainer(bad, ContainerName, "mcsm", 0); err == nil {
			t.Errorf("BuildContainer(%v) debería fallar", bad)
		}
	}
	if err := Validate(&mcsmv1.RouterSpec{HostPort: 1, AutoscaleDownAfterMinutes: 1440}); err != nil {
		t.Fatal(err)
	}
}
