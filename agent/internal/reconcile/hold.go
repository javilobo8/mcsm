package reconcile

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrBusy: el servidor tiene en curso una copia o una restauración.
var ErrBusy = errors.New("el servidor está ocupado con otra copia o restauración")

// Hold reserva un servidor para una operación de mantenimiento (copia, restauración).
// Mientras dure, la reconciliación (Apply, la de fondo tras StoreForce/SyncSpecs, ticks)
// solo deja la spec guardada y se aplaza —un cambio de spec no recrea el contenedor a
// mitad de una copia— y Power y Remove fallan con ErrBusy. Forget sí se aplica (solo toca
// el store): el borrado del contenedor queda en su lápida. Hold espera, sin plazo, a que
// termine la operación en curso sobre el servidor (toma el lock por servidor) y devuelve
// ErrBusy si ya estaba reservado.
//
// release libera la reserva y reconcilia el servidor: aplica la spec aplazada y lo vuelve a
// su estado deseado (lo arranca si una restauración lo paró) o, si un Forget lo retiró
// durante la reserva, completa el borrado de su contenedor. Es idempotente. La reserva se
// quita SIEMPRE; ctx solo acota esa reconciliación o borrado (con ctx ya cancelado falla,
// queda en Observed/backoff y la completa el siguiente tick).
//
// Ni Hold ni release se pueden llamar desde el observer: se ejecuta con el lock del
// servidor tomado y se bloquearían. Orden de locks: lock por servidor → r.mu, nunca al revés.
func (r *Reconciler) Hold(serverID, reason string) (release func(ctx context.Context), err error) {
	unlock := r.lock(serverID)
	defer unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	if cur, ok := r.held[serverID]; ok {
		return nil, fmt.Errorf("%w (%s)", ErrBusy, cur)
	}
	if reason == "" {
		reason = "mantenimiento" // un motivo vacío desactivaría las comprobaciones de heldReason
	}
	if r.held == nil {
		r.held = map[string]string{}
	}
	r.held[serverID] = reason
	var once sync.Once
	return func(ctx context.Context) {
		once.Do(func() {
			unlock := r.lock(serverID)
			defer unlock()
			r.mu.Lock()
			delete(r.held, serverID)
			r.mu.Unlock()
			// Un Forget durante la reserva dejó lápida: se completa el borrado ahora.
			if tomb, err := r.st.HasTombstone(serverID); err == nil && tomb {
				if err := r.removeTombstoned(ctx, serverID); err != nil {
					r.log.Warn("borrar al liberar la reserva un servidor retirado", "server", serverID, "err", err)
				}
				return
			}
			if err := r.reconcileLocked(ctx, serverID); err != nil {
				r.log.Warn("reconciliar al liberar la reserva", "server", serverID, "err", err)
			}
		})
	}, nil
}

// Held indica si el servidor está reservado por Hold.
func (r *Reconciler) Held(serverID string) bool { return r.heldReason(serverID) != "" }

func (r *Reconciler) heldReason(serverID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.held[serverID]
}
