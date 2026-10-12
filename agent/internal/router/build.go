// Package router mantiene el mc-router de un nodo (plan-8): un contenedor itzg/mc-router con
// descubrimiento por Docker (-in-docker) en la red de los servidores, que publica un puerto del host
// y enruta cada conexión por el hostname del handshake al contenedor con esa etiqueta mc-router.host.
//
// Riesgo del socket de Docker: mc-router lo necesita para descubrir los servidores (y, con autoscale,
// para arrancarlos y pararlos). Quien controla ese socket controla el host, igual que el agente. Se
// reduce lo que el contenedor puede hacer por sí mismo: imagen fijada (Tag), usuario no root
// (65532) con solo el grupo del socket, CapDrop ALL, no-new-privileges, raíz de solo lectura,
// límites de memoria y procesos, sin API HTTP de mc-router y sin más montajes. El «:ro» del
// montaje NO limita la API de Docker (connect() sobre un socket no comprueba el montaje): solo
// documenta la intención. Aislarlo de verdad exigiría un proxy del socket (no incluido).
package router

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

const (
	// ContainerName es el nombre del contenedor del router en un nodo (los tests usan mcsm-test-…).
	ContainerName = "mcsm-router"
	Image         = "itzg/mc-router"
	// Tag fija la versión de mc-router. Cambiarla cambia el hash: al actualizar el agente, el router
	// se recrea con la imagen nueva.
	Tag = "1.47.1"
	// LabelRouter marca el contenedor del router (además de mcsm.managed, para recibir sus eventos).
	LabelRouter = "mcsm.router"
	// LabelHash guarda el hash de la configuración para detectar cambios sin comparar campo a campo.
	LabelHash = "mcsm.router_hash"
	// ListenPort es el puerto de mc-router dentro del contenedor.
	ListenPort = 25565
	// HostSocket es el socket de Docker del host: el agente lo tiene montado en la misma ruta.
	HostSocket = "/var/run/docker.sock"
	// User es el usuario no root de la imagen (chainguard static).
	User = "65532:65532"

	DefaultDownAfterMinutes = 10
	MaxDownAfterMinutes     = 1440

	memoryLimit = 256 << 20
	pidsLimit   = 256
	hashSchema  = 1

	asleepMOTD  = "Servidor dormido: conéctate para arrancarlo"
	loadingMOTD = "Arrancando el servidor…"
)

// ImageRef es la imagen del router con su etiqueta fijada.
func ImageRef() string { return Image + ":" + Tag }

// Build es la configuración del contenedor del router.
type Build struct {
	Name       string
	Config     *container.Config
	HostConfig *container.HostConfig
	Networking *network.NetworkingConfig
	Hash       string
}

// Validate comprueba una spec de router del panel.
func Validate(sp *mcsmv1.RouterSpec) error {
	if sp == nil {
		return errors.New("router: falta la spec")
	}
	if sp.HostPort < 1 || sp.HostPort > 65535 {
		return fmt.Errorf("router: puerto del host fuera de rango: %d", sp.HostPort)
	}
	if sp.AutoscaleDownAfterMinutes > MaxDownAfterMinutes {
		return fmt.Errorf("router: minutos sin jugadores fuera de rango: %d (máx. %d)", sp.AutoscaleDownAfterMinutes, MaxDownAfterMinutes)
	}
	return nil
}

// args son los argumentos de mc-router. Sin autoscale, mc-router solo enruta a contenedores en
// marcha; con autoscale arranca el servidor al entrar un jugador y lo para tras N minutos sin nadie.
func args(sp *mcsmv1.RouterSpec) []string {
	a := []string{"-in-docker", "-port", strconv.Itoa(ListenPort)}
	if sp.Autoscale {
		mins := sp.AutoscaleDownAfterMinutes
		if mins == 0 {
			mins = DefaultDownAfterMinutes
		}
		a = append(a, "-auto-scale-up", "-auto-scale-down", "-auto-scale-down-after", fmt.Sprintf("%dm", mins),
			"-auto-scale-asleep-motd", asleepMOTD, "-auto-scale-loading-motd", loadingMOTD)
	}
	return a
}

// BuildContainer traduce la spec a la configuración del contenedor. Pura: misma entrada, mismo Hash.
// socketGID es el grupo propietario del socket de Docker del host (GroupAdd).
func BuildContainer(sp *mcsmv1.RouterSpec, name, networkName string, socketGID uint32) (*Build, error) {
	if err := Validate(sp); err != nil {
		return nil, err
	}
	port := network.MustParsePort(fmt.Sprintf("%d/tcp", ListenPort))
	cfg := &container.Config{
		Image:        ImageRef(),
		Cmd:          args(sp),
		User:         User,
		ExposedPorts: network.PortSet{port: {}},
		Labels:       map[string]string{spec.LabelManaged: "true", LabelRouter: "true"},
	}
	host := &container.HostConfig{
		Binds:          []string{HostSocket + ":" + HostSocket + ":ro"},
		PortBindings:   network.PortMap{port: {{HostPort: strconv.FormatUint(uint64(sp.HostPort), 10)}}},
		RestartPolicy:  container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
		SecurityOpt:    []string{"no-new-privileges:true"},
		CapDrop:        []string{"ALL"},
		GroupAdd:       []string{strconv.FormatUint(uint64(socketGID), 10)},
		ReadonlyRootfs: true,
	}
	host.Resources.Memory = memoryLimit
	pids := int64(pidsLimit)
	host.Resources.PidsLimit = &pids
	net := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{networkName: {}}}
	hash, err := hashOf(name, networkName, cfg, host)
	if err != nil {
		return nil, err
	}
	cfg.Labels[LabelHash] = hash
	return &Build{Name: name, Config: cfg, HostConfig: host, Networking: net, Hash: hash}, nil
}

// hashInput es la forma canónica de lo que define el contenedor del router (no el JSON de moby, que
// cambia entre versiones de la librería). Todo lo que BuildContainer ponga debe estar aquí.
type hashInput struct {
	Schema         int               `json:"schema"`
	Name           string            `json:"name"`
	Image          string            `json:"image"`
	Cmd            []string          `json:"cmd"`
	User           string            `json:"user"`
	Labels         map[string]string `json:"labels"`
	Ports          []string          `json:"ports"`
	Binds          []string          `json:"binds"`
	Network        string            `json:"network"`
	Restart        string            `json:"restart"`
	Memory         int64             `json:"memory"`
	PidsLimit      int64             `json:"pidsLimit"`
	SecurityOpt    []string          `json:"securityOpt"`
	CapDrop        []string          `json:"capDrop"`
	GroupAdd       []string          `json:"groupAdd"`
	ReadonlyRootfs bool              `json:"readonlyRootfs"`
}

func hashOf(name, networkName string, cfg *container.Config, host *container.HostConfig) (string, error) {
	in := hashInput{
		Schema: hashSchema, Name: name, Image: cfg.Image, Cmd: append([]string{}, cfg.Cmd...), User: cfg.User,
		Labels: map[string]string{}, Binds: sorted(host.Binds), Network: networkName, Restart: string(host.RestartPolicy.Name),
		Memory: host.Resources.Memory, SecurityOpt: sorted(host.SecurityOpt), CapDrop: sorted(host.CapDrop),
		GroupAdd: sorted(host.GroupAdd), ReadonlyRootfs: host.ReadonlyRootfs,
	}
	for k, v := range cfg.Labels {
		if k != LabelHash {
			in.Labels[k] = v
		}
	}
	for p, binds := range host.PortBindings {
		for _, b := range binds {
			in.Ports = append(in.Ports, p.String()+"->:"+b.HostPort)
		}
	}
	sort.Strings(in.Ports)
	if host.Resources.PidsLimit != nil {
		in.PidsLimit = *host.Resources.PidsLimit
	}
	b, err := json.Marshal(in)
	if err != nil {
		return "", fmt.Errorf("router: calcular el hash: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:16], nil
}

func sorted(in []string) []string {
	out := append([]string{}, in...)
	sort.Strings(out)
	return out
}
