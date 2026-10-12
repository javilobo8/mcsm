package router

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
)

const (
	// stopTimeout es la espera de una parada limpia del router antes de matarlo.
	stopTimeout = 10 * time.Second
	// RetryAfter es la espera tras un fallo antes de volver a tocar Docker con la misma spec (los
	// eventos del propio intento fallido no deben convertirse en un bucle de crear y borrar).
	RetryAfter = 25 * time.Second // menos que el tick de 30 s del agente: cada tick reintenta
)

// Store es lo que el router usa del store del agente (store.Store lo cumple).
type Store interface {
	RouterSpec() (*mcsmv1.RouterSpec, error)
	PutRouterSpec(*mcsmv1.RouterSpec) error
	DeleteRouterSpec() error
}

// Options configura un Manager. Name y SocketGID tienen valores por defecto.
type Options struct {
	// Name del contenedor: ContainerName si está vacío (los tests con Docker real usan mcsm-test-…).
	Name    string
	Network string
	// SocketGID devuelve el grupo propietario del socket de Docker del host; por defecto, el de
	// HostSocket (montado con la misma ruta en el agente).
	SocketGID func() (uint32, error)
	Now       func() time.Time
}

// Manager reconcilia el contenedor del router con la spec guardada: con spec, un contenedor igual a
// BuildContainer y en marcha; sin spec, ningún contenedor del router. Reconcile y las demás
// operaciones sobre Docker se serializan con mu.
type Manager struct {
	eng  docker.Engine
	st   Store
	opts Options

	mu        sync.Mutex
	lastErr   string    // error de la última reconciliación (bajo mu)
	failedAt  time.Time // cuándo falló (bajo mu)
	failedFor string    // specKey de la spec con la que falló (bajo mu)
	// autoscale refleja la spec guardada sin tomar mu: la lee el reconciliador de servidores con su
	// propio lock tomado mientras Reconcile puede estar esperando a Docker.
	autoscale atomic.Bool
}

// New crea el gestor y carga el autoscale de la spec guardada (reinicio del agente).
func New(eng docker.Engine, st Store, opts Options) *Manager {
	if opts.Name == "" {
		opts.Name = ContainerName
	}
	if opts.SocketGID == nil {
		opts.SocketGID = hostSocketGID
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

// hostSocketGID lee el grupo propietario del socket de Docker.
func hostSocketGID() (uint32, error) {
	fi, err := os.Stat(HostSocket)
	if err != nil {
		return 0, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errors.New("no se puede leer el propietario del socket")
	}
	return st.Gid, nil
}

// Apply valida y guarda la spec sin tocar Docker (el contenedor lo ajusta Reconcile).
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

// Clear borra la spec guardada sin tocar Docker (Reconcile retira el contenedor).
func (m *Manager) Clear() error {
	if err := m.st.DeleteRouterSpec(); err != nil {
		return err
	}
	m.autoscale.Store(false)
	return nil
}

// Autoscale indica si el router guardado arranca y para los servidores con hostname. No bloquea.
func (m *Manager) Autoscale() bool { return m.autoscale.Load() }

// specKey identifica una spec para la espera tras un fallo ("" = sin spec).
func specKey(sp *mcsmv1.RouterSpec) string {
	if sp == nil {
		return ""
	}
	return fmt.Sprintf("%d/%t/%d", sp.HostPort, sp.Autoscale, sp.AutoscaleDownAfterMinutes)
}

// Reconcile deja Docker igual que la spec guardada y devuelve el estado observado. Idempotente:
// recrea el contenedor si falta (borrado a mano) o si su hash no coincide (spec o imagen nuevas),
// lo arranca si está parado y, sin spec, lo borra. Un fallo (p. ej. el puerto del host ocupado)
// queda en RouterObserved.Error; con la misma spec no se reintenta hasta pasados RetryAfter (una
// spec nueva sí se aplica al momento).
func (m *Manager) Reconcile(ctx context.Context) *mcsmv1.RouterObserved {
	m.mu.Lock()
	defer m.mu.Unlock()
	sp, err := m.st.RouterSpec()
	if err != nil {
		m.lastErr = fmt.Sprintf("leer la spec del router: %v", err)
		return m.observeLocked(ctx)
	}
	key := specKey(sp)
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
	gid, err := m.opts.SocketGID()
	if err != nil {
		return fmt.Errorf("leer el grupo del socket de Docker %s (el router lo necesita): %w", HostSocket, err)
	}
	b, err := BuildContainer(sp, m.opts.Name, m.opts.Network, gid)
	if err != nil {
		return err
	}
	if existing != nil && existing.Labels[LabelHash] != b.Hash {
		if err := m.remove(ctx, existing); err != nil {
			return err
		}
		existing = nil
	}
	if existing == nil {
		if err := m.eng.EnsureImage(ctx, b.Config.Image); err != nil {
			return fmt.Errorf("descargar %s: %w", b.Config.Image, err)
		}
		id, err := m.eng.Create(ctx, b.Name, b.Config, b.HostConfig, b.Networking)
		if err != nil {
			return fmt.Errorf("crear el contenedor %s: %w", b.Name, err)
		}
		existing = &docker.Container{ID: id, Name: b.Name, State: "created"}
	}
	if existing.State != "running" && existing.State != "restarting" {
		if err := m.eng.Start(ctx, existing.ID); err != nil {
			// Docker (29.x) arranca SIN publicar puertos un contenedor cuyo arranque anterior falló por
			// el puerto del host: se borra para que el reintento lo cree de nuevo y vuelva a fallar
			// mientras el puerto siga ocupado, en vez de quedar «en marcha» e inalcanzable.
			if rerr := m.eng.Remove(ctx, existing.ID); rerr != nil && !errors.Is(rerr, docker.ErrNotFound) {
				return fmt.Errorf("arrancar el router en el puerto %d del host: %w (y no se pudo borrar: %v)", sp.HostPort, err, rerr)
			}
			return fmt.Errorf("arrancar el router en el puerto %d del host: %w", sp.HostPort, err)
		}
	}
	return nil
}

// remove para y borra el contenedor del router.
func (m *Manager) remove(ctx context.Context, c *docker.Container) error {
	if err := m.eng.Stop(ctx, c.ID, stopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("parar el router: %w", err)
	}
	if err := m.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("borrar el router: %w", err)
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
		obs.Configured, obs.HostPort, obs.Autoscale, obs.Image = true, sp.HostPort, sp.Autoscale, ImageRef()
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

// find busca el contenedor del router por su etiqueta y su nombre (nil si no existe).
func (m *Manager) find(ctx context.Context) (*docker.Container, error) {
	list, err := m.eng.ListManaged(ctx)
	if err != nil {
		return nil, fmt.Errorf("listar contenedores: %w", err)
	}
	for i := range list {
		if list[i].Labels[LabelRouter] == "true" && list[i].Name == m.opts.Name {
			return &list[i], nil
		}
	}
	return nil, nil
}
