package reconcile

import (
	"context"
	"errors"
	"fmt"

	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

// EventSink receives reconciler events (plan-9: drift). It is invoked with the server's lock held: it
// cannot block or call the reconciler (App wires it to its event queue, which never blocks).
type EventSink func(serverID, kind, message string)

// KindDrift: the container did not match the already applied spec and has been recreated.
const KindDrift = "drift"

// SetEventSink sets the event receiver. It is called before launching goroutines (App.New).
func (r *Reconciler) SetEventSink(fn EventSink) { r.events = fn }

// SetOnManualStart sets what is done when Power accepts a manual start or restart (plan-9: the crash
// count starts from zero). It is invoked with the server's lock held, before the Docker action: it cannot
// block or call the reconciler. It is called before launching goroutines (App.New).
func (r *Reconciler) SetOnManualStart(fn func(serverID string)) { r.onManualStart = fn }

// CrashLoopMessage is the visible error (Observed.error) of a server held by a crash loop.
func CrashLoopMessage(crashes int) string {
	return fmt.Sprintf("Stopped by a crash loop: it exited with an error %d times in less than an hour. Check the console and press Start to try again", crashes)
}

// crashLatched returns serverID's latch if it is from this version of its spec. A latch from another version
// (a new spec arrived) is deleted. With the server's lock held.
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

// CrashLoopStop stops a server in a crash loop (spec §10) and latches it at the current version of its spec: the
// reconciliation does not start it again (even if SyncSpecs resends "running") until a Power start/restart or
// a new version. The desired state does not change (the panel decides it). Busy if the server is reserved.
func (r *Reconciler) CrashLoopStop(ctx context.Context, serverID string, crashes int) error {
	unlock := r.lock(serverID)
	defer unlock()
	return r.crashLoopStopLocked(ctx, serverID, crashes)
}

// StartGen is the number of Power start/restart and of new spec versions of serverID so far (see
// CrashLoopStopUnlessStarted).
func (r *Reconciler) StartGen(serverID string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.startGen[serverID]
}

// CrashLoopStopUnlessStarted is CrashLoopStop unless, since it was decided (gen = StartGen at that moment), someone
// started or restarted the server by hand or a new version of its spec arrived: then it does nothing and returns false.
// The check goes under the server's lock, the same one Power, Apply and StoreForce take.
func (r *Reconciler) CrashLoopStopUnlessStarted(ctx context.Context, serverID string, crashes int, gen uint64) (bool, error) {
	unlock := r.lock(serverID)
	defer unlock()
	if r.StartGen(serverID) != gen {
		return false, nil
	}
	return true, r.crashLoopStopLocked(ctx, serverID, crashes)
}

// crashLoopStopLocked is CrashLoopStop with the server's lock held.
func (r *Reconciler) crashLoopStopLocked(ctx context.Context, serverID string, crashes int) error {
	if reason := r.heldReason(serverID); reason != "" {
		return Busy(reason)
	}
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err
	}
	if sp == nil {
		return fmt.Errorf("unknown server %s", serverID)
	}
	if err := r.st.PutCrashLatch(serverID, store.CrashLatch{Version: sp.Version, Crashes: crashes, At: r.now()}); err != nil {
		return err
	}
	var stopErr error
	c, err := r.find(ctx, serverID)
	if err != nil {
		stopErr = err
	} else if c != nil && isActive(c.State) { // also "restarting": the restart policy is restarting it
		if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			stopErr = fmt.Errorf("stop: %w", err)
		}
	}
	obs := r.observeLocked(ctx, serverID)
	if stopErr != nil {
		obs.Error = stopErr.Error()
	}
	r.observer(serverID, obs)
	return stopErr
}

// StartBlocked is the reason why nobody (mc-router, through the socket proxy) should start the server
// now: a reservation (backup, restore, migration…), the crash loop latch or the agent not
// knowing it. "" if it can start. Without a lock: it is a snapshot, like what whoever starts it would see.
func (r *Reconciler) StartBlocked(serverID string) string {
	if reason := r.heldReason(serverID); reason != "" {
		return Busy(reason).Error()
	}
	sp, err := r.st.GetSpec(serverID)
	if err != nil {
		return err.Error()
	}
	if sp == nil {
		return "unknown server on this node"
	}
	if l, err := r.st.CrashLatch(serverID); err == nil && l != nil && l.Version == sp.Version {
		return CrashLoopMessage(l.Crashes)
	}
	return ""
}
