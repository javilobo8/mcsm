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
// mitad de una copia— y Power y Remove fallan con ErrBusy. Hold espera a que termine la
// operación en curso sobre el servidor (toma el lock por servidor) y devuelve ErrBusy si
// ya estaba reservado.
//
// release libera la reserva y reconcilia el servidor: aplica la spec aplazada y lo vuelve a
// su estado deseado (lo arranca si una restauración lo paró). Es idempotente.
//
// Orden de locks: lock por servidor → r.mu, nunca al revés.
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
