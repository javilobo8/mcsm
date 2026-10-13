package router

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
)

const (
	// stopTimeout is the wait for a clean stop of the router before killing it.
	stopTimeout = 10 * time.Second
	// RetryAfter is the wait after a failure before touching Docker again with the same spec (the
	// events of the failed attempt itself must not turn into a create-and-delete loop).
	RetryAfter = 25 * time.Second // less than the agent's 30 s tick: each tick retries
)

// Store is what the router uses from the agent's store (store.Store satisfies it).
type Store interface {
	RouterSpec() (*mcsmv1.RouterSpec, error)
	PutRouterSpec(*mcsmv1.RouterSpec) error
	DeleteRouterSpec() error
}

// Options configures a Manager. Name has a default value.
type Options struct {
	// Name of the container: ContainerName if empty (tests with real Docker use mcsm-test-…).
	Name    string
	Network string
	// ProxySocket is the HOST path of the agent's Docker proxy socket (dockerproxy); its directory is
	// mounted in the router at RouterSocketDir. ProxyReady (optional) says whether it is listening. A new proxy (the agent
	// restarted) does not restart the router: mc-router reconnects by itself to the new socket in the same directory.
	ProxySocket string
	ProxyReady  func() error
	Now         func() time.Time
	// FilesDir is a HOST directory (the agent sees it at the same path: mirror mount of DATA_ROOT) where the
	// autoscale player list mounted in the router is written.
	FilesDir string
}

// Manager reconciles the router container with the stored spec: with a spec, a container equal to
// BuildContainer and running; without a spec, no router container. Reconcile and the other
// operations on Docker are serialized with mu.
type Manager struct {
	eng  docker.Engine
	st   Store
	opts Options

	mu        sync.Mutex
	lastErr   string    // error of the last reconciliation (under mu)
	failedAt  time.Time // when it failed (under mu)
	failedFor string    // specKey of the spec it failed with (under mu)
	// autoscale reflects the stored spec without taking mu: the server reconciler reads it with its
	// own lock held while Reconcile may be waiting on Docker.
	autoscale atomic.Bool
}

// New creates the manager and loads the autoscale from the stored spec (agent restart).
func New(eng docker.Engine, st Store, opts Options) *Manager {
	if opts.Name == "" {
		opts.Name = ContainerName
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	m := &Manager{eng: eng, st: st, opts: opts}
	if sp, err := st.RouterSpec(); err == nil && sp != nil {
		m.autoscale.Store(sp.Autoscale)
	}
	return m
}

// Apply validates and stores the spec without touching Docker (Reconcile adjusts the container).
func (m *Manager) Apply(sp *mcsmv1.RouterSpec) error {
	if err := Validate(sp); err != nil {
		return err
	}
	if err := m.st.PutRouterSpec(sp); err != nil {
		return err
	}
	m.autoscale.Store(sp.Autoscale)
	return nil
}

// Clear deletes the stored spec without touching Docker (Reconcile removes the container).
func (m *Manager) Clear() error {
	if err := m.st.DeleteRouterSpec(); err != nil {
		return err
	}
	m.autoscale.Store(false)
	return nil
}

// Autoscale reports whether the stored router starts and stops servers with a hostname. It does not block.
func (m *Manager) Autoscale() bool { return m.autoscale.Load() }

// specKey identifies a spec for the wait after a failure ("" = no spec).
func specKey(sp *mcsmv1.RouterSpec) string {
	if sp == nil {
		return ""
	}
	return fmt.Sprintf("%d/%t/%d", sp.HostPort, sp.Autoscale, sp.AutoscaleDownAfterMinutes)
}

// Reconcile leaves Docker the same as the stored spec and returns the observed state. Idempotent:
// it recreates the container if it is missing (deleted by hand) or if its hash does not match (new spec or image),
// starts it if stopped and, without a spec, deletes it. A failure (e.g. the host port taken)
// stays in RouterObserved.Error; with the same spec it is not retried until RetryAfter has passed (a
// new spec is applied immediately).
func (m *Manager) Reconcile(ctx context.Context) *mcsmv1.RouterObserved {
	m.mu.Lock()
	defer m.mu.Unlock()
	sp, err := m.st.RouterSpec()
	if err != nil {
		m.lastErr = fmt.Sprintf("read the router spec: %v", err)
		return m.observeLocked(ctx)
	}
	key := specKey(sp)
	if m.opts.ProxyReady != nil && m.opts.ProxyReady() == nil {
		key += "/proxy" // plan-9 (m5): a proxy that is already listening does not wait for RetryAfter after failing for not being ready
	}
	if m.lastErr != "" && key == m.failedFor && m.opts.Now().Before(m.failedAt.Add(RetryAfter)) {
		return m.observeLocked(ctx)
	}
	m.lastErr = ""
	if err := m.reconcileLocked(ctx, sp); err != nil {
		m.lastErr, m.failedAt, m.failedFor = err.Error(), m.opts.Now(), key
	}
	return m.observeLocked(ctx)
}

func (m *Manager) reconcileLocked(ctx context.Context, sp *mcsmv1.RouterSpec) error {
	existing, err := m.find(ctx)
	if err != nil {
		return err
	}
	if sp == nil {
		if existing == nil {
			return nil
		}
		return m.remove(ctx, existing)
	}
	if m.opts.ProxyReady != nil {
		if err := m.opts.ProxyReady(); err != nil {
			err = fmt.Errorf("the Docker socket proxy for the router is not ready: %w", err)
			// plan-9 (S2): a router of another version (Plan 8's mounts the real Docker socket) cannot stay
			// running in the meantime: it is deleted. One of this version mounts the proxy socket and is left alone.
			if existing != nil {
				b, berr := BuildContainer(sp, m.opts.Name, m.opts.Network, m.opts.ProxySocket, m.opts.FilesDir)
				if berr != nil || existing.Labels[LabelHash] != b.Hash {
					if rerr := m.remove(ctx, existing); rerr != nil {
						return fmt.Errorf("%w (and the previous router could not be removed: %v)", err, rerr)
					}
				}
			}
			return err
		}
	}
	b, err := BuildContainer(sp, m.opts.Name, m.opts.Network, m.opts.ProxySocket, m.opts.FilesDir)
	if err != nil {
		return err
	}
	// The autoscale list has to be on the host before creating or starting the router: if
	// missing, Docker would create a directory in its place. It is restored on every pass if someone deletes it.
	if err := m.syncAllowDeny(b); err != nil {
		return err
	}
	if existing != nil && existing.Labels[LabelHash] != b.Hash {
		if err := m.remove(ctx, existing); err != nil {
			return err
		}
		existing = nil
	}
	// Docker (29.7.2) starts WITHOUT publishing ports, and leaves it that way even if stopped and started, a
	// container whose previous start failed on the host port (also if the failed start
	// was by the restart policy). A running router without its port is deleted and created again;
	// one that starts without it, likewise, once per pass.
	for recreated := false; ; {
		if existing != nil && existing.State == "running" {
			ins, err := m.eng.Inspect(ctx, existing.ID)
			if err != nil && !errors.Is(err, docker.ErrNotFound) {
				return fmt.Errorf("inspect the router: %w", err)
			}
			switch {
			case err == nil && !ins.PortsMissing:
				return nil
			case err == nil && recreated:
				return fmt.Errorf("the router started without publishing host port %d (Docker failure)", sp.HostPort)
			default:
				if err := m.remove(ctx, existing); err != nil {
					return err
				}
				existing, recreated = nil, true
			}
		}
		fresh := false
		if existing == nil {
			if err := m.eng.EnsureImage(ctx, b.Config.Image); err != nil {
				return fmt.Errorf("pull %s: %w", b.Config.Image, err)
			}
			id, err := m.eng.Create(ctx, b.Name, b.Config, b.HostConfig, b.Networking)
			if err != nil {
				return fmt.Errorf("create container %s: %w", b.Name, err)
			}
			existing, fresh = &docker.Container{ID: id, Name: b.Name, State: "created"}, true
		}
		if existing.State == "restarting" {
			return nil
		}
		if existing.State != "running" && !fresh {
			// A manual `docker rm -f` emits kill and die before destroy, and the list (a snapshot) gives
			// the container as exited or dead while it is being deleted: Docker would not start it ("marked for
			// removal"). It is not a failure (it would count for RetryAfter and delay the recreation until the tick):
			// the pass triggered by its destroy creates it again.
			ins, err := m.eng.Inspect(ctx, existing.ID)
			switch {
			case errors.Is(err, docker.ErrNotFound):
				existing = nil
				continue
			case err != nil:
				return fmt.Errorf("inspect the router: %w", err)
			case ins.State == "removing":
				return nil
			}
		}
		if existing.State != "running" {
			if err := m.eng.Start(ctx, existing.ID); err != nil {
				// It is deleted so that the retry creates it again and fails again while the port
				// stays taken, instead of being left "running" and unreachable.
				if rerr := m.eng.Remove(ctx, existing.ID); rerr != nil && !errors.Is(rerr, docker.ErrNotFound) {
					return fmt.Errorf("start the router on host port %d: %w (and it could not be deleted: %v)", sp.HostPort, err, rerr)
				}
				return fmt.Errorf("start the router on host port %d: %w", sp.HostPort, err)
			}
			existing.State = "running"
		}
	}
}

// syncAllowDeny leaves in FilesDir the file with b's autoscale list (atomic write and
// readable by the mc-router user), or deletes it if b carries no list.
func (m *Manager) syncAllowDeny(b *Build) error {
	if b.AllowDeny == nil {
		if m.opts.FilesDir != "" {
			if err := os.Remove(filepath.Join(m.opts.FilesDir, AllowDenyFile)); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return fmt.Errorf("delete the autoscale player list: %w", err)
			}
		}
		return nil
	}
	if cur, err := os.ReadFile(b.AllowDenyPath); err == nil && bytes.Equal(cur, b.AllowDeny) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(b.AllowDenyPath), 0o755); err != nil {
		return fmt.Errorf("save the autoscale player list: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(b.AllowDenyPath), ".allow-deny-*")
	if err != nil {
		return fmt.Errorf("save the autoscale player list: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b.AllowDeny); err != nil {
		tmp.Close()
		return fmt.Errorf("save the autoscale player list: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return fmt.Errorf("save the autoscale player list: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("save the autoscale player list: %w", err)
	}
	if err := os.Rename(tmp.Name(), b.AllowDenyPath); err != nil {
		return fmt.Errorf("save the autoscale player list: %w", err)
	}
	return nil
}

// remove stops and deletes the router's container.
func (m *Manager) remove(ctx context.Context, c *docker.Container) error {
	if err := m.eng.Stop(ctx, c.ID, stopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("stop the router: %w", err)
	}
	if err := m.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("delete the router: %w", err)
	}
	return nil
}

func (m *Manager) observeLocked(ctx context.Context) *mcsmv1.RouterObserved {
	obs := &mcsmv1.RouterObserved{State: "missing", Error: m.lastErr, TsUnixMs: m.opts.Now().UnixMilli()}
	sp, err := m.st.RouterSpec()
	if err != nil && obs.Error == "" {
		obs.Error = err.Error()
	}
	if sp != nil {
		obs.Configured, obs.HostPort, obs.Autoscale, obs.Image, obs.Spec = true, sp.HostPort, sp.Autoscale, ImageRef(), sp
	}
	c, err := m.find(ctx)
	if err != nil {
		if obs.Error == "" {
			obs.Error = err.Error()
		}
		return obs
	}
	if c == nil {
		return obs
	}
	ins, err := m.eng.Inspect(ctx, c.ID)
	if err != nil {
		if !errors.Is(err, docker.ErrNotFound) && obs.Error == "" {
			obs.Error = err.Error()
		}
		return obs
	}
	obs.ContainerId, obs.State = ins.ID, ins.State
	return obs
}

// find looks for the router's container by its label and name (nil if it does not exist).
func (m *Manager) find(ctx context.Context) (*docker.Container, error) {
	list, err := m.eng.ListManaged(ctx)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	for i := range list {
		if list[i].Labels[LabelRouter] == "true" && list[i].Name == m.opts.Name {
			return &list[i], nil
		}
	}
	return nil, nil
}
