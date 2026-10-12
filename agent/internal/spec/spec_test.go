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
	if b.HostConfig.Resources.Memory != 3*1024*1024*1024 {
		t.Errorf("sin memLimit el límite es memory + 1G (spec §4.1), memory=%d", b.HostConfig.Resources.Memory)
	}
}

// Tabla del HostConfig: aislamiento por defecto (M1/L4 de la auditoría). Cambiar esta
// salida recrea todos los contenedores al actualizar el agente.
func TestHostConfigHardening(t *testing.T) {
	cases := []struct {
		name     string
		memory   string
		memLimit string
		want     int64
	}{
		{"sin memLimit: memory + 1G", "2G", "", 3 << 30},
		{"sin memLimit en MiB", "512M", "", (512 << 20) + (1 << 30)},
		{"memLimit explícito", "4G", "5G", 5 << 30},
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
			// Mínimo con el que el entrypoint de itzg (chown de /data y paso a uid 1000)
			// arranca y llega a healthy (probado contra la imagen real).
			if strings.Join(h.CapAdd, ",") != "CHOWN,DAC_OVERRIDE,FOWNER,SETGID,SETUID" {
				t.Errorf("capAdd = %v", h.CapAdd)
			}
			if h.Privileged || h.NetworkMode != "" || len(h.Devices) != 0 {
				t.Errorf("nada de privilegios extra: %+v", h)
			}
		})
	}
}

// El hash se calcula sobre una forma canónica propia, no sobre el JSON de los tipos de
// moby: fijarlo detecta cualquier cambio involuntario (que recrearía todos los
// contenedores de la LAN al actualizar el agente). Si cambia a propósito, sube hashSchema.
func TestHashGolden(t *testing.T) {
	b, err := BuildContainer(meta, loadFixture(t), "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	const golden = "09ff6e5490b40677"
	if b.Hash != golden {
		t.Fatalf("hash = %s, want %s: ¿cambió la salida de BuildContainer o hashInput?", b.Hash, golden)
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
		"red":       h(nil, "/srv/minecraft", "otra"),
		"DATA_ROOT": h(nil, "/srv/otro", "mcsm"),
		"imagen":    h(func(s *Spec) { s.ImageTag = "java17" }, "/srv/minecraft", "mcsm"),
		"env":       h(func(s *Spec) { s.Env["X"] = "1" }, "/srv/minecraft", "mcsm"),
		"cpus":      h(func(s *Spec) { s.Resources.Cpus = 3 }, "/srv/minecraft", "mcsm"),
		"restart":   h(func(s *Spec) { s.RestartPolicy = "always" }, "/srv/minecraft", "mcsm"),
		"puertos":   h(func(s *Spec) { s.Ports.Game = 25570 }, "/srv/minecraft", "mcsm"),
	} {
		if got == ref {
			t.Errorf("cambiar %s debe cambiar el hash", name)
		}
	}
}

func TestValidacionEndurecida(t *testing.T) {
	base := loadFixture(t)
	cases := []struct {
		name string
		mut  func(*Spec)
		want string // "" = debe aceptarse
	}{
		{"env TYPE=X rechazada", func(s *Spec) { s.Env = map[string]string{"TYPE=X": "y"} }, "nombre"},
		{"env con espacio rechazada", func(s *Spec) { s.Env = map[string]string{"A B": "y"} }, "nombre"},
		{"env vacía rechazada", func(s *Spec) { s.Env = map[string]string{"": "y"} }, "nombre"},
		{"env que empieza por dígito rechazada", func(s *Spec) { s.Env = map[string]string{"1A": "y"} }, "nombre"},
		{"env válida aceptada", func(s *Spec) { s.Env = map[string]string{"USE_AIKAR_FLAGS": "true"} }, ""},
		{"puerto extra 25575/tcp rechazado", func(s *Spec) {
			s.Ports.Extra = []PortMapping{{Host: 25575, Container: 25575, Proto: "tcp"}}
		}, "RCON"},
		{"puerto extra 25575/udp rechazado", func(s *Spec) {
			s.Ports.Extra = []PortMapping{{Host: 19999, Container: 25575, Proto: "udp"}}
		}, "RCON"},
		{"memoria 4096 rechazada", func(s *Spec) { s.Memory = "4096" }, "memory"},
		{"memoria 4GB rechazada", func(s *Spec) { s.Memory = "4GB" }, "memory"},
		{"memoria 0G rechazada", func(s *Spec) { s.Memory = "0G" }, "memory"},
		{"memoria 512M aceptada", func(s *Spec) { s.Memory = "512M" }, ""},
		{"memoria 4g aceptada", func(s *Spec) { s.Memory = "4g" }, ""},
		{"memLimit 4096 rechazado", func(s *Spec) { s.Resources.MemLimit = "4096" }, "memLimit"},
		{"propiedad con = en la clave rechazada", func(s *Spec) { s.Properties = map[string]string{"a=b": "x"} }, "propiedad"},
		{"propiedad con salto de línea en el valor rechazada", func(s *Spec) {
			s.Properties = map[string]string{"motd": "x\nrcon.password=y"}
		}, "propiedad"},
		{"propiedad con retorno de carro en el valor rechazada", func(s *Spec) {
			s.Properties = map[string]string{"motd": "x\ry"}
		}, "propiedad"},
		{"propiedad rcon.password reservada", func(s *Spec) { s.Properties = map[string]string{"rcon.password": "y"} }, "reservada"},
		{"propiedad server-port reservada", func(s *Spec) { s.Properties = map[string]string{"server-port": "1"} }, "reservada"},
		{"propiedad enable-rcon reservada", func(s *Spec) { s.Properties = map[string]string{"enable-rcon": "true"} }, "reservada"},
		{"propiedad rcon.port reservada", func(s *Spec) { s.Properties = map[string]string{"rcon.port": "1"} }, "reservada"},
		{"imageTag java21 aceptado", func(s *Spec) { s.ImageTag = "java21" }, ""},
		{"imageTag con punto y guion aceptado", func(s *Spec) { s.ImageTag = "2024.10.0-java21-graalvm" }, ""},
		{"imageTag vacío aceptado (latest)", func(s *Spec) { s.ImageTag = "" }, ""},
		{"imageTag con ruta rechazado", func(s *Spec) { s.ImageTag = "x/../../containers/abc" }, "imageTag"},
		{"imageTag con dos puntos rechazado", func(s *Spec) { s.ImageTag = "a:b" }, "imageTag"},
		{"imageTag con espacio rechazado", func(s *Spec) { s.ImageTag = "a b" }, "imageTag"},
		{"imageTag que empieza por guion rechazado", func(s *Spec) { s.ImageTag = "-x" }, "imageTag"},
		{"imageTag que empieza por punto rechazado", func(s *Spec) { s.ImageTag = ".x" }, "imageTag"},
		{"imageTag que empieza por guion bajo rechazado", func(s *Spec) { s.ImageTag = "_x" }, "imageTag"},
		{"imageTag de 128 aceptado", func(s *Spec) { s.ImageTag = strings.Repeat("a", 128) }, ""},
		{"imageTag de 129 rechazado", func(s *Spec) { s.ImageTag = strings.Repeat("a", 129) }, "imageTag"},
		{"propiedades válidas aceptadas", func(s *Spec) {
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
					t.Fatalf("no debía fallar: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want que contenga %q", err, tc.want)
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
