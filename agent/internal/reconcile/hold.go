package reconcile

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrBusy: the server is reserved (Hold: backup, restore or locked without data) or
// has something in progress that prevents the command. The text is neutral: each place adds the specific
// reason (Busy with the reservation's, or its own).
var ErrBusy = errors.New("server busy or reserved")

// Busy wraps ErrBusy with a reservation's reason: "server busy or reserved (restore)".
func Busy(reason string) error { return fmt.Errorf("%w (%s)", ErrBusy, reason) }

// Hold reserves a server for a maintenance operation (backup, restore).
// While it lasts, the reconciliation (Apply, the background one after StoreForce/SyncSpecs, ticks)
// only stores the spec and is deferred —a spec change does not recreate the container in
// the middle of a backup— and Power and Remove fail with ErrBusy. Forget is applied (it only touches
// the store): the container's deletion stays in its tombstone. Hold waits, with no deadline, for
// the operation in progress on the server to finish (it takes the per-server lock) and returns
// ErrBusy if it was already reserved.
//
// release releases the reservation and reconciles the server: it applies the deferred spec and returns it to
// its desired state (it starts it if a restore stopped it) or, if a Forget withdrew it
// during the reservation, completes the deletion of its container. It is idempotent. The reservation is
// ALWAYS removed; ctx only bounds that reconciliation or deletion (with ctx already cancelled it fails,
// stays in Observed/backoff and the next tick completes it).
//
// Neither Hold nor release can be called from the observer: it runs with the server's
// lock held and they would block. Lock order: per-server lock → r.mu, never the other way around.
func (r *Reconciler) Hold(serverID, reason string) (release func(ctx context.Context), err error) {
	unlock := r.lock(serverID)
	defer unlock()
	return r.holdLocked(serverID, reason)
}

// TryHold is Hold without waiting: if there is an operation in progress on the server (its lock is held: a
// reconciliation, an image pull, a Power) it returns ErrBusy immediately. plan-9: for short, optional
// reservations that must not be left waiting (the save-on retry).
func (r *Reconciler) TryHold(serverID, reason string) (release func(ctx context.Context), err error) {
	unlock, ok := r.tryLock(serverID)
	if !ok {
		return nil, Busy("operation in progress")
	}
	defer unlock()
	return r.holdLocked(serverID, reason)
}

// holdLocked is Hold with the server's lock held.
func (r *Reconciler) holdLocked(serverID, reason string) (release func(ctx context.Context), err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if cur, ok := r.held[serverID]; ok {
		return nil, Busy(cur)
	}
	if reason == "" {
		reason = "maintenance" // an empty reason would disable heldReason's checks
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
			delete(r.heldErr, serverID)
			r.mu.Unlock()
			// A Forget during the reservation left a tombstone: the deletion is completed now.
			if tomb, err := r.st.HasTombstone(serverID); err == nil && tomb {
				if err := r.removeTombstoned(ctx, serverID); err != nil {
					r.log.Warn("delete a withdrawn server when releasing the reservation", "server", serverID, "err", err)
				}
				return
			}
			if err := r.reconcileLocked(ctx, serverID); err != nil {
				r.log.Warn("reconcile when releasing the reservation", "server", serverID, "err", err)
			}
		})
	}, nil
}

// HoldError leaves msg as Observed's error for as long as serverID's reservation lasts. It is for
// a server that stays reserved, not started, until someone steps in (e.g. without a
// data directory after a failed restore): neither ticks nor SyncSpecs (StoreForce
// clears failures) delete it; it disappears when the reservation is released. Without a reservation it does nothing.
func (r *Reconciler) HoldError(serverID, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.held[serverID]; !ok {
		return
	}
	if r.heldErr == nil {
		r.heldErr = map[string]string{}
	}
	r.heldErr[serverID] = msg
}

// Held reports whether the server is reserved by Hold.
func (r *Reconciler) Held(serverID string) bool { return r.heldReason(serverID) != "" }

// HeldReason is the reason for the server's reservation, or "" if it is not reserved.
func (r *Reconciler) HeldReason(serverID string) string { return r.heldReason(serverID) }

func (r *Reconciler) heldReason(serverID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.held[serverID]
}
