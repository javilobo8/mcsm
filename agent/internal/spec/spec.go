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

	// PidsLimit acota procesos e hilos del contenedor (los servidores con mods usan
	// cientos de hilos y pids los cuenta): una fork bomb no agota el nodo.
	PidsLimit = 4096
	// memHeadroom es el margen sobre `memory` (heap de la JVM) cuando no hay memLimit:
	// el límite por defecto es memory + 1G (spec §4.1).
	memHeadroom = 1 << 30
)

// Endurecimiento del contenedor. CapAdd es el mínimo con el que el entrypoint de itzg
// (chown de /data y paso a uid 1000 con no-new-privileges) arranca y llega a healthy;
// probado contra la imagen real. Las funciones de itzg que necesitan NET_RAW/NET_ADMIN
// (autopause/autostop con knockd) no están soportadas.
var (
	securityOpt = []string{"no-new-privileges:true"}
	capDrop     = []string{"ALL"}
	capAdd      = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"}
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

// imageTagRe valida la etiqueta de la imagen itzg (gramática de tag de Docker, sin
// digest). Misma regex que el zod del panel. Sin ella, moby limpia `..` al construir la
// URL de ImageInspect y un tag como "x/../../containers/<id>" llegaba a otra API.
var imageTagRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

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
	// ── plan-2 ──
	// ── plan-3 ──
	// ── plan-4 ──
	Backups *Backups `json:"backups,omitempty"`
	// ── plan-5 ──
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	// ── plan-9 ──
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
	if s.ImageTag != "" && !imageTagRe.MatchString(s.ImageTag) { // vacío = latest
		return fmt.Errorf("spec: imageTag inválido %q (letras, números, . _ -; empieza por letra o número; máx. 128)", s.ImageTag)
	}
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
	// ── plan-2 ──
	// ── plan-3 ──
	// ── plan-4 ──
	if err := s.Backups.Validate(); err != nil {
		return err
	}
	// ── plan-5 ──
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	// ── plan-9 ──
	return nil
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }

// ValidSlug indica si slug es un slug de servidor válido (seguro como nombre de directorio).
func ValidSlug(slug string) bool { return slugRe.MatchString(slug) }

func ContainerName(slug string) string { return "mcsm-" + slug }

// BuildContainer traduce la spec a una configuración de contenedor. Es una
// función pura: misma entrada, misma salida, mismo Hash.
func BuildContainer(meta Meta, s Spec, dataRoot, networkName string) (*Build, error) {
	if !ValidSlug(meta.Slug) {
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
		SecurityOpt:   append([]string(nil), securityOpt...),
		CapDrop:       append([]string(nil), capDrop...),
		CapAdd:        append([]string(nil), capAdd...),
	}
	pids := int64(PidsLimit)
	host.Resources.PidsLimit = &pids
	// Validate ya comprobó ambos tamaños.
	if s.Resources.MemLimit != "" {
		host.Resources.Memory, _ = units.RAMInBytes(s.Resources.MemLimit)
	} else {
		mem, _ := units.RAMInBytes(s.Memory)
		host.Resources.Memory = mem + memHeadroom
	}
	if s.Resources.Cpus > 0 {
		host.Resources.NanoCPUs = int64(s.Resources.Cpus * 1e9)
	}
	net := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{networkName: {}}}

	hash, err := hashOf(name, networkName, cfg, host)
	if err != nil {
		return nil, err
	}
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
	// ── plan-2 ──
	// ── plan-3 ──
	// ── plan-4 ──
	// ── plan-5 ──
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	// ── plan-9 ──
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

// hashSchema versiona la forma canónica de hashInput. Cambiarla (o cambiar lo que
// produce BuildContainer) altera el hash de TODOS los servidores, y el agente recrea
// todos los contenedores al actualizarse: solo a propósito.
const hashSchema = 1

// hashInput es la forma canónica y estable de lo que define el contenedor. No se usa
// el JSON de los tipos de moby: una versión nueva de la librería (campos o valores por
// defecto nuevos) cambiaría el hash de todo. Reglas: todo lo que BuildContainer ponga
// en Config/HostConfig/red debe estar aquí, y los campos nuevos llevan omitempty para
// que, vacíos, dejen el hash igual.
type hashInput struct {
	Schema      int               `json:"schema"`
	Name        string            `json:"name"`
	Image       string            `json:"image"`
	Env         []string          `json:"env"`
	Tty         bool              `json:"tty"`
	OpenStdin   bool              `json:"openStdin"`
	Labels      map[string]string `json:"labels"` // identidad; sin hash ni versión
	Ports       []string          `json:"ports"`  // "25565/tcp->:25570", ordenados
	Binds       []string          `json:"binds"`
	Network     string            `json:"network"`
	Restart     string            `json:"restart"`
	Memory      int64             `json:"memory"`
	NanoCPUs    int64             `json:"nanoCpus"`
	PidsLimit   int64             `json:"pidsLimit"`
	SecurityOpt []string          `json:"securityOpt"`
	CapDrop     []string          `json:"capDrop"`
	CapAdd      []string          `json:"capAdd"`
}

func hashOf(name, networkName string, cfg *container.Config, host *container.HostConfig) (string, error) {
	in := hashInput{
		Schema: hashSchema, Name: name, Image: cfg.Image, Env: sortedCopy(cfg.Env),
		Tty: cfg.Tty, OpenStdin: cfg.OpenStdin, Labels: map[string]string{},
		Binds: sortedCopy(host.Binds), Network: networkName, Restart: string(host.RestartPolicy.Name),
		Memory: host.Resources.Memory, NanoCPUs: host.Resources.NanoCPUs,
		SecurityOpt: sortedCopy(host.SecurityOpt), CapDrop: sortedCopy(host.CapDrop), CapAdd: sortedCopy(host.CapAdd),
	}
	for k, v := range cfg.Labels {
		if k != LabelHash && k != LabelVersion {
			in.Labels[k] = v
		}
	}
	for p, binds := range host.PortBindings {
		for _, b := range binds {
			ip := ""
			if b.HostIP.IsValid() {
				ip = b.HostIP.String()
			}
			in.Ports = append(in.Ports, p.String()+"->"+ip+":"+b.HostPort)
		}
	}
	sort.Strings(in.Ports)
	if host.Resources.PidsLimit != nil {
		in.PidsLimit = *host.Resources.PidsLimit
	}
	b, err := json.Marshal(in) // encoding/json ordena las claves de los mapas
	if err != nil {
		return "", fmt.Errorf("spec: calcular el hash del contenedor: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:16], nil
}

func sortedCopy(in []string) []string {
	out := append([]string{}, in...)
	sort.Strings(out)
	return out
}

func mustPort(s string) network.Port { return network.MustParsePort(s) }
