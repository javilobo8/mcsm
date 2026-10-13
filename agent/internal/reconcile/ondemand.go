package reconcile

import (
	"context"
	"errors"
	"fmt"

	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
)

// SetOnDemand sets which servers are "on-demand" (plan-8): those mc-router starts and stops with
// its autoscale. For them the reconciliation creates and recreates the container, but does not stop a running one
// nor start a stopped one: the desired state is only applied with power actions (Power). A
// container that never started is started, because mc-router would not see it (checked with mc-router
// 1.47.1: it only knows those it saw start or found stopped when it started) and puts it to sleep without
// players. It is called before launching goroutines (App.New); afterwards it is read-only. fn is invoked
// with the server's lock held: it cannot call the reconciler.
func (r *Reconciler) SetOnDemand(fn func(spec.Spec) bool) { r.onDemand = fn }

// Park parks an on-demand server while it is reserved (Hold): the reservation only holds back the
// agent, and mc-router, with its autoscale, starts on its own any stopped container with a
// hostname as soon as a player tries to join (e.g. on the old world midway through a
// restore). Park stops it (with its wait) and deletes it: without a container there is nothing to start.
// The data is in the bind; when the reservation is released, reconcileLocked recreates and starts it (see
// SetOnDemand: mc-router puts it back to sleep without players). It returns false without touching anything if the
// server is not on-demand. It requires the reservation to be held: without it, a tick would recreate it.
func (r *Reconciler) Park(ctx context.Context, serverID string) (bool, error) {
	unlock := r.lock(serverID)
	defer unlock()
	if r.heldReason(serverID) == "" {
		return false, errors.New("parking a server requires it to be reserved")
	}
	if r.onDemand == nil {
		return false, nil
	}
	sp, err := r.st.GetSpec(serverID)
	if err != nil || sp == nil {
		return false, err
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return false, err
	}
	if !r.onDemand(parsed) {
		return false, nil
	}
	c, err := r.find(ctx, serverID)
	if err != nil {
		return false, err
	}
	if c == nil {
		return true, nil // already parked (or not created)
	}
	if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return false, fmt.Errorf("stop: %w", err)
	}
	if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return false, fmt.Errorf("remove: %w", err)
	}
	r.log.Info("on-demand server parked while it is reserved", "server", sp.Slug)
	return true, nil
}
