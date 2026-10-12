// Package reconcile mantiene los contenedores Docker iguales a las specs del store.
//
// Invariante (spec §6.2): el reconciliador nunca borra contenedores mcsm.* por
// iniciativa propia. Solo los elimina al recrear por un cambio de spec enviado por
// el panel (Reconcile) o cuando el panel lo ordena explícitamente (Remove, y su reintento
// por lápida tras SyncSpecs.removed_ids: RetryRemovals).
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
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
	failVer map[string]uint64
	lastErr map[string]string
	held    map[string]string // plan-4: servidores reservados por Hold (backup/restore) y su motivo
	heldErr map[string]string // plan-4: error visible en Observed de un servidor reservado (HoldError)
	adoptMu sync.Mutex        // plan-6: comprobar y registrar adopciones (un contenedor, un servidor); tras el lock por servidor
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
		failVer: map[string]uint64{}, lastErr: map[string]string{},
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

// ReconcileAll reintenta los borrados pendientes (lápidas) y recorre todas las specs,
// saltando las que están en backoff (salvo que la versión de la spec haya cambiado desde
// el último fallo). Los borrados van antes: un slug retirado y recreado con otro id
// reutiliza el nombre del contenedor.
func (r *Reconciler) ReconcileAll(ctx context.Context) {
	r.RetryRemovals(ctx)
	specs, err := r.st.ListSpecs()
	if err != nil {
		r.log.Error("listar specs", "err", err)
		return
	}
	for _, sp := range specs {
		if err := r.reconcileTick(ctx, sp.ServerId); err != nil {
			r.log.Warn("reconciliar", "server", sp.Slug, "err", err)
		}
	}
}

// reconcileTick reconcilia un servidor desde el tick: la comprobación de backoff se
// hace con el lock por servidor tomado para que dos ticks concurrentes no reintenten
// (ni escalen el backoff) dos veces. Ignora servidores sin spec.
func (r *Reconciler) reconcileTick(ctx context.Context, serverID string) error {
	unlock := r.lock(serverID)
	defer unlock()
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	if sp == nil {
		return nil
	}
	r.mu.Lock()
	until, waiting := r.retryAt[serverID]
	sameVersion := r.failVer[serverID] == sp.Version
	r.mu.Unlock()
	if waiting && sameVersion && r.now().Before(until) {
		return nil
	}
	return r.reconcileLocked(ctx, serverID)
}

// ReconcileTick reconcilia un solo servidor desde un tick periódico, respetando el
// backoff de fallos. Permite al llamador procesar cada servidor por separado.
func (r *Reconciler) ReconcileTick(ctx context.Context, serverID string) error {
	return r.reconcileTick(ctx, serverID)
}

// Reconcile aplica la spec de un servidor y siempre publica el estado observado.
// Un fallo queda en Observed.Error y programa un reintento con backoff.
func (r *Reconciler) Reconcile(ctx context.Context, serverID string) error {
	unlock := r.lock(serverID)
	defer unlock()
	return r.reconcileLocked(ctx, serverID)
}

// Apply guarda la spec y la reconcilia, todo bajo el lock del servidor. Una spec con
// versión menor que la guardada (fuera de orden) se ignora y devuelve nil.
func (r *Reconciler) Apply(ctx context.Context, sp *mcsmv1.ServerSpec) error {
	unlock := r.lock(sp.ServerId)
	defer unlock()
	stored, err := r.st.GetSpec(sp.ServerId)
	if err != nil {
		return err
	}
	if stored != nil && sp.Version < stored.Version {
		r.log.Info("spec fuera de orden ignorada", "server", sp.Slug, "version", sp.Version, "guardada", stored.Version)
		return nil
	}
	if err := r.st.PutSpec(sp); err != nil { // anula la lápida del id, si la hay
		return err
	}
	return r.reconcileLocked(ctx, sp.ServerId)
}

// StoreForce guarda la spec sin guarda de versión y sin tocar Docker. Es para
// SyncSpecs, donde el panel es la verdad al reconectar (p. ej. tras restaurar su base
// de datos): la reconciliación va después, en segundo plano. Limpia el backoff para
// que esa reconciliación (y el siguiente tick) no espere por fallos de otra spec.
func (r *Reconciler) StoreForce(sp *mcsmv1.ServerSpec) error {
	unlock := r.lock(sp.ServerId)
	defer unlock()
	if err := r.st.PutSpec(sp); err != nil { // anula la lápida del id, si la hay
		return err
	}
	r.clearFailure(sp.ServerId)
	return nil
}

// Forget borra la spec de un servidor retirado por el panel (bajo su lock, para que
// ningún tick lo resucite) sin tocar Docker. El contenedor se para y se borra después
// con Remove, que también funciona sin spec; hasta que ese borrado termina bien queda una
// lápida y el tick lo reintenta (RetryRemovals).
func (r *Reconciler) Forget(serverID string) error {
	unlock := r.lock(serverID)
	defer unlock()
	// Spec fuera y lápida dentro en una sola transacción: tras un Forget, el contenedor
	// siempre tiene spec o lápida.
	if err := r.st.ForgetWithTombstone(serverID, r.now()); err != nil {
		return err
	}
	r.clearFailure(serverID)
	return nil
}

func (r *Reconciler) reconcileLocked(ctx context.Context, serverID string) (err error) {
	// plan-4: con el servidor reservado (Hold) no se toca Docker ni se publica nada.
	if reason := r.heldReason(serverID); reason != "" {
		// La spec ya está guardada: se aplicará al liberar la reserva (Hold).
		r.log.Info("reconciliación aplazada", "server", serverID, "motivo", reason)
		return nil
	}
	var version uint64
	defer func() {
		if err != nil {
			r.markFailure(serverID, version, err.Error())
		} else {
			r.clearFailure(serverID)
		}
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
		return nil
	}
	version = sp.Version
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
	// plan-6: un importado sin registro de adopción (ImportAdopt perdido, store nuevo) se vuelve a
	// adoptar; si su contenedor original ya no existe, se crea el gestionado.
	if existing == nil && parsed.Adopt != nil {
		if existing, err = r.readopt(ctx, sp, parsed, build.DataDir); err != nil {
			return err
		}
	}
	// plan-6 (H1): un dataPath solo se monta si el agente lo verificó para este servidor. Antes de tocar
	// Docker: un cambio de spec no debe parar el original para luego no poder crear.
	if err := r.checkDataPath(ctx, serverID, parsed, existing); err != nil {
		return err
	}
	recreate := false
	switch {
	case existing != nil && existing.Adopted:
		// plan-6: el original sigue mientras la spec no supere la versión de la adopción.
		ad, aerr := r.st.Adoption(serverID)
		if aerr != nil {
			return aerr
		}
		if ad != nil && sp.Version > ad.Version {
			r.log.Info("primer cambio de spec de un importado: se recrea con etiquetas mcsm", "server", sp.Slug, "original", existing.Name)
			recreate = true
		}
	case existing != nil && existing.Labels[spec.LabelHash] != build.Hash:
		r.log.Info("spec cambiada, recreando contenedor", "server", sp.Slug)
		recreate = true
	}
	// plan-6 (M2): antes de crear el gestionado de un importado (y antes de parar el que se sustituye),
	// ningún otro contenedor itzg puede montar ya su carpeta de datos.
	if (existing == nil || recreate) && (parsed.Adopt != nil || parsed.DataPath != "") {
		exclude := ""
		if existing != nil {
			exclude = existing.ID
		}
		if err := r.checkDataFree(ctx, build.DataDir, exclude); err != nil {
			return err
		}
	}
	if recreate {
		if err := r.replace(ctx, existing); err != nil {
			return err
		}
		existing = nil
	}
	if existing == nil {
		// plan-6: una adopción cuyo contenedor ya no está (o se acaba de sustituir) sobra.
		if err := r.st.DeleteAdoption(serverID); err != nil {
			return err
		}
		// plan-6: con dataPath la carpeta es del host y el agente no la ve (solo monta DATA_ROOT). Va
		// en Mounts (M3): si no existe, Docker falla al crear en vez de crearla vacía.
		if parsed.DataPath == "" {
			if err := os.MkdirAll(build.DataDir, 0o755); err != nil {
				return fmt.Errorf("crear directorio de datos: %w", err)
			}
		}
		if err := r.eng.EnsureImage(ctx, build.Config.Image); err != nil {
			return fmt.Errorf("descargar imagen: %w", err)
		}
		id, err := r.eng.Create(ctx, build.Name, build.Config, build.HostConfig, build.Networking)
		if err != nil {
			return fmt.Errorf("crear contenedor: %w", err)
		}
		existing = &docker.Container{ID: id, Name: build.Name, State: "created", Labels: build.Config.Labels}
	}
	switch {
	// En pausa cuenta como activo: Docker no arranca un contenedor en pausa (hay que reanudarlo) y el
	// panel nunca pausa; se deja como está (plan-6, m6: un importado en pausa).
	case wantRunning && !isActive(existing.State):
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

// Remove borra la spec (bajo el lock, antes de parar, para que ningún tick lo
// resucite), para y borra el contenedor; con deleteData borra también <dataRoot>/<slug>.
// Solo se invoca cuando el panel lo indica. Si el servidor tenía lápida (Forget), la quita
// cuando el borrado termina bien; si falla, la lápida sigue y el tick lo reintenta.
func (r *Reconciler) Remove(ctx context.Context, serverID string, deleteData bool) error {
	unlock := r.lock(serverID)
	defer unlock()
	// plan-4: un servidor reservado (Hold) no se borra a mitad de una copia o restauración.
	if reason := r.heldReason(serverID); reason != "" {
		return Busy(reason)
	}
	return r.removeLocked(ctx, serverID, deleteData)
}

// removeLocked es Remove con el lock del servidor tomado.
func (r *Reconciler) removeLocked(ctx context.Context, serverID string, deleteData bool) error {
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	c, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	slug := ""
	if sp != nil {
		slug = sp.Slug
	} else if c != nil {
		slug = c.Labels[spec.LabelSlug]
	}
	if sp == nil && c == nil {
		if err := r.st.DeleteTombstone(serverID); err != nil { // nada que borrar
			return err
		}
		if err := r.st.DeleteAdoption(serverID); err != nil { // plan-6: su contenedor ya no existe
			return err
		}
		r.clearFailure(serverID)
		if deleteData {
			return fmt.Errorf("servidor %s desconocido: no se pueden borrar sus datos", serverID)
		}
		return nil // ya borrado: idempotente (el panel reenvía removed_ids al reconectar)
	}
	// Validar antes de tocar nada: un slug inválido no debe dejar el borrado a medias.
	var target string
	if deleteData {
		// plan-6: los datos de un importado con dataPath están fuera de DATA_ROOT: no se borran.
		if sp != nil {
			if p, perr := spec.Parse(sp.SpecJson); perr == nil && p.DataPath != "" {
				return fmt.Errorf("los datos de %s están en %s, fuera de DATA_ROOT: el agente no los borra", slug, p.DataPath)
			}
		}
		target, err = r.dataPath(slug)
		if err != nil {
			return err
		}
	}
	if err := r.st.DeleteSpec(serverID); err != nil {
		return err
	}
	if sp != nil {
		// Sin spec (lápida) el backoff del reintento se conserva hasta que el borrado termine.
		r.clearFailure(serverID)
	}
	if c != nil {
		if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			r.log.Warn("parada limpia fallida antes de borrar", "server", slug, "err", err)
		}
		if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return err
		}
	}
	// plan-6: el contenedor del servidor (adoptado o no) ya no existe.
	if err := r.st.DeleteAdoption(serverID); err != nil {
		return err
	}
	if deleteData {
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("borrar datos: %w", err)
		}
	}
	if sp == nil {
		if err := r.st.DeleteTombstone(serverID); err != nil { // el borrado pendiente terminó
			return err
		}
		r.clearFailure(serverID)
	}
	return nil
}

// dataPath devuelve <dataRoot>/<slug> solo si el slug es válido y la ruta queda
// estrictamente dentro de dataRoot.
func (r *Reconciler) dataPath(slug string) (string, error) {
	if !spec.ValidSlug(slug) {
		return "", fmt.Errorf("slug inválido %q: no se borran datos", slug)
	}
	root := filepath.Clean(r.dataRoot)
	target := filepath.Clean(filepath.Join(root, slug))
	if !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", fmt.Errorf("ruta de datos fuera de DATA_ROOT: %q", target)
	}
	return target, nil
}

// Power ejecuta una acción de encendido. El estado deseado solo se persiste si la
// acción Docker tiene éxito (el panel tampoco lo cambia sin Ack): un fallo lo deja como
// estaba y el error queda en Observed hasta la siguiente reconciliación con éxito.
// Sin contenedor, fija el deseado y reconcilia (crea y arranca, o lo deja parado); si
// eso falla, restaura el deseado anterior.
func (r *Reconciler) Power(ctx context.Context, serverID string, action mcsmv1.PowerActionType) (err error) {
	unlock := r.lock(serverID)
	defer unlock()
	// plan-4: antes del defer que publica: "ocupado" no es un error del servidor.
	if reason := r.heldReason(serverID); reason != "" {
		return Busy(reason)
	}
	published := false
	defer func() {
		if published {
			return
		}
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
	c, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if c == nil {
		prev := sp.DesiredState
		if err := r.putDesired(sp, desired); err != nil {
			return err
		}
		published = true // reconcileLocked publica el estado observado
		if err := r.reconcileLocked(ctx, serverID); err != nil {
			if rerr := r.putDesired(sp, prev); rerr != nil {
				r.log.Error("restaurar el estado deseado", "server", sp.Slug, "err", rerr)
			}
			return err
		}
		return nil
	}
	if err := r.powerContainer(ctx, c, action); err != nil {
		r.setLastErr(serverID, err.Error())
		return err
	}
	return r.putDesired(sp, desired)
}

// powerContainer ejecuta la acción sobre un contenedor existente.
func (r *Reconciler) powerContainer(ctx context.Context, c *docker.Container, action mcsmv1.PowerActionType) error {
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

// putDesired persiste el estado deseado si cambia.
func (r *Reconciler) putDesired(sp *mcsmv1.ServerSpec, d mcsmv1.DesiredState) error {
	if sp.DesiredState == d {
		return nil
	}
	sp.DesiredState = d
	return r.st.PutSpec(sp)
}

// Observe calcula el estado real y lo publica.
func (r *Reconciler) Observe(ctx context.Context, serverID string) *mcsmv1.Observed {
	unlock := r.lock(serverID)
	obs := r.observeLocked(ctx, serverID)
	unlock()
	r.observer(serverID, obs)
	return obs
}

// Container devuelve el contenedor del servidor: nil sin error si no existe, y el error de
// Docker si no se pudo comprobar. plan-4: las copias y restauraciones lo necesitan para no
// tomar un fallo de Docker por «no hay contenedor» (copia en caliente sin save-off,
// restauración con el servidor en marcha).
func (r *Reconciler) Container(ctx context.Context, serverID string) (*docker.Container, error) {
	return r.find(ctx, serverID)
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
	r.mu.Lock()
	obs.Error = r.lastErr[serverID]
	if msg := r.heldErr[serverID]; msg != "" {
		obs.Error = msg // plan-4: reservado y sin poder arrancar (HoldError)
	}
	r.mu.Unlock()
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
		// plan-6: el slug del contenedor encontrado (el adoptado no tiene etiquetas en Docker).
		obs.Mc = r.status(ctx, spec.ContainerName(c.Labels[spec.LabelSlug]), uint16(spec.GamePort))
	}
	return obs
}

// find devuelve el contenedor del servidor: el gestionado (etiqueta mcsm.server_id) o, si no hay,
// el adoptado (plan-6). nil sin error si no existe.
func (r *Reconciler) find(ctx context.Context, serverID string) (*docker.Container, error) {
	c, err := r.findManaged(ctx, serverID)
	if err != nil || c != nil {
		return c, err
	}
	return r.findAdopted(ctx, serverID)
}

func (r *Reconciler) findManaged(ctx context.Context, serverID string) (*docker.Container, error) {
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

// replace para y borra un contenedor para recrearlo. Siempre Stop (Docker no hace nada sobre uno
// parado): evita decidir con una foto del estado. Los datos están en el bind.
func (r *Reconciler) replace(ctx context.Context, c *docker.Container) error {
	if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("parar: %w", err)
	}
	if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("eliminar: %w", err)
	}
	return nil
}

// markFailure registra un fallo de la versión ver. Si la versión cambió desde el
// último fallo, el backoff empieza de nuevo.
func (r *Reconciler) markFailure(id string, ver uint64, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failVer[id] != ver {
		r.fails[id] = 0
	}
	n := r.fails[id]
	wait := maxBackoff
	if n < 10 {
		if w := baseBackoff << n; w < maxBackoff {
			wait = w
		}
	}
	r.fails[id] = n + 1
	r.failVer[id] = ver
	r.lastErr[id] = msg
	r.retryAt[id] = r.now().Add(wait)
}

// setLastErr deja un error visible en Observed sin programar backoff (fallo de una
// acción manual): lo limpia la siguiente reconciliación con éxito.
func (r *Reconciler) setLastErr(id, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastErr[id] = msg
}

func (r *Reconciler) clearFailure(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.fails, id)
	delete(r.failVer, id)
	delete(r.lastErr, id)
	delete(r.retryAt, id)
}
