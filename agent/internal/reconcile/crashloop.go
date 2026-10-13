package reconcile

import (
	"context"
	"errors"
	"fmt"

	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

// EventSink recibe incidencias del reconciliador (plan-9: drift). Se invoca con el lock del servidor tomado: no
// puede bloquear ni llamar al reconciliador (App la conecta a su cola de eventos, que nunca bloquea).
type EventSink func(serverID, kind, message string)

// KindDrift: el contenedor no coincidía con la spec ya aplicada y se ha recreado.
const KindDrift = "drift"

// SetEventSink fija el receptor de incidencias. Se llama antes de lanzar goroutines (App.New).
func (r *Reconciler) SetEventSink(fn EventSink) { r.events = fn }

// CrashLoopMessage es el error visible (Observed.error) de un servidor retenido por bucle de crash.
func CrashLoopMessage(crashes int) string {
	return fmt.Sprintf("Parado por bucle de crash: se cerró con error %d veces en menos de una hora. Revisa la consola y pulsa Arrancar para volver a intentarlo", crashes)
}

// crashLatched devuelve la retención de serverID si es de esta versión de su spec. Una retención de otra versión
// (llegó una spec nueva) se borra. Con el lock del servidor tomado.
func (r *Reconciler) crashLatched(serverID string, version uint64) (*store.CrashLatch, error) {
	l, err := r.st.CrashLatch(serverID)
	if err != nil || l == nil {
		return nil, err
	}
	if l.Version != version {
		return nil, r.st.DeleteCrashLatch(serverID)
	}
	return l, nil
}

// CrashLoopStop para un servidor en bucle de crash (spec §10) y lo retiene en la versión actual de su spec: la
// reconciliación no lo vuelve a arrancar (aunque SyncSpecs reenvíe «en marcha») hasta un Power start/restart o
// una versión nueva. El estado deseado no cambia (lo decide el panel). Busy si el servidor está reservado.
func (r *Reconciler) CrashLoopStop(ctx context.Context, serverID string, crashes int) error {
	unlock := r.lock(serverID)
	defer unlock()
	return r.crashLoopStopLocked(ctx, serverID, crashes)
}

// StartGen es el número de Power start/restart de serverID hasta ahora (ver CrashLoopStopUnlessStarted).
func (r *Reconciler) StartGen(serverID string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.startGen[serverID]
}

// CrashLoopStopUnlessStarted es CrashLoopStop salvo si, desde que se decidió (gen = StartGen en ese momento), alguien
// arrancó o reinició el servidor a mano: entonces no hace nada y devuelve false. La comprobación va bajo el lock del
// servidor, el mismo que toma Power.
func (r *Reconciler) CrashLoopStopUnlessStarted(ctx context.Context, serverID string, crashes int, gen uint64) (bool, error) {
	unlock := r.lock(serverID)
	defer unlock()
	if r.StartGen(serverID) != gen {
		return false, nil
	}
	return true, r.crashLoopStopLocked(ctx, serverID, crashes)
}

// crashLoopStopLocked es CrashLoopStop con el lock del servidor tomado.
func (r *Reconciler) crashLoopStopLocked(ctx context.Context, serverID string, crashes int) error {
	if reason := r.heldReason(serverID); reason != "" {
		return Busy(reason)
	}
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	if sp == nil {
		return fmt.Errorf("servidor %s desconocido", serverID)
	}
	if err := r.st.PutCrashLatch(serverID, store.CrashLatch{Version: sp.Version, Crashes: crashes, At: r.now()}); err != nil {
		return err
	}
	var stopErr error
	c, err := r.find(ctx, serverID)
	if err != nil {
		stopErr = err
	} else if c != nil && isActive(c.State) { // también «restarting»: la política de reinicio lo está rearrancando
		if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			stopErr = fmt.Errorf("parar: %w", err)
		}
	}
	obs := r.observeLocked(ctx, serverID)
	if stopErr != nil {
		obs.Error = stopErr.Error()
	}
	r.observer(serverID, obs)
	return stopErr
}

// StartBlocked es el motivo por el que nadie (mc-router, a través del proxy del socket) debe arrancar el servidor
// ahora: una reserva (copia, restauración, migración…), la retención por bucle de crash o que el agente no lo
// conozca. "" si puede arrancar. Sin lock: es una foto, como la que vería quien lo arranca.
func (r *Reconciler) StartBlocked(serverID string) string {
	if reason := r.heldReason(serverID); reason != "" {
		return Busy(reason).Error()
	}
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err.Error()
	}
	if sp == nil {
		return "servidor desconocido en este nodo"
	}
	if l, err := r.st.CrashLatch(serverID); err == nil && l != nil && l.Version == sp.Version {
		return CrashLoopMessage(l.Crashes)
	}
	return ""
}
