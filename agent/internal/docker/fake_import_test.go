package docker

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

func TestFakeInspectImport(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	id, err := f.Create(ctx, "viejo",
		&container.Config{Image: "itzg/minecraft-server:java21", Env: []string{"A=1"}, Labels: map[string]string{"x": "y"}},
		&container.HostConfig{
			Binds:         []string{"/srv/viejo:/data", "/srv/mods:/mods:ro,z"},
			NetworkMode:   "bridge",
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyAlways},
			Resources:     container.Resources{Memory: 1 << 30, NanoCPUs: 1e9},
			PortBindings: network.PortMap{
				network.MustParsePort("25565/tcp"): {{HostPort: "25570"}},
				network.MustParsePort("19132/udp"): {{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: "19132"}},
			},
		},
		&network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{"casa_default": {}}})
	if err != nil {
		t.Fatal(err)
	}
	info, err := f.InspectImport(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	want := &ImportInfo{
		ID: id, Name: "viejo", Image: "itzg/minecraft-server:java21", ImageID: "itzg/minecraft-server:java21", State: "created",
		Env: []string{"A=1"}, Labels: map[string]string{"x": "y"},
		Ports:   []PortPublish{{ContainerPort: 19132, Proto: "udp", HostIP: "127.0.0.1", HostPort: 19132}, {ContainerPort: 25565, Proto: "tcp", HostPort: 25570}},
		Mounts:  []Mount{{Type: "bind", Source: "/srv/viejo", Destination: "/data", RW: true}, {Type: "bind", Source: "/srv/mods", Destination: "/mods", RW: false}},
		Restart: "always", Memory: 1 << 30, NanoCPUs: 1e9, NetworkMode: "bridge", Networks: []string{"casa_default"},
	}
	if !reflect.DeepEqual(info, want) {
		t.Fatalf("inspect =\n%+v\nwant\n%+v", info, want)
	}
	if _, err := f.InspectImport(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestFakeListAllIncludesForeign(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	managed, _ := f.Create(ctx, "mcsm-a", &container.Config{Image: "x", Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	foreign, _ := f.Create(ctx, "ajeno", &container.Config{Image: "y"}, &container.HostConfig{}, nil)
	all, err := f.ListAll(ctx)
	if err != nil || len(all) != 2 || all[0].ID != managed || all[1].ID != foreign || all[1].Name != "ajeno" {
		t.Fatalf("ListAll = %+v, %v", all, err)
	}
	if m, _ := f.ListManaged(ctx); len(m) != 1 {
		t.Fatalf("ListManaged sigue viendo solo los gestionados: %+v", m)
	}
}

func TestFakeConnectNetwork(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	id, _ := f.Create(ctx, "ajeno", &container.Config{Image: "y"}, &container.HostConfig{}, nil)
	if err := f.ConnectNetwork(ctx, "mcsm", id, []string{"mcsm-viejo"}); err != nil {
		t.Fatal(err)
	}
	if got := f.Containers[id].Aliases["mcsm"]; !reflect.DeepEqual(got, []string{"mcsm-viejo"}) {
		t.Fatalf("alias = %v", got)
	}
	info, _ := f.InspectImport(ctx, id)
	if !reflect.DeepEqual(info.Networks, []string{"mcsm"}) {
		t.Fatalf("networks = %v", info.Networks)
	}
	if err := f.ConnectNetwork(ctx, "mcsm", id, []string{"otro"}); err == nil {
		t.Fatal("conectar dos veces a la misma red debe fallar, como en Docker")
	}
	if err := f.ConnectNetwork(ctx, "mcsm", "nope", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	f.ConnectErr = errors.New("boom")
	if err := f.ConnectNetwork(ctx, "otra", id, nil); err == nil {
		t.Fatal("ConnectErr debe devolverse")
	}
	if n := len(f.Calls); f.Calls[n-1] != "ConnectNetwork otra "+id+" " {
		t.Fatalf("calls = %v", f.Calls)
	}
}

func TestFakeImageEnv(t *testing.T) {
	f := NewFake()
	f.ImageEnvs["itzg/minecraft-server:java21"] = []string{"PATH=/usr/bin", "UID=1000"}
	env, err := f.ImageEnv(context.Background(), "itzg/minecraft-server:java21")
	if err != nil || !reflect.DeepEqual(env, []string{"PATH=/usr/bin", "UID=1000"}) {
		t.Fatalf("env = %v, %v", env, err)
	}
	if _, err := f.ImageEnv(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}
