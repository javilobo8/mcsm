package spec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadFixture(t *testing.T) Spec {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "proto", "fixtures", "spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var meta = Meta{ServerID: "0190a1b2-0000-7000-8000-000000000001", Slug: "survival", Version: 3}

func TestBuildContainerBasics(t *testing.T) {
	s := loadFixture(t)
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if b.Name != "mcsm-survival" {
		t.Errorf("name = %q", b.Name)
	}
	if b.DataDir != "/srv/minecraft/survival/data" {
		t.Errorf("dataDir = %q", b.DataDir)
	}
	if b.Config.Image != "itzg/minecraft-server:java21" {
		t.Errorf("image = %q", b.Config.Image)
	}
	if !b.Config.Tty || !b.Config.OpenStdin {
		t.Error("tty/openstdin deben ser true")
	}
	if got := b.HostConfig.Binds; len(got) != 1 || got[0] != "/srv/minecraft/survival/data:/data" {
		t.Errorf("binds = %v", got)
	}
	if b.Config.Labels[LabelManaged] != "true" || b.Config.Labels[LabelServerID] != meta.ServerID ||
		b.Config.Labels[LabelSlug] != "survival" || b.Config.Labels[LabelVersion] != "3" || b.Config.Labels[LabelHash] != b.Hash {
		t.Errorf("labels = %v", b.Config.Labels)
	}
	if _, ok := b.Networking.EndpointsConfig["mcsm"]; !ok {
		t.Error("falta la red mcsm")
	}
	if b.HostConfig.RestartPolicy.Name != "unless-stopped" {
		t.Errorf("restart = %q", b.HostConfig.RestartPolicy.Name)
	}
	if b.HostConfig.Resources.Memory != 5*1024*1024*1024 || b.HostConfig.Resources.NanoCPUs != 2e9 {
		t.Errorf("resources = %+v", b.HostConfig.Resources)
	}
}

func envMap(env []string) map[string]string {
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

func TestBuildContainerEnv(t *testing.T) {
	s := loadFixture(t)
	b, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	env := envMap(b.Config.Env)
	want := map[string]string{
		"EULA": "TRUE", "TYPE": "PAPER", "VERSION": "1.21.4", "MEMORY": "4G",
		"ENABLE_RCON": "true", "RCON_PASSWORD": "s3cretpassw0rd", "RCON_PORT": "25575", "SERVER_PORT": "25565",
		"USE_AIKAR_FLAGS":          "true",
		"CUSTOM_SERVER_PROPERTIES": "difficulty=normal\nmax-players=10\nmotd=Servidor de casa",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	for i := 1; i < len(b.Config.Env); i++ {
		if b.Config.Env[i-1] > b.Config.Env[i] {
			t.Fatalf("env no está ordenado: %v", b.Config.Env)
		}
	}
}

func TestBuildContainerPorts(t *testing.T) {
	s := loadFixture(t)
	s.Ports.Game = 25570
	b, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	var seen []string
	for p, binds := range b.HostConfig.PortBindings {
		seen = append(seen, p.String()+"->"+binds[0].HostPort)
	}
	if len(seen) != 2 {
		t.Fatalf("bindings = %v", seen)
	}
	joined := strings.Join(seen, ",")
	if !strings.Contains(joined, "25565/tcp->25570") || !strings.Contains(joined, "19132/udp->19132") {
		t.Errorf("bindings = %v", seen)
	}
	if _, ok := b.HostConfig.PortBindings[mustPort("25575/tcp")]; ok {
		t.Error("RCON no debe publicarse")
	}
}

func TestHashStability(t *testing.T) {
	s := loadFixture(t)
	a, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	b, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if a.Hash != b.Hash {
		t.Error("el hash debe ser determinista")
	}
	m2 := meta
	m2.Version = 99
	c, _ := BuildContainer(m2, s, "/srv/minecraft", "mcsm")
	if c.Hash != a.Hash {
		t.Error("cambiar solo la versión no debe cambiar el hash")
	}
	s.Memory = "6G"
	s.Resources.MemLimit = "7G"
	d, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if d.Hash == a.Hash {
		t.Error("cambiar la memoria debe cambiar el hash")
	}
}

func TestValidation(t *testing.T) {
	base := loadFixture(t)
	cases := []struct {
		name string
		mut  func(*Spec, *Meta)
		want string
	}{
		{"slug inválido", func(_ *Spec, m *Meta) { m.Slug = "Mi Server" }, "slug"},
		{"env reservada", func(s *Spec, _ *Meta) { s.Env["RCON_PASSWORD"] = "x" }, "reservada"},
		{"env TYPE reservada", func(s *Spec, _ *Meta) { s.Env["TYPE"] = "FORGE" }, "reservada"},
		{"memoria inválida", func(s *Spec, _ *Meta) { s.Memory = "muchos" }, "memory"},
		{"memLimit menor que memory", func(s *Spec, _ *Meta) { s.Resources.MemLimit = "2G" }, "memLimit"},
		{"puerto fuera de rango", func(s *Spec, _ *Meta) { s.Ports.Game = 70000 }, "puerto"},
		{"proto inválido", func(s *Spec, _ *Meta) { s.Ports.Extra[0].Proto = "icmp" }, "proto"},
		{"rcon vacío", func(s *Spec, _ *Meta) { s.RconPassword = "" }, "rconPassword"},
		{"restart inválido", func(s *Spec, _ *Meta) { s.RestartPolicy = "siempre" }, "restartPolicy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := base
			s.Env = map[string]string{}
			for k, v := range base.Env {
				s.Env[k] = v
			}
			s.Ports.Extra = append([]PortMapping(nil), base.Ports.Extra...)
			m := meta
			tc.mut(&s, &m)
			_, err := BuildContainer(m, s, "/srv/minecraft", "mcsm")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want que contenga %q", err, tc.want)
			}
		})
	}
}

func TestDefaults(t *testing.T) {
	s, err := Parse([]byte(`{"type":"VANILLA","version":"LATEST","memory":"2G","ports":{"game":25565},"rconPassword":"abcdefgh"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if b.Config.Image != "itzg/minecraft-server:latest" {
		t.Errorf("image = %q", b.Config.Image)
	}
	if b.HostConfig.RestartPolicy.Name != "unless-stopped" {
		t.Errorf("restart por defecto = %q", b.HostConfig.RestartPolicy.Name)
	}
	if b.HostConfig.Resources.Memory != 0 {
		t.Error("sin memLimit no debe haber límite")
	}
}
