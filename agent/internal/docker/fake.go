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
	StatsErr   error               // si no es nil, Stats lo devuelve
	ImageEnvs  map[string][]string // plan-6: ENV de cada imagen, por referencia (ImageEnv)
	ConnectErr error               // plan-6: si no es nil, ConnectNetwork lo devuelve
	stats      map[string]Stats    // lecturas fijadas con SetStats, por id de contenedor
	logPipes   map[string][]*io.PipeWriter
	subs       []*eventSub
}

// eventSub es un suscriptor de Events.
type eventSub struct {
	ch   chan Event
	errs chan error
}

// eventBuffer es la capacidad del canal de eventos de cada suscriptor.
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
	Aliases    map[string][]string // plan-6: red → alias añadidos con ConnectNetwork
}

func NewFake() *Fake {
	return &Fake{Containers: map[string]*FakeContainer{}, Images: map[string]bool{}, Networks: map[string]bool{}, ImageEnvs: map[string][]string{}, logPipes: map[string][]*io.PipeWriter{}}
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

// hostPorts devuelve las claves "puerto/proto" de host publicadas por un contenedor.
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

// Start imita a Docker: sobre un contenedor ya running es no-op, y los puertos de
// host se enlazan aquí (no en Create), así que una colisión con otro contenedor
// running falla con "port is already allocated" dejando el contenedor en created.
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
	if c.State == "running" {
		return nil
	}
	mine := hostPorts(c.HostConfig)
	for _, o := range f.Containers {
		if o.ID == id || o.State != "running" {
			continue
		}
		for p := range hostPorts(o.HostConfig) {
			if mine[p] {
				return fmt.Errorf("driver failed programming external connectivity: Bind for 0.0.0.0:%s failed: port is already allocated", p)
			}
		}
	}
	c.State, c.StartedAt, c.Health = "running", time.Now(), "starting"
	return nil
}

// Stop: sobre un contenedor no running es no-op (created sigue created, exited
// conserva su ExitCode), como en Docker.
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

// Kill sobre un contenedor no running devuelve un error de conflicto (409).
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

// Events devuelve el canal de eventos y el de errores. Como en Moby, el canal de
// eventos se cierra cuando ctx termina; errs no se cierra.
func (f *Fake) Events(ctx context.Context) (<-chan Event, <-chan error) {
	sub := &eventSub{ch: make(chan Event, eventBuffer), errs: make(chan error, 1)}
	f.mu.Lock()
	f.subs = append(f.subs, sub)
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

// EmitEvent entrega un evento a todos los suscriptores activos de Events. Nunca
// bloquea: sin suscriptores, o con el buffer de un suscriptor lleno, el evento se
// descarta. Los suscriptores con ctx cancelado ya fueron retirados.
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

// EmitEventErr entrega un error a los suscriptores activos por el canal errs
// (mismo criterio de no bloqueo que EmitEvent).
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

// SetHealth permite a los tests simular el healthcheck.
func (f *Fake) SetHealth(id, health string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.Containers[id]; ok {
		c.Health = health
	}
}
