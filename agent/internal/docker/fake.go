package docker

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

// Fake is an in-memory Engine for tests. The exported fields allow
// inspecting calls and injecting failures.
type Fake struct {
	mu         sync.Mutex
	seq        int
	Containers map[string]*FakeContainer
	Images     map[string]bool
	Networks   map[string]bool
	Pulled     []string
	Calls      []string
	CreateErr  error
	StartErr   error
	StatsErr   error               // if not nil, Stats returns it
	ImageEnvs  map[string][]string // plan-6: each image's ENV, by reference (ImageEnv)
	ConnectErr error               // plan-6: if not nil, ConnectNetwork returns it
	stats      map[string]Stats    // readings set with SetStats, by container id
	logPipes   map[string][]*io.PipeWriter
	subs       []*eventSub
	subscribed chan struct{} // closed on Events' first subscriber (Subscribed)
}

// eventSub is a subscriber of Events.
type eventSub struct {
	ch   chan Event
	errs chan error
}

// eventBuffer is the capacity of each subscriber's event channel.
const eventBuffer = 256

func copyLabels(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

type FakeContainer struct {
	ID         string
	Name       string
	State      string
	Health     string
	ExitCode   int
	StartedAt  time.Time
	Config     *container.Config
	HostConfig *container.HostConfig
	Net        *network.NetworkingConfig
	Aliases    map[string][]string // plan-6: network → aliases added with ConnectNetwork
	// startFailed: a Start failed on the port. Like Docker 29.7.2, subsequent Starts
	// work but do not publish the ports (unpublished), even if stopped and started.
	startFailed bool
	unpublished bool
	// removing: a foreign `docker rm -f` in progress (BeginRemoval). Like Docker 29.7.2: the list
	// (snapshot) gives it as exited, Inspect as removing, and Start and Remove fail with a conflict.
	removing bool
}

// FakeID is the id of the nth container the fake creates: 64 hex, like Docker's.
func FakeID(n int) string { return fmt.Sprintf("%064x", n) }

func NewFake() *Fake {
	return &Fake{Containers: map[string]*FakeContainer{}, Images: map[string]bool{}, Networks: map[string]bool{}, ImageEnvs: map[string][]string{}, logPipes: map[string][]*io.PipeWriter{}}
}

func (f *Fake) record(format string, args ...any) {
	f.Calls = append(f.Calls, fmt.Sprintf(format, args...))
}

func (f *Fake) Version(context.Context) (string, error) { return "fake-29.0", nil }

func (f *Fake) HostName(context.Context) (string, error) { return "fake-host", nil }

func (f *Fake) EnsureNetwork(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Networks[name] = true
	f.record("EnsureNetwork %s", name)
	return nil
}

func (f *Fake) EnsureImage(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.Images[ref] {
		f.Images[ref] = true
		f.Pulled = append(f.Pulled, ref)
	}
	f.record("EnsureImage %s", ref)
	return nil
}

func (f *Fake) ListManaged(context.Context) ([]Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Container
	for _, c := range f.Containers {
		if c.Config != nil && c.Config.Labels["mcsm.managed"] == "true" {
			out = append(out, Container{ID: c.ID, Name: c.Name, State: c.State, Labels: copyLabels(c.Config.Labels)})
		}
	}
	return out, nil
}

func (f *Fake) Inspect(_ context.Context, id string) (*Inspect, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.Containers[id]
	if !ok {
		return nil, ErrNotFound
	}
	labels := map[string]string{}
	if c.Config != nil {
		labels = copyLabels(c.Config.Labels)
	}
	state := c.State
	if c.removing {
		state = "removing"
	}
	return &Inspect{ID: c.ID, Name: c.Name, State: state, Running: c.State == "running", Health: c.Health, ExitCode: c.ExitCode, StartedAt: c.StartedAt, Labels: labels,
		PortsMissing: c.State == "running" && c.unpublished && len(hostPorts(c.HostConfig)) > 0}, nil
}

func (f *Fake) Create(_ context.Context, name string, cfg *container.Config, host *container.HostConfig, net *network.NetworkingConfig) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Create %s", name)
	if f.CreateErr != nil {
		return "", f.CreateErr
	}
	for _, c := range f.Containers {
		if c.Name == name {
			return "", fmt.Errorf("conflict: the name %q is already in use", name)
		}
	}
	f.seq++
	id := FakeID(f.seq)
	f.Containers[id] = &FakeContainer{ID: id, Name: name, State: "created", Config: cfg, HostConfig: host, Net: net}
	return id, nil
}

// hostPorts returns the host "port/proto" keys published by a container.
func hostPorts(hc *container.HostConfig) map[string]bool {
	out := map[string]bool{}
	if hc == nil {
		return out
	}
	for cp, bs := range hc.PortBindings {
		for _, b := range bs {
			if b.HostPort != "" {
				out[b.HostPort+"/"+string(cp.Proto())] = true
			}
		}
	}
	return out
}

// Start imitates Docker: on an already running container it is a no-op, and host
// ports are bound here (not in Create), so a collision with another running
// container fails with "port is already allocated" leaving the container in created.
// Like Docker 29.7.2, after a Start that failed on the port the following ones start without
// publishing the ports (Inspect.PortsMissing) and without occupying them.
func (f *Fake) Start(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Start %s", id)
	if f.StartErr != nil {
		return f.StartErr
	}
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	if c.removing { // like Docker
		return fmt.Errorf("container is marked for removal and cannot be started: %w", cerrdefs.ErrConflict)
	}
	if c.State == "running" {
		return nil
	}
	if c.State == "paused" { // like Docker
		return fmt.Errorf("cannot start a paused container, try unpause instead: %w", cerrdefs.ErrConflict)
	}
	mine := hostPorts(c.HostConfig)
	if c.startFailed {
		mine = nil // it will not publish anything: it does not compete for ports
	}
	for _, o := range f.Containers {
		if o.ID == id || o.State != "running" || o.unpublished {
			continue
		}
		for p := range hostPorts(o.HostConfig) {
			if mine[p] {
				c.startFailed = true
				return fmt.Errorf("driver failed programming external connectivity: Bind for 0.0.0.0:%s failed: port is already allocated", p)
			}
		}
	}
	c.State, c.StartedAt, c.Health = "running", time.Now(), "starting"
	c.unpublished = c.startFailed
	return nil
}

// Stop: on a non-running container it is a no-op (created stays created, exited
// keeps its ExitCode), as in Docker.
func (f *Fake) Stop(_ context.Context, id string, timeout time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Stop %s %s", id, timeout)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	if c.State != "running" {
		return nil
	}
	c.State, c.Health, c.ExitCode = "exited", "", 0
	return nil
}

// Kill on a non-running container returns a conflict error (409).
func (f *Fake) Kill(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Kill %s", id)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	if c.State != "running" {
		return fmt.Errorf("container %s is not running: %w", id, cerrdefs.ErrConflict)
	}
	c.State, c.Health, c.ExitCode = "exited", "", 137
	return nil
}

func (f *Fake) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Remove %s", id)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	if c.removing { // like Docker
		return fmt.Errorf("removal of container %s is already in progress: %w", id, cerrdefs.ErrConflict)
	}
	delete(f.Containers, id)
	for _, w := range f.logPipes[id] {
		w.Close()
	}
	delete(f.logPipes, id)
	return nil
}

func (f *Fake) Logs(_ context.Context, id string, tail int) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Logs %s %d", id, tail)
	if _, ok := f.Containers[id]; !ok {
		return nil, ErrNotFound
	}
	r, w := io.Pipe()
	f.logPipes[id] = append(f.logPipes[id], w)
	return r, nil
}

// WriteLog pushes a line to all the container's Logs readers.
func (f *Fake) WriteLog(id, line string) {
	f.mu.Lock()
	ws := append([]*io.PipeWriter(nil), f.logPipes[id]...)
	f.mu.Unlock()
	for _, w := range ws {
		_, _ = io.WriteString(w, line)
	}
}

// Events returns the events channel and the errors one. As in Moby, the events
// channel is closed when ctx ends; errs is not closed.
func (f *Fake) Events(ctx context.Context) (<-chan Event, <-chan error) {
	sub := &eventSub{ch: make(chan Event, eventBuffer), errs: make(chan error, 1)}
	f.mu.Lock()
	f.subs = append(f.subs, sub)
	f.subscribedLocked() // creates the channel if needed
	select {
	case <-f.subscribed:
	default:
		close(f.subscribed)
	}
	f.mu.Unlock()
	go func() {
		<-ctx.Done()
		f.mu.Lock()
		defer f.mu.Unlock()
		for i, c := range f.subs {
			if c == sub {
				f.subs = append(f.subs[:i], f.subs[i+1:]...)
				break
			}
		}
		close(sub.ch)
	}()
	return sub.ch, sub.errs
}

// Subscribed returns a channel that closes as soon as someone subscribes to Events: tests
// wait on it before EmitEvent (which drops events without subscribers) without retrying.
func (f *Fake) Subscribed() <-chan struct{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.subscribedLocked()
}

func (f *Fake) subscribedLocked() chan struct{} {
	if f.subscribed == nil {
		f.subscribed = make(chan struct{})
	}
	return f.subscribed
}

// EmitEvent delivers an event to all active Events subscribers. It never
// blocks: with no subscribers, or with a subscriber's buffer full, the event is
// dropped. Subscribers with a cancelled ctx have already been removed.
func (f *Fake) EmitEvent(ev Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.subs {
		select {
		case s.ch <- ev:
		default:
		}
	}
}

// EmitEventErr delivers an error to the active subscribers through the errs channel
// (same non-blocking criterion as EmitEvent).
func (f *Fake) EmitEventErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.subs {
		select {
		case s.errs <- err:
		default:
		}
	}
}

// BeginRemoval simulates a half-done foreign `docker rm -f`: the container is already dead (kill and die
// emitted) but still exists until FinishRemoval (destroy). See FakeContainer.removing.
func (f *Fake) BeginRemoval(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.Containers[id]; ok {
		c.State, c.Health, c.ExitCode, c.removing = "exited", "", 137, true
	}
}

// FinishRemoval completes the deletion that BeginRemoval started.
func (f *Fake) FinishRemoval(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.Containers, id)
	for _, w := range f.logPipes[id] {
		w.Close()
	}
	delete(f.logPipes, id)
}

// SetHealth lets tests simulate the healthcheck.
func (f *Fake) SetHealth(id, health string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.Containers[id]; ok {
		c.Health = health
	}
}

// Crash simulates the container's process ending with exitCode (without emitting events: the test emits the die).
func (f *Fake) Crash(id string, exitCode int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.Containers[id]; ok {
		c.State, c.Health, c.ExitCode = "exited", "", exitCode
	}
}
