package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/dockerproxy"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/router"
	"mcsm/agent/internal/spec"
)

// plan-8: the node's mc-router. The spec lives in the store (survives restarts) and the container is
// reconciled in the background, with the life context: on receiving RouterApply/RouterRemove, when
// the agent starts, every reconcileEvery and with the Docker events of its container. Each pass
// sends RouterObserved (id = 0) over the current session; without a session it is lost and the next one restores it.

// routerFilesDir is the host directory with the router's files (the autoscale player
// list). It lives inside DATA_ROOT because that is the only thing on the host the agent sees at the same path
// (mirror mount, §6.1); it starts with a dot, so it never matches a server's slug.
func routerFilesDir(dataRoot string) string { return filepath.Join(dataRoot, ".mcsm-router") }

// proxySocketPath is the Docker proxy's socket for the router: in the router's directory, inside
// DATA_ROOT (a host path thanks to the mirror mount).
func proxySocketPath(dataRoot string) string {
	return filepath.Join(routerFilesDir(dataRoot), "docker.sock")
}

// routerPolicy decides which mc-router starts and stops (autoscale) the proxy lets through: only servers of this
// agent with a router hostname; never a reserved one (backup, restore, migration) and, to start, not one
// latched by a crash loop either. An allowed stop is recorded: its die does not count as a crash.
func (a *App) routerPolicy(ctx context.Context, op dockerproxy.Op, container string) error {
	ins, err := a.eng.Inspect(ctx, container)
	if err != nil {
		return fmt.Errorf("container %s: %w", container, err)
	}
	id := ins.Labels[spec.LabelServerID]
	if ins.Labels[spec.LabelManaged] != "true" || id == "" || ins.Labels[spec.LabelRouterHost] == "" {
		return errors.New("not a server with a router hostname on this node")
	}
	switch op {
	case dockerproxy.OpStart:
		if msg := a.rec.StartBlocked(id); msg != "" {
			return errors.New(msg)
		}
	case dockerproxy.OpStop:
		if reason := a.rec.HeldReason(id); reason != "" {
			return reconcile.Busy(reason)
		}
		// plan-9 (beyond the brief): as when starting, only servers this agent knows; the mcsm
		// labels can be set by anyone who creates containers on the same Docker.
		if sp, err := a.st.GetSpec(id); err != nil || sp == nil {
			return errors.New("unknown server on this node")
		}
		a.intents.Note(ins.ID)
	}
	return nil
}

// onDemand reports whether a server is started and stopped by mc-router (router autoscale and hostname).
// It is invoked by the reconciler with the server's lock held: it only reads one of the router's atomics.
func (a *App) onDemand(s spec.Spec) bool { return s.Router.Active() && a.router.Autoscale() }

// handleRouterApply stores the router's spec and answers; the container is adjusted in the background.
func (a *App) handleRouterApply(id uint64, req *mcsmv1.RouterApply, send func(*mcsmv1.Envelope) error) {
	before := a.router.Autoscale()
	if err := router.Validate(req.GetSpec()); err != nil {
		_ = send(errMsg(id, errcode.InvalidRequest, err))
		return
	}
	if err := a.router.Apply(req.GetSpec()); err != nil {
		_ = send(errMsg(id, errcode.IOError, err)) // the agent's store (bbolt)
		return
	}
	_ = send(ack(id))
	a.routerAsync(a.life)
	if a.router.Autoscale() != before {
		a.reconcileAll(a.life) // changes which servers are on-demand
	}
}

// handleRouterRemove deletes the router's spec and answers; the container is deleted in the background.
func (a *App) handleRouterRemove(id uint64, send func(*mcsmv1.Envelope) error) {
	before := a.router.Autoscale()
	if err := a.router.Clear(); err != nil {
		_ = send(errMsg(id, errcode.IOError, err))
		return
	}
	_ = send(ack(id))
	a.routerAsync(a.life)
	if before {
		a.reconcileAll(a.life) // on-demand servers return to their desired state
	}
}

// routerAsync reconciles the router without blocking (coalesced with the dispatcher) and publishes its state.
func (a *App) routerAsync(ctx context.Context) {
	a.dispatch(ctx, "router", func() {
		obs := a.router.Reconcile(ctx)
		_ = a.send(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_RouterObserved{RouterObserved: obs}})
	})
}

// routerLoop reconciles the router at startup (agent restart: it recreates it if missing) and every
// reconcileEvery (deleted by hand, port freed).
func (a *App) routerLoop(ctx context.Context) {
	a.routerAsync(ctx)
	t := time.NewTicker(reconcileEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.routerAsync(ctx)
		}
	}
}

// routerEvent reacts to a Docker event of the router's container.
func (a *App) routerEvent(ctx context.Context, action string) {
	switch action {
	case "start", "die", "stop", "kill", "destroy", "oom", "restart":
		a.routerAsync(ctx)
	}
}

// isRouterEvent reports whether the event is from the router's container.
func isRouterEvent(labels map[string]string) bool { return labels[router.LabelRouter] == "true" }
