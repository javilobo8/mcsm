// Package docker aísla el SDK de Docker tras una interfaz pequeña y testeable.
package docker

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

var ErrNotFound = errors.New("docker: no encontrado")

type Container struct {
	ID     string
	Name   string
	State  string
	Labels map[string]string
	// Adopted lo marca el reconciliador en el contenedor original de un servidor importado (plan-6):
	// no tiene etiquetas mcsm.* y sus Labels son sintetizadas. Docker nunca lo rellena.
	Adopted bool
}

type Inspect struct {
	ID        string
	Name      string
	State     string
	Running   bool
	Health    string
	ExitCode  int
	StartedAt time.Time
	Labels    map[string]string
	// PortsMissing: en marcha sin publicar los puertos que pide (PortBindings con puerto de host y
	// NetworkSettings.Ports sin ellos). Docker 29.7.2 arranca así, y así se queda aunque se pare y
	// se vuelva a arrancar, un contenedor cuyo arranque anterior falló por el puerto del host: hay
	// que borrarlo y crearlo de nuevo (plan-8).
	PortsMissing bool
}

// PortsMissing indica si falta en published algún puerto que want publica en el host. Pura.
func PortsMissing(want, published network.PortMap) bool {
	for p, binds := range want {
		needs := false
		for _, b := range binds {
			if b.HostPort != "" {
				needs = true
			}
		}
		if needs && len(published[p]) == 0 {
			return true
		}
	}
	return false
}

// Stats es una lectura puntual de `docker stats` (una sola muestra, sin la previa:
// el % de CPU lo calcula el muestreador con dos lecturas consecutivas).
type Stats struct {
	Read        time.Time
	CPUTotalNs  uint64 // CPU acumulada del contenedor, en ns
	SystemCPUNs uint64 // CPU acumulada del host (todas las CPU), en ns
	OnlineCPUs  uint32
	MemBytes    uint64 // uso sin la caché de páginas inactiva (como la CLI de Docker)
	MemLimit    uint64
	NetRxBytes  uint64 // suma de todas las interfaces, acumulado desde el arranque
	NetTxBytes  uint64
}

type Event struct {
	Action      string
	ContainerID string
	Labels      map[string]string
}

type Engine interface {
	Version(ctx context.Context) (string, error)
	EnsureNetwork(ctx context.Context, name string) error
	EnsureImage(ctx context.Context, ref string) error
	ListManaged(ctx context.Context) ([]Container, error)
	Inspect(ctx context.Context, id string) (*Inspect, error)
	Create(ctx context.Context, name string, cfg *container.Config, host *container.HostConfig, net *network.NetworkingConfig) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, timeout time.Duration) error
	Kill(ctx context.Context, id string) error
	Remove(ctx context.Context, id string) error
	// Logs sigue la salida del contenedor (follow) empezando por las últimas `tail` líneas,
	// con timestamps RFC3339Nano al inicio de cada línea.
	Logs(ctx context.Context, id string, tail int) (io.ReadCloser, error)
	// Events emite eventos de contenedores con la etiqueta mcsm.managed=true hasta que ctx termina.
	Events(ctx context.Context) (<-chan Event, <-chan error)
	// Stats devuelve una lectura puntual de uso de recursos (one-shot: no espera a una
	// segunda muestra). ErrNotFound si el contenedor no existe.
	Stats(ctx context.Context, id string) (Stats, error)
	// HostName es el nombre del host del daemon (docker info → Name): el de la máquina, no el del contenedor del
	// agente (os.Hostname dentro de un contenedor es su id). plan-9.
	HostName(ctx context.Context) (string, error)

	// ── plan-6: importación (spec §6.7) ──
	// ListAll lista todos los contenedores del host (como `docker ps -a`), gestionados o no.
	ListAll(ctx context.Context) ([]Container, error)
	// InspectImport es el inspect reducido de un contenedor importable. ErrNotFound si no existe.
	InspectImport(ctx context.Context, id string) (*ImportInfo, error)
	// ImageEnv devuelve el ENV de una imagen (por id o referencia). ErrNotFound si no existe.
	ImageEnv(ctx context.Context, image string) ([]string, error)
	// ConnectNetwork conecta un contenedor (en marcha o no) a una red con alias DNS, sin reiniciarlo.
	ConnectNetwork(ctx context.Context, netName, id string, aliases []string) error
	// DisconnectNetwork lo desconecta de una red, sin reiniciarlo (Docker no cambia los alias de una
	// conexión existente: se desconecta y se vuelve a conectar).
	DisconnectNetwork(ctx context.Context, netName, id string) error
}
