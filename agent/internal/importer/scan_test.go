package importer

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	"mcsm/agent/internal/docker"
)

func mk(t *testing.T, f *docker.Fake, name, image string, labels map[string]string, env []string, hc *container.HostConfig) string {
	t.Helper()
	id, err := f.Create(context.Background(), name, &container.Config{Image: image, Labels: labels, Env: env}, hc, nil)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestScanListsOnlyForeignItzg(t *testing.T) {
	ctx := context.Background()
	f := docker.NewFake()
	f.ImageEnvs["itzg/minecraft-server:java21"] = []string{"PATH=/usr/bin", "TYPE=VANILLA", "UID=1000"}
	ext := mk(t, f, "survival", "itzg/minecraft-server:java21",
		map[string]string{"com.docker.compose.project": "casa", "com.docker.compose.service": "survival", "otra": "x"},
		[]string{"PATH=/usr/bin", "TYPE=PAPER", "UID=1000", "EULA=TRUE", "RCON_PASSWORD=s3cr3t-rcon", "MOTD=caf\xe9"},
		&container.HostConfig{
			Binds:         []string{"/home/lobo/mc/survival:/data", "/home/lobo/mc/mods:/mods:ro"},
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			Resources:     container.Resources{Memory: 4 << 30, NanoCPUs: 2e9},
			NetworkMode:   "casa_default",
			PortBindings: network.PortMap{
				network.MustParsePort("25565/tcp"): {{HostPort: "25565"}},
				network.MustParsePort("19132/udp"): {{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: "19132"}},
			},
		})
	if err := f.Start(ctx, ext); err != nil {
		t.Fatal(err)
	}
	mk(t, f, "mcsm-otro", "itzg/minecraft-server:java21", map[string]string{"mcsm.managed": "true"}, nil, &container.HostConfig{})
	mk(t, f, "web", "nginx:1.27", nil, nil, &container.HostConfig{})
	adopted := mk(t, f, "adoptado", "itzg/minecraft-server", nil, nil, &container.HostConfig{})

	list, err := Scan(ctx, f, func(id string) bool { return id == adopted })
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("candidatos = %v", list)
	}
	c := list[0]
	if c.ContainerId != ext || c.Name != "survival" || c.Image != "itzg/minecraft-server:java21" || c.State != "running" ||
		c.RestartPolicy != "unless-stopped" || c.MemoryLimitBytes != 4<<30 || c.NanoCpus != 2e9 || c.NetworkMode != "casa_default" {
		t.Fatalf("candidato = %+v", c)
	}
	wantEnv := map[string]string{"TYPE": "PAPER", "EULA": "TRUE", "RCON_PASSWORD": "s3cr3t-rcon", "MOTD": "caf�"}
	if !reflect.DeepEqual(c.Env, wantEnv) {
		t.Fatalf("env = %v (sin las variables idénticas a la imagen; UTF-8 saneado)", c.Env)
	}
	if !reflect.DeepEqual(c.Labels, map[string]string{"com.docker.compose.project": "casa", "com.docker.compose.service": "survival"}) {
		t.Fatalf("labels = %v", c.Labels)
	}
	if len(c.Ports) != 2 || c.Ports[0].ContainerPort != 19132 || c.Ports[0].HostIp != "" || c.Ports[1].HostPort != 25565 || c.Ports[1].Proto != "tcp" {
		t.Fatalf("ports = %v", c.Ports)
	}
	if len(c.Mounts) != 2 || c.Mounts[0].Destination != "/data" || !c.Mounts[0].ReadWrite || c.Mounts[1].ReadWrite {
		t.Fatalf("mounts = %v", c.Mounts)
	}
}

func TestScanWithoutImageEnvSendsAll(t *testing.T) {
	f := docker.NewFake()
	mk(t, f, "mc", "itzg/minecraft-server", nil, []string{"PATH=/usr/bin", "TYPE=PAPER"}, &container.HostConfig{})
	list, err := Scan(context.Background(), f, func(string) bool { return false })
	if err != nil || len(list) != 1 || !reflect.DeepEqual(list[0].Env, map[string]string{"PATH": "/usr/bin", "TYPE": "PAPER"}) {
		t.Fatalf("list = %v, %v", list, err)
	}
}

// goneEngine simula un contenedor borrado entre la lista y el inspect.
type goneEngine struct {
	*docker.Fake
	gone string
}

func (g goneEngine) InspectImport(ctx context.Context, id string) (*docker.ImportInfo, error) {
	if id == g.gone {
		return nil, docker.ErrNotFound
	}
	return g.Fake.InspectImport(ctx, id)
}

func TestScanSkipsContainerRemovedMidway(t *testing.T) {
	f := docker.NewFake()
	gone := mk(t, f, "a", "itzg/minecraft-server", nil, nil, &container.HostConfig{})
	keep := mk(t, f, "b", "itzg/minecraft-server", nil, nil, &container.HostConfig{})
	list, err := Scan(context.Background(), goneEngine{f, gone}, func(string) bool { return false })
	if err != nil || len(list) != 1 || list[0].ContainerId != keep {
		t.Fatalf("list = %v, %v", list, err)
	}
}

type failEngine struct{ *docker.Fake }

func (failEngine) ListAll(context.Context) ([]docker.Container, error) {
	return nil, errors.New("daemon caído")
}

func TestScanReportsListError(t *testing.T) {
	if _, err := Scan(context.Background(), failEngine{docker.NewFake()}, func(string) bool { return false }); err == nil {
		t.Fatal("un fallo de Docker se devuelve")
	}
}

func TestUserEnv(t *testing.T) {
	got := UserEnv([]string{"A=1", "B=2", "C=x=y", "MALA", "=v"}, []string{"A=1", "B=3"})
	want := map[string]string{"B": "2", "C": "x=y"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("UserEnv = %v", got)
	}
}
