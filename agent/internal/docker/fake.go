package docker

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

// Fake es un Engine en memoria para tests. Los campos exportados permiten
// inspeccionar llamadas e inyectar fallos.
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
	logPipes   map[string][]*io.PipeWriter
	events     []chan Event
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
}

func NewFake() *Fake {
	return &Fake{Containers: map[string]*FakeContainer{}, Images: map[string]bool{}, Networks: map[string]bool{}, logPipes: map[string][]*io.PipeWriter{}}
}

func (f *Fake) record(format string, args ...any) {
	f.Calls = append(f.Calls, fmt.Sprintf(format, args...))
}

func (f *Fake) Version(context.Context) (string, error) { return "fake-29.0", nil }

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
			out = append(out, Container{ID: c.ID, Name: c.Name, State: c.State, Labels: c.Config.Labels})
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
		labels = c.Config.Labels
	}
	return &Inspect{ID: c.ID, Name: c.Name, State: c.State, Running: c.State == "running", Health: c.Health, ExitCode: c.ExitCode, StartedAt: c.StartedAt, Labels: labels}, nil
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
			return "", fmt.Errorf("conflict: el nombre %q ya está en uso", name)
		}
	}
	f.seq++
	id := fmt.Sprintf("fake%04d", f.seq)
	f.Containers[id] = &FakeContainer{ID: id, Name: name, State: "created", Config: cfg, HostConfig: host, Net: net}
	return id, nil
}

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
	c.State, c.StartedAt, c.Health = "running", time.Now(), "starting"
	return nil
}

func (f *Fake) Stop(_ context.Context, id string, timeout time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Stop %s %s", id, timeout)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	c.State, c.Health, c.ExitCode = "exited", "", 0
	return nil
}

func (f *Fake) Kill(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Kill %s", id)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	c.State, c.Health, c.ExitCode = "exited", "", 137
	return nil
}

func (f *Fake) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("Remove %s", id)
	if _, ok := f.Containers[id]; !ok {
		return ErrNotFound
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

// WriteLog empuja una línea a todos los lectores de Logs del contenedor.
func (f *Fake) WriteLog(id, line string) {
	f.mu.Lock()
	ws := append([]*io.PipeWriter(nil), f.logPipes[id]...)
	f.mu.Unlock()
	for _, w := range ws {
		_, _ = io.WriteString(w, line)
	}
}

func (f *Fake) Events(ctx context.Context) (<-chan Event, <-chan error) {
	ch := make(chan Event, 16)
	errs := make(chan error, 1)
	f.mu.Lock()
	f.events = append(f.events, ch)
	f.mu.Unlock()
	go func() {
		<-ctx.Done()
		f.mu.Lock()
		defer f.mu.Unlock()
		for i, c := range f.events {
			if c == ch {
				f.events = append(f.events[:i], f.events[i+1:]...)
				break
			}
		}
	}()
	return ch, errs
}

// EmitEvent entrega un evento a todos los suscriptores de Events.
func (f *Fake) EmitEvent(ev Event) {
	f.mu.Lock()
	chans := append([]chan Event(nil), f.events...)
	f.mu.Unlock()
	for _, c := range chans {
		c <- ev
	}
}

// SetHealth permite a los tests simular el healthcheck.
func (f *Fake) SetHealth(id, health string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.Containers[id]; ok {
		c.Health = health
	}
}
