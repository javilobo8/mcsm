// Package spec define la especificación de un servidor y su traducción
// determinista a una configuración de contenedor Docker.
package spec

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	units "github.com/docker/go-units"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

const (
	LabelManaged  = "mcsm.managed"
	LabelServerID = "mcsm.server_id"
	LabelSlug     = "mcsm.slug"
	LabelVersion  = "mcsm.spec_version"
	LabelHash     = "mcsm.spec_hash"

	Image    = "itzg/minecraft-server"
	GamePort = 25565
	RconPort = 25575
)

// ReservedEnv son variables que genera el agente y que `env` no puede pisar.
var ReservedEnv = map[string]bool{
	"EULA": true, "TYPE": true, "VERSION": true, "MEMORY": true, "ENABLE_RCON": true,
	"RCON_PASSWORD": true, "RCON_PORT": true, "SERVER_PORT": true, "CUSTOM_SERVER_PROPERTIES": true,
}

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// sizeRe acepta tamaños de memoria en MiB o GiB enteros y positivos (512M, 4G).
var sizeRe = regexp.MustCompile(`^[1-9]\d*[MmGg]$`)

// envNameRe valida los nombres de variable de env (no pueden contener = ni espacios).
var envNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// propKeyRe valida las claves de server.properties.
var propKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

// ReservedProps son claves de server.properties que gestiona la imagen a partir
// de las variables reservadas; el usuario no puede fijarlas.
var ReservedProps = map[string]bool{
	"server-port": true, "enable-rcon": true, "rcon.port": true, "rcon.password": true,
}

var restartPolicies = map[string]container.RestartPolicyMode{
	"":               container.RestartPolicyUnlessStopped,
	"unless-stopped": container.RestartPolicyUnlessStopped,
	"always":         container.RestartPolicyAlways,
	"no":             container.RestartPolicyDisabled,
	"on-failure":     container.RestartPolicyOnFailure,
}

type Spec struct {
	ImageTag      string            `json:"imageTag"`
	Type          string            `json:"type"`
	Version       string            `json:"version"`
	Memory        string            `json:"memory"`
	Properties    map[string]string `json:"properties"`
	Env           map[string]string `json:"env"`
	Ports         Ports             `json:"ports"`
	Resources     Resources         `json:"resources"`
	RestartPolicy string            `json:"restartPolicy"`
	RconPassword  string            `json:"rconPassword"`
}

type Ports struct {
	Game  int           `json:"game"`
	Extra []PortMapping `json:"extra"`
}

type PortMapping struct {
	Host      int    `json:"host"`
	Container int    `json:"container"`
	Proto     string `json:"proto"`
	Label     string `json:"label"`
}

type Resources struct {
	Cpus     float64 `json:"cpus"`
	MemLimit string  `json:"memLimit"`
}

type Meta struct {
	ServerID string
	Slug     string
	Version  uint64
}

type Build struct {
	Name       string
	Config     *container.Config
	HostConfig *container.HostConfig
	Networking *network.NetworkingConfig
	DataDir    string
	Hash       string
}

func Parse(b []byte) (Spec, error) {
	var s Spec
	if err := json.Unmarshal(b, &s); err != nil {
		return Spec{}, fmt.Errorf("spec JSON inválido: %w", err)
	}
	return s, s.Validate()
}

func (s Spec) Validate() error {
	if s.Type == "" {
		return fmt.Errorf("spec: type es obligatorio")
	}
	if s.Version == "" {
		return fmt.Errorf("spec: version es obligatoria")
	}
	if !sizeRe.MatchString(s.Memory) {
		return fmt.Errorf("spec: memory inválida %q (formato NNM o NNG, sin 0)", s.Memory)
	}
	memBytes, err := units.RAMInBytes(s.Memory)
	if err != nil || memBytes <= 0 {
		return fmt.Errorf("spec: memory inválida %q", s.Memory)
	}
	if s.Resources.MemLimit != "" {
		if !sizeRe.MatchString(s.Resources.MemLimit) {
			return fmt.Errorf("spec: memLimit inválido %q (formato NNM o NNG, sin 0)", s.Resources.MemLimit)
		}
		lim, err := units.RAMInBytes(s.Resources.MemLimit)
		if err != nil || lim <= 0 {
			return fmt.Errorf("spec: memLimit inválido %q", s.Resources.MemLimit)
		}
		if lim < memBytes {
			return fmt.Errorf("spec: memLimit (%s) no puede ser menor que memory (%s)", s.Resources.MemLimit, s.Memory)
		}
	}
	if s.Resources.Cpus < 0 {
		return fmt.Errorf("spec: cpus no puede ser negativo")
	}
	if !validPort(s.Ports.Game) {
		return fmt.Errorf("spec: puerto de juego fuera de rango: %d", s.Ports.Game)
	}
	for _, pm := range s.Ports.Extra {
		if !validPort(pm.Host) || !validPort(pm.Container) {
			return fmt.Errorf("spec: puerto extra fuera de rango: %+v", pm)
		}
		if pm.Proto != "tcp" && pm.Proto != "udp" {
			return fmt.Errorf("spec: proto inválido %q (tcp|udp)", pm.Proto)
		}
		if pm.Container == RconPort {
			return fmt.Errorf("spec: el puerto extra no puede publicar RCON (%d)", RconPort)
		}
	}
	if len(s.RconPassword) < 8 {
		return fmt.Errorf("spec: rconPassword debe tener al menos 8 caracteres")
	}
	if _, ok := restartPolicies[s.RestartPolicy]; !ok {
		return fmt.Errorf("spec: restartPolicy inválida %q", s.RestartPolicy)
	}
	for k := range s.Env {
		if !envNameRe.MatchString(k) {
			return fmt.Errorf("spec: nombre de variable inválido %q", k)
		}
		if ReservedEnv[k] {
			return fmt.Errorf("spec: la variable %s es reservada y no puede sobreescribirse", k)
		}
	}
	for k, v := range s.Properties {
		if !propKeyRe.MatchString(k) {
			return fmt.Errorf("spec: nombre de propiedad inválido %q", k)
		}
		if ReservedProps[k] {
			return fmt.Errorf("spec: la propiedad %s es reservada (la gestiona el agente)", k)
		}
		if strings.ContainsAny(v, "\r\n") {
			return fmt.Errorf("spec: la propiedad %s no puede tener saltos de línea en el valor", k)
		}
	}
	return nil
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }

func ContainerName(slug string) string { return "mcsm-" + slug }

// BuildContainer traduce la spec a una configuración de contenedor. Es una
// función pura: misma entrada, misma salida, mismo Hash.
func BuildContainer(meta Meta, s Spec, dataRoot, networkName string) (*Build, error) {
	if !slugRe.MatchString(meta.Slug) {
		return nil, fmt.Errorf("slug inválido %q", meta.Slug)
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	tag := s.ImageTag
	if tag == "" {
		tag = "latest"
	}
	dataDir := filepath.Join(dataRoot, meta.Slug, "data")
	name := ContainerName(meta.Slug)

	exposed := network.PortSet{}
	bindings := network.PortMap{}
	game := mustPort(fmt.Sprintf("%d/tcp", GamePort))
	exposed[game] = struct{}{}
	bindings[game] = []network.PortBinding{{HostPort: strconv.Itoa(s.Ports.Game)}}
	for _, pm := range s.Ports.Extra {
		p := mustPort(fmt.Sprintf("%d/%s", pm.Container, pm.Proto))
		exposed[p] = struct{}{}
		bindings[p] = append(bindings[p], network.PortBinding{HostPort: strconv.Itoa(pm.Host)})
	}

	cfg := &container.Config{
		Image:        Image + ":" + tag,
		Env:          s.envList(),
		Tty:          true,
		OpenStdin:    true,
		ExposedPorts: exposed,
		Labels: map[string]string{
			LabelManaged:  "true",
			LabelServerID: meta.ServerID,
			LabelSlug:     meta.Slug,
		},
	}
	host := &container.HostConfig{
		Binds:         []string{dataDir + ":/data"},
		PortBindings:  bindings,
		RestartPolicy: container.RestartPolicy{Name: restartPolicies[s.RestartPolicy]},
	}
	if s.Resources.MemLimit != "" {
		host.Resources.Memory, _ = units.RAMInBytes(s.Resources.MemLimit)
	}
	if s.Resources.Cpus > 0 {
		host.Resources.NanoCPUs = int64(s.Resources.Cpus * 1e9)
	}
	net := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{networkName: {}}}

	hash := hashOf(name, cfg, host)
	cfg.Labels[LabelHash] = hash
	cfg.Labels[LabelVersion] = strconv.FormatUint(meta.Version, 10)

	return &Build{Name: name, Config: cfg, HostConfig: host, Networking: net, DataDir: dataDir, Hash: hash}, nil
}

func (s Spec) envList() []string {
	m := map[string]string{
		"EULA":          "TRUE",
		"TYPE":          s.Type,
		"VERSION":       s.Version,
		"MEMORY":        s.Memory,
		"ENABLE_RCON":   "true",
		"RCON_PASSWORD": s.RconPassword,
		"RCON_PORT":     strconv.Itoa(RconPort),
		"SERVER_PORT":   strconv.Itoa(GamePort),
	}
	if len(s.Properties) > 0 {
		keys := make([]string, 0, len(s.Properties))
		for k := range s.Properties {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		lines := make([]string, 0, len(keys))
		for _, k := range keys {
			lines = append(lines, k+"="+s.Properties[k])
		}
		m["CUSTOM_SERVER_PROPERTIES"] = strings.Join(lines, "\n")
	}
	for k, v := range s.Env {
		m[k] = v
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func hashOf(name string, cfg *container.Config, host *container.HostConfig) string {
	b, _ := json.Marshal(struct {
		Name string
		Cfg  *container.Config
		Host *container.HostConfig
	}{name, cfg, host})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:16]
}

func mustPort(s string) network.Port { return network.MustParsePort(s) }
