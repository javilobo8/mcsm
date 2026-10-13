package reconcile

import (
	"context"
)

// Tombstones of withdrawn servers.
//
// SyncSpecs.removed_ids arrives with Forget, which deletes the spec immediately (nothing must
// resurrect the server nor announce it in the Hello), and the container is deleted afterwards, in the
// background, with Remove. If that deletion fails, without a tombstone nobody would retry it: the
// next Hello no longer carries the id and the panel does not send it again in removed_ids, so the
// container would be orphaned forever.
//
// That is why Forget deletes the spec and leaves an explicit tombstone in the store in a single
// transaction (store.ForgetWithTombstone). The tick walks the tombstones (RetryRemovals) and
// retries the deletion until it succeeds; then it removes it. Storing a spec for the same
// id (Apply, StoreForce) voids it in the same transaction (store.PutSpec). Tombstones do not
// appear in ListSpecs: neither in the Hello, nor in the ticks, nor in the inventory.

// maxRemovalsPerTick bounds the deletions each RetryRemovals pass attempts: each one
// can take up to StopTimeout, and several stuck containers must not hold the tick
// N×60 s. Those that fail stay in backoff and do not count in later passes.
const maxRemovalsPerTick = 3

// RetryRemovals retries deleting the containers of servers with a tombstone and returns
// the ids whose deletion finished (also those that no longer had a container). It respects each
// tombstone's backoff (spec §6.2: 30 s, 60 s, … max. 5 min) and attempts at most
// maxRemovalsPerTick per pass. Reserved ones (Hold) wait for the reservation to be released,
// which completes the deletion. It only acts on ids with an explicit tombstone: an mcsm.* container
// with neither a spec nor a tombstone is never touched (invariant §6.2).
func (r *Reconciler) RetryRemovals(ctx context.Context) []string {
	list, err := r.st.ListTombstones()
	if err != nil {
		r.log.Warn("list tombstones", "err", err)
		return nil
	}
	var done []string
	attempts := 0
	for _, t := range list {
		if attempts >= maxRemovalsPerTick {
			break
		}
		tried, err := r.retryRemoval(ctx, t.ServerID)
		if !tried {
			continue
		}
		attempts++
		if err != nil {
			r.log.Warn("retry deleting a withdrawn server", "server", t.ServerID, "withdrawn", t.Since, "err", err)
			continue
		}
		r.log.Info("pending deletion of a withdrawn server completed", "server", t.ServerID)
		done = append(done, t.ServerID)
	}
	return done
}

// retryRemoval tries to delete id's container if it still has a tombstone (checked under the
// server's lock: an Apply or StoreForce may have voided it after listing it), it is not
// reserved and its backoff expired. tried says whether there was an attempt; err, whether it failed.
func (r *Reconciler) retryRemoval(ctx context.Context, id string) (tried bool, err error) {
	unlock := r.lock(id)
	defer unlock()
	if r.heldReason(id) != "" {
		return false, nil
	}
	r.mu.Lock()
	until, waiting := r.retryAt[id]
	r.mu.Unlock()
	if waiting && r.now().Before(until) {
		return false, nil
	}
	tomb, err := r.st.HasTombstone(id)
	if err != nil || !tomb {
		return false, err
	}
	sp, err := r.st.GetSpec(id)
	if err != nil {
		return false, err
	}
	if sp != nil {
		// It should not happen (PutSpec deletes the tombstone): the spec rules and the server lives.
		return false, r.st.DeleteTombstone(id)
	}
	return true, r.removeTombstoned(ctx, id)
}

// removeTombstoned deletes the container of a server with a tombstone (without its data) and removes the
// tombstone; if it fails, it schedules the next attempt with backoff. Requires the server's lock.
func (r *Reconciler) removeTombstoned(ctx context.Context, id string) error {
	if err := r.removeLocked(ctx, id, false); err != nil {
		r.markFailure(id, 0, err.Error())
		return err
	}
	return nil
}
