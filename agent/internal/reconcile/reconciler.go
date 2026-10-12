// Package reconcile mantiene los contenedores Docker iguales a las specs del store.
//
// Invariante (spec §6.2): el reconciliador nunca borra contenedores mcsm.* por
// iniciativa propia. Solo los elimina al recrear por un cambio de spec enviado por
// el panel (Reconcile) o cuando el panel lo ordena explícitamente (Remove).
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/mc"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

const (
	StopTimeout = 60 * time.Second
	baseBackoff = 30 * time.Second
	maxBackoff  = 5 * time.Minute
)

type Observer func(serverID string, obs *mcsmv1.Observed)

type Reconciler struct {
	st       *store.Store
	eng      docker.Engine
	dataRoot string
	network  string
	status   mc.StatusFunc
	observer Observer
	log      *slog.Logger

	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	retryAt map[string]time.Time
	fails   map[string]int
	now     func() time.Time
}

func New(st *store.Store, eng docker.Engine, dataRoot, network string, status mc.StatusFunc, obs Observer) *Reconciler {
	if obs == nil {
		obs = func(string, *mcsmv1.Observed) {}
	}
	return &Reconciler{
		st: st, eng: eng, dataRoot: dataRoot, network: network, status: status, observer: obs,
		log:   slog.Default().With("component", "reconcile"),
		locks: map[string]*sync.Mutex{}, retryAt: map[string]time.Time{}, fails: map[string]int{},
		now: time.Now,
	}
}

func (r *Reconciler) lock(id string) func() {
	r.mu.Lock()
	m, ok := r.locks[id]
	if !ok {
		m = &sync.Mutex{}
		r.locks[id] = m
	}
	r.mu.Unlock()
	m.Lock()
	return m.Unlock
}

func isActive(state string) bool {
	return state == "running" || state == "restarting" || state == "paused"
}

// ReconcileAll recorre todas las specs, saltando las que están en backoff.
func (r *Reconciler) ReconcileAll(ctx context.Context) {
	specs, err := r.st.ListSpecs()
	if err != nil {
		r.log.Error("listar specs", "err", err)
		return
	}
	for _, sp := range specs {
		r.mu.Lock()
		until, waiting := r.retryAt[sp.ServerId]
		r.mu.Unlock()
		if waiting && r.now().Before(until) {
			continue
		}
		if err := r.Reconcile(ctx, sp.ServerId); err != nil {
			r.log.Warn("reconciliar", "server", sp.Slug, "err", err)
		}
	}
}

// Reconcile aplica la spec de un servidor y siempre publica el estado observado.
// Un fallo queda en Observed.Error y programa un reintento con backoff.
func (r *Reconciler) Reconcile(ctx context.Context, serverID string) (err error) {
	unlock := r.lock(serverID)
	defer unlock()
	defer func() {
		obs := r.observeLocked(ctx, serverID)
		if err != nil {
			obs.Error = err.Error()
			r.markFailure(serverID)
		} else {
			r.clearFailure(serverID)
		}
		r.observer(serverID, obs)
	}()

	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	if sp == nil {
		return nil
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return err
	}
	build, err := spec.BuildContainer(spec.Meta{ServerID: sp.ServerId, Slug: sp.Slug, Version: sp.Version}, parsed, r.dataRoot, r.network)
	if err != nil {
		return err
	}
	wantRunning := sp.DesiredState == mcsmv1.DesiredState_DESIRED_STATE_RUNNING

	existing, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if existing != nil && existing.Labels[spec.LabelHash] != build.Hash {
		r.log.Info("spec cambiada, recreando contenedor", "server", sp.Slug)
		if isActive(existing.State) {
			if err := r.eng.Stop(ctx, existing.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
				return fmt.Errorf("parar: %w", err)
			}
		}
		if err := r.eng.Remove(ctx, existing.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return fmt.Errorf("eliminar: %w", err)
		}
		existing = nil
	}
	if existing == nil {
		if err := os.MkdirAll(build.DataDir, 0o755); err != nil {
			return fmt.Errorf("crear directorio de datos: %w", err)
		}
		if err := r.eng.EnsureImage(ctx, build.Config.Image); err != nil {
			return err
		}
		id, err := r.eng.Create(ctx, build.Name, build.Config, build.HostConfig, build.Networking)
		if err != nil {
			return fmt.Errorf("crear contenedor: %w", err)
		}
		existing = &docker.Container{ID: id, Name: build.Name, State: "created", Labels: build.Config.Labels}
	}
	switch {
	case wantRunning && existing.State != "running" && existing.State != "restarting":
		if err := r.eng.Start(ctx, existing.ID); err != nil {
			return fmt.Errorf("arrancar: %w", err)
		}
	case !wantRunning && isActive(existing.State):
		if err := r.eng.Stop(ctx, existing.ID, StopTimeout); err != nil {
			return fmt.Errorf("parar: %w", err)
		}
	}
	return r.st.SetApplied(serverID, sp.Version)
}

// Remove para y borra el contenedor; con deleteData borra también <dataRoot>/<slug>.
// Solo se invoca cuando el panel lo indica.
func (r *Reconciler) Remove(ctx context.Context, serverID string, deleteData bool) error {
	unlock := r.lock(serverID)
	defer unlock()
	c, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if c != nil {
		if isActive(c.State) {
			_ = r.eng.Stop(ctx, c.ID, StopTimeout)
		}
		if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return err
		}
	}
	if deleteData {
		sp, _ := r.st.GetSpec(serverID)
		slug := ""
		if sp != nil {
			slug = sp.Slug
		} else if c != nil {
			slug = c.Labels[spec.LabelSlug]
		}
		if slug != "" {
			if err := os.RemoveAll(filepath.Join(r.dataRoot, slug)); err != nil {
				return fmt.Errorf("borrar datos: %w", err)
			}
		}
	}
	r.clearFailure(serverID)
	return nil
}

// Power actualiza el estado deseado en el store y ejecuta la acción.
func (r *Reconciler) Power(ctx context.Context, serverID string, action mcsmv1.PowerActionType) (err error) {
	unlock := r.lock(serverID)
	defer unlock()
	defer func() {
		obs := r.observeLocked(ctx, serverID)
		if err != nil {
			obs.Error = err.Error()
		}
		r.observer(serverID, obs)
	}()
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	if sp == nil {
		return fmt.Errorf("servidor %s desconocido", serverID)
	}
	var desired mcsmv1.DesiredState
	switch action {
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_START, mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART:
		desired = mcsmv1.DesiredState_DESIRED_STATE_RUNNING
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP, mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL:
		desired = mcsmv1.DesiredState_DESIRED_STATE_STOPPED
	default:
		return fmt.Errorf("acción desconocida %v", action)
	}
	if desired != sp.DesiredState {
		sp.DesiredState = desired
		if err := r.st.PutSpec(sp); err != nil {
			return err
		}
	}
	c, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if c == nil {
		return fmt.Errorf("el contenedor no existe todavía; aplica la spec primero")
	}
	switch action {
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_START:
		if c.State != "running" {
			return r.eng.Start(ctx, c.ID)
		}
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP:
		if isActive(c.State) {
			return r.eng.Stop(ctx, c.ID, StopTimeout)
		}
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART:
		if isActive(c.State) {
			if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil {
				return err
			}
		}
		return r.eng.Start(ctx, c.ID)
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL:
		// Docker devuelve conflicto al matar algo que no corre: solo matamos si está activo.
		if isActive(c.State) {
			return r.eng.Kill(ctx, c.ID)
		}
	}
	return nil
}

// Observe calcula el estado real y lo publica.
func (r *Reconciler) Observe(ctx context.Context, serverID string) *mcsmv1.Observed {
	unlock := r.lock(serverID)
	obs := r.observeLocked(ctx, serverID)
	unlock()
	r.observer(serverID, obs)
	return obs
}

// ContainerID devuelve el id del contenedor del servidor, o "" si no existe.
func (r *Reconciler) ContainerID(ctx context.Context, serverID string) string {
	c, err := r.find(ctx, serverID)
	if err != nil || c == nil {
		return ""
	}
	return c.ID
}

func (r *Reconciler) observeLocked(ctx context.Context, serverID string) *mcsmv1.Observed {
	obs := &mcsmv1.Observed{State: "missing", Mc: &mcsmv1.McStatus{}}
	obs.AppliedVersion, _ = r.st.Applied(serverID)
	c, err := r.find(ctx, serverID)
	if err != nil {
		obs.Error = err.Error()
		return obs
	}
	if c == nil {
		return obs
	}
	ins, err := r.eng.Inspect(ctx, c.ID)
	if err != nil {
		if errors.Is(err, docker.ErrNotFound) {
			return obs
		}
		obs.Error = err.Error()
		return obs
	}
	obs.ContainerId = ins.ID
	obs.State = ins.State
	obs.Health = ins.Health
	obs.ExitCode = int32(ins.ExitCode)
	if !ins.StartedAt.IsZero() {
		obs.StartedAtUnix = ins.StartedAt.Unix()
	}
	if ins.Running && r.status != nil {
		obs.Mc = r.status(ctx, spec.ContainerName(ins.Labels[spec.LabelSlug]), uint16(spec.GamePort))
	}
	return obs
}

func (r *Reconciler) find(ctx context.Context, serverID string) (*docker.Container, error) {
	list, err := r.eng.ListManaged(ctx)
	if err != nil {
		return nil, fmt.Errorf("listar contenedores: %w", err)
	}
	for i := range list {
		if list[i].Labels[spec.LabelServerID] == serverID {
			return &list[i], nil
		}
	}
	return nil, nil
}

func (r *Reconciler) markFailure(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := r.fails[id]
	wait := maxBackoff
	if n < 10 {
		if w := baseBackoff << n; w < maxBackoff {
			wait = w
		}
	}
	r.fails[id] = n + 1
	r.retryAt[id] = r.now().Add(wait)
}

func (r *Reconciler) clearFailure(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.fails, id)
	delete(r.retryAt, id)
}
