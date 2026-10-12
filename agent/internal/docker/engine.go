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
}
