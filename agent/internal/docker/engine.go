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
}
