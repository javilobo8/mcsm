package app

import (
	"fmt"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/crashloop"
	"mcsm/agent/internal/docker"
)

// Event types the agent emits (see the comment on `message Event` in agent.proto). Drift is emitted by the
// reconciler (reconcile.KindDrift).
const (
	KindCrash           = "crash"
	KindOOM             = "oom"
	KindCrashLoop       = "crash_loop"
	KindCrashLoopFailed = "crash_loop_failed"
	KindSaveOnPending   = "save_on_pending"
	KindSaveOnResumed   = "save_on_resumed"
)

// emitEvent queues an Event for the panel without ever blocking (its own FIFO queue, like the backup notices). Without a
// connection it is lost: what matters also stays in Observed.error. The time comes from the agent's clock (the
// backups' one, injectable in tests).
func (a *App) emitEvent(serverID string, level mcsmv1.EventLevel, kind, msg string) {
	_ = a.events.post(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_Event{Event: &mcsmv1.Event{
		Level: level, ServerId: serverID, Kind: kind, Message: validUTF8(msg), TsUnixMs: a.bk.clock.Now().UnixMilli(),
	}}})
}

// crashStop is a decided crash loop stop: with how many exits and with which generation of manual
// starts (reconcile.StartGen).
type crashStop struct {
	n   int
	gen uint64
}

// onDie counts the error exits nobody requested (spec §10). These are not crashes: a clean exit (code 0:
// /stop, mc-router's stop for inactivity), the first die after each stop requested by the agent or the router's
// proxy in the last few minutes (Intents), anything while the server is reserved (backup, restore,
// migration) nor the containers of servers this agent does not know. With more than crashloop.MaxCrashes in an
// hour it stops and latches the server in the background, with the life context.
func (a *App) onDie(serverID string, ev docker.Event) {
	// Each requested stop explains a single die, whatever its code: it is spent before looking at it (m6).
	requested := a.intents.Consume(ev.ContainerID)
	code, ok := crashloop.ExitCode(ev)
	if requested || !ok || code == 0 || a.rec.Held(serverID) {
		return
	}
	if sp, err := a.st.GetSpec(serverID); err != nil || sp == nil {
		return // container of another agent on the same Docker (e.g. the tests): not ours
	}
	n, tripped := a.crashes.Record(serverID)
	a.emitEvent(serverID, mcsmv1.EventLevel_EVENT_LEVEL_WARN, KindCrash,
		fmt.Sprintf("The server exited with code %d (%d in the last hour)", code, n))
	if !tripped {
		return
	}
	life := a.life
	// A manual start after this decision voids it (gen). It is stored as the server's last decision:
	// if a stop is already queued, dispatch merges it and the execution uses this one, not the previous one.
	a.stopMu.Lock()
	a.crashStops[serverID] = crashStop{n: n, gen: a.rec.StartGen(serverID)}
	a.stopMu.Unlock()
	a.dispatch(life, "crashloop:"+serverID, func() {
		a.stopMu.Lock()
		d, ok := a.crashStops[serverID]
		delete(a.crashStops, serverID)
		a.stopMu.Unlock()
		if !ok {
			return // already executed by an earlier pass of this same merged task
		}
		n := d.n
		stopped, err := a.rec.CrashLoopStopUnlessStarted(life, serverID, n, d.gen)
		if err == nil && !stopped {
			a.log.Info("crash loop discarded: the server was started by hand afterwards", "server", serverID)
			return
		}
		if err != nil {
			a.log.Warn("stop a server in a crash loop", "server", serverID, "err", err)
			a.emitEvent(serverID, mcsmv1.EventLevel_EVENT_LEVEL_ERROR, KindCrashLoopFailed,
				fmt.Sprintf("Crash loop (%d exits with an error in one hour), but it could not be stopped: %v", n, err))
			return
		}
		a.log.Warn("server stopped by a crash loop", "server", serverID, "crashes", n)
		a.emitEvent(serverID, mcsmv1.EventLevel_EVENT_LEVEL_ERROR, KindCrashLoop,
			fmt.Sprintf("Crash loop: %d exits with an error in less than an hour. The server has been stopped; check the console and press Start to try again", n))
	})
}
