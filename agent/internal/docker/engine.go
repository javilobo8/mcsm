// Package docker isolates the Docker SDK behind a small, testable interface.
package docker

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

var ErrNotFound = errors.New("docker: not found")

type Container struct {
	ID     string
	Name   string
	State  string
	Labels map[string]string
	// Adopted is set by the reconciler on the original container of an imported server (plan-6):
	// it has no mcsm.* labels and its Labels are synthesized. Docker never fills it in.
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
	// PortsMissing: running without publishing the ports it asks for (PortBindings with a host port and
	// NetworkSettings.Ports without them). Docker 29.7.2 starts this way, and stays that way even if it is stopped and
	// started again, a container whose previous start failed on the host port: it has to
	// be deleted and created again (plan-8).
	PortsMissing bool
}

// PortsMissing reports whether published lacks any port that want publishes on the host. Pure.
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

// Stats is a point reading of `docker stats` (a single sample, without the previous one:
// the CPU % is computed by the sampler from two consecutive readings).
type Stats struct {
	Read        time.Time
	CPUTotalNs  uint64 // accumulated container CPU, in ns
	SystemCPUNs uint64 // accumulated host CPU (all CPUs), in ns
	OnlineCPUs  uint32
	MemBytes    uint64 // usage without the inactive page cache (like the Docker CLI)
	MemLimit    uint64
	NetRxBytes  uint64 // sum of all interfaces, accumulated since startup
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
	// Logs follows the container output (follow) starting with the last `tail` lines,
	// with RFC3339Nano timestamps at the start of each line.
	Logs(ctx context.Context, id string, tail int) (io.ReadCloser, error)
	// Events emits events of containers with the mcsm.managed=true label until ctx ends.
	Events(ctx context.Context) (<-chan Event, <-chan error)
	// Stats returns a point reading of resource usage (one-shot: it does not wait for a
	// second sample). ErrNotFound if the container does not exist.
	Stats(ctx context.Context, id string) (Stats, error)
	// HostName is the daemon's host name (docker info → Name): the machine's, not that of the agent's
	// container (os.Hostname inside a container is its id). plan-9.
	HostName(ctx context.Context) (string, error)

	// ── plan-6: import (spec §6.7) ──
	// ListAll lists all the host's containers (like `docker ps -a`), managed or not.
	ListAll(ctx context.Context) ([]Container, error)
	// InspectImport is the reduced inspect of an importable container. ErrNotFound if it does not exist.
	InspectImport(ctx context.Context, id string) (*ImportInfo, error)
	// ImageEnv returns an image's ENV (by id or reference). ErrNotFound if it does not exist.
	ImageEnv(ctx context.Context, image string) ([]string, error)
	// ConnectNetwork connects a container (running or not) to a network with a DNS alias, without restarting it.
	ConnectNetwork(ctx context.Context, netName, id string, aliases []string) error
	// DisconnectNetwork disconnects it from a network, without restarting it (Docker does not change the aliases of an
	// existing connection: it is disconnected and connected again).
	DisconnectNetwork(ctx context.Context, netName, id string) error
}
