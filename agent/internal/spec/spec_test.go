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
		t.Error("tty/openstdin must be true")
	}
	if got := b.HostConfig.Binds; len(got) != 1 || got[0] != "/srv/minecraft/survival/data:/data" {
		t.Errorf("binds = %v", got)
	}
	if b.Config.Labels[LabelManaged] != "true" || b.Config.Labels[LabelServerID] != meta.ServerID ||
		b.Config.Labels[LabelSlug] != "survival" || b.Config.Labels[LabelVersion] != "3" || b.Config.Labels[LabelHash] != b.Hash {
		t.Errorf("labels = %v", b.Config.Labels)
	}
	if _, ok := b.Networking.EndpointsConfig["mcsm"]; !ok {
		t.Error("the mcsm network is missing")
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
			t.Fatalf("env is not sorted: %v", b.Config.Env)
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
		t.Error("RCON must not be published")
	}
}

func TestHashStability(t *testing.T) {
	s := loadFixture(t)
	a, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	b, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if a.Hash != b.Hash {
		t.Error("the hash must be deterministic")
	}
	m2 := meta
	m2.Version = 99
	c, _ := BuildContainer(m2, s, "/srv/minecraft", "mcsm")
	if c.Hash != a.Hash {
		t.Error("changing only the version must not change the hash")
	}
	s.Memory = "6G"
	s.Resources.MemLimit = "7G"
	d, _ := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if d.Hash == a.Hash {
		t.Error("changing the memory must change the hash")
	}
}

func TestValidation(t *testing.T) {
	base := loadFixture(t)
	cases := []struct {
		name string
		mut  func(*Spec, *Meta)
		want string
	}{
		{"invalid slug", func(_ *Spec, m *Meta) { m.Slug = "Mi Server" }, "slug"},
		{"reserved env", func(s *Spec, _ *Meta) { s.Env["RCON_PASSWORD"] = "x" }, "reserved"},
		{"reserved TYPE env", func(s *Spec, _ *Meta) { s.Env["TYPE"] = "FORGE" }, "reserved"},
		{"invalid memory", func(s *Spec, _ *Meta) { s.Memory = "lots" }, "memory"},
		{"memLimit less than memory", func(s *Spec, _ *Meta) { s.Resources.MemLimit = "2G" }, "memLimit"},
		{"port out of range", func(s *Spec, _ *Meta) { s.Ports.Game = 70000 }, "port"},
		{"invalid proto", func(s *Spec, _ *Meta) { s.Ports.Extra[0].Proto = "icmp" }, "proto"},
		{"empty rcon", func(s *Spec, _ *Meta) { s.RconPassword = "" }, "rconPassword"},
		{"invalid restart", func(s *Spec, _ *Meta) { s.RestartPolicy = "always" }, "restartPolicy"},
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
				t.Fatalf("err = %v, want it to contain %q", err, tc.want)
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
		t.Errorf("default restart = %q", b.HostConfig.RestartPolicy.Name)
	}
	if b.HostConfig.Resources.Memory != 3*1024*1024*1024 {
		t.Errorf("without memLimit the limit is memory + 1G (spec §4.1), memory=%d", b.HostConfig.Resources.Memory)
	}
}

// HostConfig table: default isolation (M1/L4 of the audit). Changing this
// output recreates all containers when the agent is updated.
func TestHostConfigHardening(t *testing.T) {
	cases := []struct {
		name     string
		memory   string
		memLimit string
		want     int64
	}{
		{"without memLimit: memory + 1G", "2G", "", 3 << 30},
		{"without memLimit in MiB", "512M", "", (512 << 20) + (1 << 30)},
		{"explicit memLimit", "4G", "5G", 5 << 30},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := loadFixture(t)
			s.Memory, s.Resources.MemLimit = tc.memory, tc.memLimit
			b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
			if err != nil {
				t.Fatal(err)
			}
			h := b.HostConfig
			if h.Resources.Memory != tc.want {
				t.Errorf("memory = %d, want %d", h.Resources.Memory, tc.want)
			}
			if h.Resources.PidsLimit == nil || *h.Resources.PidsLimit != 4096 {
				t.Errorf("pidsLimit = %v, want 4096", h.Resources.PidsLimit)
			}
			if strings.Join(h.SecurityOpt, ",") != "no-new-privileges:true" {
				t.Errorf("securityOpt = %v", h.SecurityOpt)
			}
			if strings.Join(h.CapDrop, ",") != "ALL" {
				t.Errorf("capDrop = %v", h.CapDrop)
			}
			// Minimum with which itzg's entrypoint (chown of /data and switch to uid 1000)
			// starts and reaches healthy (tested against the real image).
			if strings.Join(h.CapAdd, ",") != "CHOWN,DAC_OVERRIDE,FOWNER,SETGID,SETUID" {
				t.Errorf("capAdd = %v", h.CapAdd)
			}
			if h.Privileged || h.NetworkMode != "" || len(h.Devices) != 0 {
				t.Errorf("no extra privileges: %+v", h)
			}
		})
	}
}

// The hash is computed over a canonical form of its own, not over the JSON of moby's
// types: pinning it detects any unintended change (which would recreate all the
// LAN's containers when the agent is updated). If it changes on purpose, bump hashSchema.
func TestHashGolden(t *testing.T) {
	b, err := BuildContainer(meta, loadFixture(t), "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	const golden = "09ff6e5490b40677"
	if b.Hash != golden {
		t.Fatalf("hash = %s, want %s: did BuildContainer's or hashInput's output change?", b.Hash, golden)
	}
}

func TestHashCoversWhatDefinesTheContainer(t *testing.T) {
	base := loadFixture(t)
	h := func(mut func(*Spec), dataRoot, net string) string {
		t.Helper()
		s := base
		s.Env = map[string]string{}
		for k, v := range base.Env {
			s.Env[k] = v
		}
		if mut != nil {
			mut(&s)
		}
		b, err := BuildContainer(meta, s, dataRoot, net)
		if err != nil {
			t.Fatal(err)
		}
		return b.Hash
	}
	ref := h(nil, "/srv/minecraft", "mcsm")
	for name, got := range map[string]string{
		"network":   h(nil, "/srv/minecraft", "other"),
		"DATA_ROOT": h(nil, "/srv/other", "mcsm"),
		"imagen":    h(func(s *Spec) { s.ImageTag = "java17" }, "/srv/minecraft", "mcsm"),
		"env":       h(func(s *Spec) { s.Env["X"] = "1" }, "/srv/minecraft", "mcsm"),
		"cpus":      h(func(s *Spec) { s.Resources.Cpus = 3 }, "/srv/minecraft", "mcsm"),
		"restart":   h(func(s *Spec) { s.RestartPolicy = "always" }, "/srv/minecraft", "mcsm"),
		"ports":     h(func(s *Spec) { s.Ports.Game = 25570 }, "/srv/minecraft", "mcsm"),
	} {
		if got == ref {
			t.Errorf("changing %s must change the hash", name)
		}
	}
}

func TestValidacionEndurecida(t *testing.T) {
	base := loadFixture(t)
	cases := []struct {
		name string
		mut  func(*Spec)
		want string // "" = must be accepted
	}{
		{"env TYPE=X rejected", func(s *Spec) { s.Env = map[string]string{"TYPE=X": "y"} }, "name"},
		{"env with space rejected", func(s *Spec) { s.Env = map[string]string{"A B": "y"} }, "name"},
		{"empty env rejected", func(s *Spec) { s.Env = map[string]string{"": "y"} }, "name"},
		{"env starting with a digit rejected", func(s *Spec) { s.Env = map[string]string{"1A": "y"} }, "name"},
		{"valid env accepted", func(s *Spec) { s.Env = map[string]string{"USE_AIKAR_FLAGS": "true"} }, ""},
		{"extra port 25575/tcp rejected", func(s *Spec) {
			s.Ports.Extra = []PortMapping{{Host: 25575, Container: 25575, Proto: "tcp"}}
		}, "RCON"},
		{"extra port 25575/udp rejected", func(s *Spec) {
			s.Ports.Extra = []PortMapping{{Host: 19999, Container: 25575, Proto: "udp"}}
		}, "RCON"},
		{"memory 4096 rejected", func(s *Spec) { s.Memory = "4096" }, "memory"},
		{"memory 4GB rejected", func(s *Spec) { s.Memory = "4GB" }, "memory"},
		{"memory 0G rejected", func(s *Spec) { s.Memory = "0G" }, "memory"},
		{"memory 512M accepted", func(s *Spec) { s.Memory = "512M" }, ""},
		{"memory 4g accepted", func(s *Spec) { s.Memory = "4g" }, ""},
		{"memLimit 4096 rejected", func(s *Spec) { s.Resources.MemLimit = "4096" }, "memLimit"},
		{"property with = in the key rejected", func(s *Spec) { s.Properties = map[string]string{"a=b": "x"} }, "property"},
		{"property with a line break in the value rejected", func(s *Spec) {
			s.Properties = map[string]string{"motd": "x\nrcon.password=y"}
		}, "property"},
		{"property with a carriage return in the value rejected", func(s *Spec) {
			s.Properties = map[string]string{"motd": "x\ry"}
		}, "property"},
		{"reserved rcon.password property", func(s *Spec) { s.Properties = map[string]string{"rcon.password": "y"} }, "reserved"},
		{"reserved server-port property", func(s *Spec) { s.Properties = map[string]string{"server-port": "1"} }, "reserved"},
		{"reserved enable-rcon property", func(s *Spec) { s.Properties = map[string]string{"enable-rcon": "true"} }, "reserved"},
		{"reserved rcon.port property", func(s *Spec) { s.Properties = map[string]string{"rcon.port": "1"} }, "reserved"},
		{"imageTag java21 accepted", func(s *Spec) { s.ImageTag = "java21" }, ""},
		{"imageTag with dot and dash accepted", func(s *Spec) { s.ImageTag = "2024.10.0-java21-graalvm" }, ""},
		{"empty imageTag accepted (latest)", func(s *Spec) { s.ImageTag = "" }, ""},
		{"imageTag with path rejected", func(s *Spec) { s.ImageTag = "x/../../containers/abc" }, "imageTag"},
		{"imageTag with colon rejected", func(s *Spec) { s.ImageTag = "a:b" }, "imageTag"},
		{"imageTag with space rejected", func(s *Spec) { s.ImageTag = "a b" }, "imageTag"},
		{"imageTag starting with a dash rejected", func(s *Spec) { s.ImageTag = "-x" }, "imageTag"},
		{"imageTag starting with a dot rejected", func(s *Spec) { s.ImageTag = ".x" }, "imageTag"},
		{"imageTag starting with an underscore rejected", func(s *Spec) { s.ImageTag = "_x" }, "imageTag"},
		{"imageTag of 128 accepted", func(s *Spec) { s.ImageTag = strings.Repeat("a", 128) }, ""},
		{"imageTag of 129 rejected", func(s *Spec) { s.ImageTag = strings.Repeat("a", 129) }, "imageTag"},
		{"valid properties accepted", func(s *Spec) {
			s.Properties = map[string]string{"max-players": "10", "motd": "Hola", "level-name": "world"}
		}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := base
			tc.mut(&s)
			err := s.Validate()
			if tc.want == "" {
				if err != nil {
					t.Fatalf("should not have failed: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

func TestValidSlug(t *testing.T) {
	for s, want := range map[string]bool{"alpha": true, "a-1": true, "": false, ".": false, "..": false, "a/b": false, "-a": false, "A": false, strings.Repeat("a", 41): false, strings.Repeat("a", 40): true} {
		if got := ValidSlug(s); got != want {
			t.Errorf("ValidSlug(%q) = %v, want %v", s, got, want)
		}
	}
}
