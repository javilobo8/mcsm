// Package reconcile keeps the Docker containers equal to the specs in the store.
//
// Invariant (spec §6.2): the reconciler never deletes mcsm.* containers on its own
// initiative. It only removes them when recreating because of a spec change sent by
// the panel (Reconcile) or when the panel explicitly orders it (Remove, and its retry
// via tombstone after SyncSpecs.removed_ids: RetryRemovals).
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
	onDemand func(spec.Spec) bool // plan-8: servers that mc-router starts and stops (SetOnDemand)
	events   EventSink            // plan-9: events (drift); nil = none (SetEventSink)
	// plan-9: Power accepted a manual start or restart (SetOnManualStart); nil = nothing.
	onManualStart func(serverID string)
	// plan-11: registers the writes to a server's data folder (SetDataWriteGuard); nil = none.
	dataWriteGuard func(serverID string) (leave func())

	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	retryAt map[string]time.Time
	fails   map[string]int
	failVer map[string]uint64
	lastErr map[string]string
	held    map[string]string // plan-4: servers reserved by Hold (backup/restore) and their reason
	heldErr map[string]string // plan-4: error visible in Observed of a reserved server (HoldError)
	// startGen counts, per server, the Power start/restart and the new versions of its spec (plan-9): a
	// CrashLoopStop decided before one of them does not latch the server the user just started nor a new
	// configuration (CrashLoopStopUnlessStarted).
	startGen map[string]uint64
	adoptMu  sync.Mutex // plan-6: check and register adoptions (one container, one server); after the per-server lock
	now      func() time.Time
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

// bumpStartGen increments id's start generation (with the server's lock held).
func (r *Reconciler) bumpStartGen(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.startGen == nil {
		r.startGen = map[string]uint64{}
	}
	r.startGen[id]++
}

// tryLock takes id's lock only if it is free (plan-9: TryHold).
func (r *Reconciler) tryLock(id string) (func(), bool) {
	r.mu.Lock()
	m, ok := r.locks[id]
	if !ok {
		m = &sync.Mutex{}
		r.locks[id] = m
	}
	r.mu.Unlock()
	if !m.TryLock() {
		return nil, false
	}
	return m.Unlock, true
}

func isActive(state string) bool {
	return state == "running" || state == "restarting" || state == "paused"
}

// ReconcileAll retries the pending deletions (tombstones) and walks all the specs,
// skipping those in backoff (unless the spec version changed since the
// last failure). Deletions go first: a withdrawn and recreated slug with another id
// reuses the container name.
func (r *Reconciler) ReconcileAll(ctx context.Context) {
	r.RetryRemovals(ctx)
	specs, err := r.st.ListSpecs()
	if err != nil {
		r.log.Error("list specs", "err", err)
		return
	}
	for _, sp := range specs {
		if err := r.reconcileTick(ctx, sp.ServerId); err != nil {
			r.log.Warn("reconcile", "server", sp.Slug, "err", err)
		}
	}
}

// reconcileTick reconciles a server from the tick: the backoff check is
// done with the per-server lock held so that two concurrent ticks do not retry
// (nor escalate the backoff) twice. It ignores servers without a spec.
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

// ReconcileTick reconciles a single server from a periodic tick, respecting the
// failure backoff. It lets the caller process each server separately.
func (r *Reconciler) ReconcileTick(ctx context.Context, serverID string) error {
	return r.reconcileTick(ctx, serverID)
}

// Reconcile applies a server's spec and always publishes the observed state.
// A failure stays in Observed.Error and schedules a retry with backoff.
func (r *Reconciler) Reconcile(ctx context.Context, serverID string) error {
	unlock := r.lock(serverID)
	defer unlock()
	return r.reconcileLocked(ctx, serverID)
}

// Apply stores the spec and reconciles it, all under the server's lock. A spec with a
// version lower than the stored one (out of order) is ignored and returns nil.
func (r *Reconciler) Apply(ctx context.Context, sp *mcsmv1.ServerSpec) error {
	unlock := r.lock(sp.ServerId)
	defer unlock()
	stored, err := r.st.GetSpec(sp.ServerId)
	if err != nil {
		return err
	}
	if stored != nil && sp.Version < stored.Version {
		r.log.Info("out-of-order spec ignored", "server", sp.Slug, "version", sp.Version, "stored", stored.Version)
		return nil
	}
	// plan-11: an uninstalled or replaced modpack leaves its files; the cleanup is marked with the spec.
	if err := r.st.PutSpecMarkingPackCleanup(sp, packCleanupPlatform(stored.GetSpecJson(), sp.SpecJson)); err != nil { // clears the id's tombstone, if there is one
		return err
	}
	if stored == nil || stored.Version != sp.Version {
		r.bumpStartGen(sp.ServerId) // plan-9: a new version is tried even if a loop stop was queued
	}
	return r.reconcileLocked(ctx, sp.ServerId)
}

// StoreForce stores the spec without a version guard and without touching Docker. It is for
// SyncSpecs, where the panel is the truth on reconnect (e.g. after restoring its database):
// the reconciliation comes afterwards, in the background. It clears the backoff so
// that reconciliation (and the next tick) does not wait because of another spec's failures.
func (r *Reconciler) StoreForce(sp *mcsmv1.ServerSpec) error {
	unlock := r.lock(sp.ServerId)
	defer unlock()
	stored, err := r.st.GetSpec(sp.ServerId)
	if err != nil {
		return err
	}
	// plan-11: as in Apply.
	if err := r.st.PutSpecMarkingPackCleanup(sp, packCleanupPlatform(stored.GetSpecJson(), sp.SpecJson)); err != nil { // clears the id's tombstone, if there is one
		return err
	}
	if stored == nil || stored.Version != sp.Version {
		r.bumpStartGen(sp.ServerId) // plan-9: as in Apply
	}
	r.clearFailure(sp.ServerId)
	return nil
}

// Forget deletes the spec of a server withdrawn by the panel (under its lock, so that
// no tick resurrects it) without touching Docker. The container is stopped and deleted afterwards
// with Remove, which also works without a spec; until that deletion succeeds a
// tombstone remains and the tick retries it (RetryRemovals).
func (r *Reconciler) Forget(serverID string) error {
	unlock := r.lock(serverID)
	defer unlock()
	// Spec out and tombstone in, in a single transaction: after a Forget, the container
	// always has a spec or a tombstone.
	if err := r.st.ForgetWithTombstone(serverID, r.now()); err != nil {
		return err
	}
	r.clearFailure(serverID)
	return nil
}

func (r *Reconciler) reconcileLocked(ctx context.Context, serverID string) (err error) {
	// plan-4: with the server reserved (Hold) Docker is not touched nor anything published.
	if reason := r.heldReason(serverID); reason != "" {
		// The spec is already stored: it will be applied when the reservation (Hold) is released.
		r.log.Info("reconciliation deferred", "server", serverID, "reason", reason)
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
	// plan-9: latched by a crash loop (CrashLoopStop) in this version: it is not started until a Power
	// start/restart or a new spec.
	latch, err := r.crashLatched(serverID, sp.Version)
	if err != nil {
		return err
	}
	if latch != nil {
		wantRunning = false
	}

	existing, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	// plan-6: an imported server without an adoption record (ImportAdopt lost, new store) is
	// adopted again; if its original container no longer exists, the managed one is created.
	if existing == nil && parsed.Adopt != nil {
		if existing, err = r.readopt(ctx, sp, parsed, build.DataDir); err != nil {
			return err
		}
	}
	// plan-6 (H1): a dataPath is only mounted if the agent verified it for this server. Before touching
	// Docker: a spec change must not stop the original and then be unable to create.
	if err := r.checkDataPath(ctx, serverID, parsed, existing); err != nil {
		return err
	}
	recreate := false
	switch {
	case existing != nil && existing.Adopted:
		// plan-6: the original stays while the spec does not exceed the adoption's version.
		ad, aerr := r.st.Adoption(serverID)
		if aerr != nil {
			return aerr
		}
		if ad != nil && sp.Version > ad.Version {
			r.log.Info("first spec change of an imported server: it is recreated with mcsm labels", "server", sp.Slug, "original", existing.Name)
			recreate = true
		}
	case existing != nil && existing.Labels[spec.LabelHash] != build.Hash:
		r.log.Info("spec changed, recreating container", "server", sp.Slug)
		recreate = true
		// plan-9: with the version already applied, the container changed outside the agent (or the agent was updated).
		if applied, aerr := r.st.Applied(serverID); aerr == nil && applied == sp.Version && r.events != nil {
			r.events(serverID, KindDrift, "The container did not match its configuration (changed outside the panel or agent updated): it has been recreated")
		}
	}
	// plan-6 (M2): before creating an imported server's managed one (and before stopping the one being replaced),
	// no other itzg container may already mount its data folder.
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
		// plan-6: an adoption whose container is gone (or has just been replaced) is left over.
		if err := r.st.DeleteAdoption(serverID); err != nil {
			return err
		}
		// plan-11: without a container (the old one, if any, is already removed), the files of an uninstalled
		// or replaced modpack are deleted before creating the new one.
		if err := r.cleanPack(ctx, serverID, parsed, build.DataDir); err != nil {
			return err
		}
		// plan-6: with dataPath the folder is the host's and the agent does not see it (it only mounts DATA_ROOT). It goes
		// in Mounts (M3): if it does not exist, Docker fails on create instead of creating it empty.
		if parsed.DataPath == "" {
			if err := os.MkdirAll(build.DataDir, 0o755); err != nil {
				return fmt.Errorf("create data directory: %w", err)
			}
		}
		if err := r.eng.EnsureImage(ctx, build.Config.Image); err != nil {
			return fmt.Errorf("pull image: %w", err)
		}
		id, err := r.eng.Create(ctx, build.Name, build.Config, build.HostConfig, build.Networking)
		if err != nil {
			return fmt.Errorf("create container: %w", err)
		}
		existing = &docker.Container{ID: id, Name: build.Name, State: "created", Labels: build.Config.Labels}
	}
	// plan-8: with the router's autoscale, mc-router starts and stops the servers with a hostname: the
	// desired state is not imposed. A container that never started (freshly created or recreated, also
	// when releasing a reservation after Park) is started: mc-router does not see containers that never
	// started, so it could not wake it; it puts it to sleep after the minutes without players.
	if r.onDemand != nil && r.onDemand(parsed) {
		if existing.State == "created" && latch == nil {
			if err := r.startOrDiscard(ctx, existing); err != nil {
				return fmt.Errorf("start: %w", err)
			}
		}
		// plan-9: latched by a crash loop and running (restarted by Docker's restart policy, also
		// always after the daemon restarts): it is stopped, like any latched server.
		if latch != nil && isActive(existing.State) {
			if err := r.eng.Stop(ctx, existing.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
				return fmt.Errorf("stop: %w", err)
			}
		}
		return r.st.SetApplied(serverID, sp.Version)
	}
	switch {
	// Paused counts as active: Docker does not start a paused container (it has to be resumed) and the
	// panel never pauses; it is left as it is (plan-6, m6: a paused imported server).
	case wantRunning && !isActive(existing.State):
		if err := r.startOrDiscard(ctx, existing); err != nil {
			return fmt.Errorf("start: %w", err)
		}
	case !wantRunning && isActive(existing.State):
		if err := r.eng.Stop(ctx, existing.ID, StopTimeout); err != nil {
			return fmt.Errorf("stop: %w", err)
		}
	}
	return r.st.SetApplied(serverID, sp.Version)
}

// Remove deletes the spec (under the lock, before stopping, so that no tick
// resurrects it), stops and deletes the container; with deleteData it also deletes <dataRoot>/<slug>.
// It is only invoked when the panel says so. If the server had a tombstone (Forget), it removes it
// when the deletion succeeds; if it fails, the tombstone stays and the tick retries it.
func (r *Reconciler) Remove(ctx context.Context, serverID string, deleteData bool) error {
	unlock := r.lock(serverID)
	defer unlock()
	// plan-4: a reserved server (Hold) is not deleted in the middle of a backup or restore.
	if reason := r.heldReason(serverID); reason != "" {
		return Busy(reason)
	}
	return r.removeLocked(ctx, serverID, deleteData)
}

// removeLocked is Remove with the server's lock held.
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
		if err := r.st.DeleteTombstone(serverID); err != nil { // nothing to delete
			return err
		}
		if err := r.st.DeleteAdoption(serverID); err != nil { // plan-6: its container no longer exists
			return err
		}
		r.clearFailure(serverID)
		if deleteData {
			return fmt.Errorf("unknown server %s: its data cannot be deleted", serverID)
		}
		return nil // already deleted: idempotent (the panel resends removed_ids on reconnect)
	}
	// Validate before touching anything: an invalid slug must not leave the deletion half done.
	var target string
	if deleteData {
		// plan-6: the data of an imported server with dataPath is outside DATA_ROOT: it is not deleted.
		if sp != nil {
			if p, perr := spec.Parse(sp.SpecJson); perr == nil && p.DataPath != "" {
				return fmt.Errorf("the data of %s is at %s, outside DATA_ROOT: the agent does not delete it", slug, p.DataPath)
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
		// Without a spec (tombstone) the retry's backoff is kept until the deletion finishes.
		r.clearFailure(serverID)
	}
	if c != nil {
		if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			r.log.Warn("clean stop failed before deleting", "server", slug, "err", err)
		}
		if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return err
		}
	}
	// plan-6: the server's container (adopted or not) no longer exists.
	if err := r.st.DeleteAdoption(serverID); err != nil {
		return err
	}
	if deleteData {
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("delete data: %w", err)
		}
	}
	if sp == nil {
		if err := r.st.DeleteTombstone(serverID); err != nil { // the pending deletion finished
			return err
		}
		r.clearFailure(serverID)
	}
	return nil
}

// dataPath returns <dataRoot>/<slug> only if the slug is valid and the path stays
// strictly inside dataRoot.
func (r *Reconciler) dataPath(slug string) (string, error) {
	if !spec.ValidSlug(slug) {
		return "", fmt.Errorf("invalid slug %q: data is not deleted", slug)
	}
	root := filepath.Clean(r.dataRoot)
	target := filepath.Clean(filepath.Join(root, slug))
	if !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", fmt.Errorf("data path outside DATA_ROOT: %q", target)
	}
	return target, nil
}

// Power runs a power action. The desired state is only persisted if the
// Docker action succeeds (the panel does not change it without an Ack either): a failure leaves it as
// it was and the error stays in Observed until the next successful reconciliation.
// Without a container, it sets the desired state and reconciles (creates and starts, or leaves it stopped); if
// that fails, it restores the previous desired state. plan-8: the same if on starting the
// container was discarded (startOrDiscard): it is recreated immediately.
func (r *Reconciler) Power(ctx context.Context, serverID string, action mcsmv1.PowerActionType) (err error) {
	unlock := r.lock(serverID)
	defer unlock()
	// plan-4: before the defer that publishes: "busy" is not a server error.
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
		return fmt.Errorf("unknown server %s", serverID)
	}
	// plan-9: starting or restarting by hand lifts the crash loop latch and voids the loop stops
	// decided earlier.
	if action == mcsmv1.PowerActionType_POWER_ACTION_TYPE_START || action == mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART {
		r.bumpStartGen(serverID)
		if r.onManualStart != nil {
			r.onManualStart(serverID)
		}
		if err := r.st.DeleteCrashLatch(serverID); err != nil {
			return err
		}
	}
	var desired mcsmv1.DesiredState
	switch action {
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_START, mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART:
		desired = mcsmv1.DesiredState_DESIRED_STATE_RUNNING
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP, mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL:
		desired = mcsmv1.DesiredState_DESIRED_STATE_STOPPED
	default:
		return fmt.Errorf("unknown action %v", action)
	}
	c, err := r.find(ctx, serverID)
	if err != nil {
		return err
	}
	if c != nil {
		err := r.powerContainer(ctx, c, action)
		if err == nil {
			return r.putDesired(sp, desired)
		}
		if !errors.Is(err, errDiscarded) {
			r.setLastErr(serverID, err.Error())
			return err
		}
		// plan-8: the container started without ports or could not start and was discarded (Docker
		// 29.7.2 failure): it is recreated now, as if it did not exist, with the requested state.
		r.log.Warn("container discarded on start; recreating", "server", sp.Slug, "err", err)
	}
	prev := sp.DesiredState
	if err := r.putDesired(sp, desired); err != nil {
		return err
	}
	published = true // reconcileLocked publishes the observed state
	if err := r.reconcileLocked(ctx, serverID); err != nil {
		if rerr := r.putDesired(sp, prev); rerr != nil {
			r.log.Error("restore the desired state", "server", sp.Slug, "err", rerr)
		}
		return err
	}
	return nil
}

// powerContainer runs the action on an existing container.
func (r *Reconciler) powerContainer(ctx context.Context, c *docker.Container, action mcsmv1.PowerActionType) error {
	switch action {
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_START:
		if c.State != "running" {
			return r.startOrDiscard(ctx, c)
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
		return r.startOrDiscard(ctx, c)
	case mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL:
		// Docker returns a conflict when killing something that is not running: we only kill if it is active.
		if isActive(c.State) {
			return r.eng.Kill(ctx, c.ID)
		}
	}
	return nil
}

// putDesired persists the desired state if it changes.
func (r *Reconciler) putDesired(sp *mcsmv1.ServerSpec, d mcsmv1.DesiredState) error {
	if sp.DesiredState == d {
		return nil
	}
	sp.DesiredState = d
	return r.st.PutSpec(sp)
}

// Observe computes the real state and publishes it.
func (r *Reconciler) Observe(ctx context.Context, serverID string) *mcsmv1.Observed {
	unlock := r.lock(serverID)
	obs := r.observeLocked(ctx, serverID)
	unlock()
	r.observer(serverID, obs)
	return obs
}

// Container returns the server's container: nil without error if it does not exist, and Docker's
// error if it could not be checked. plan-4: backups and restores need it so as not to
// mistake a Docker failure for "there is no container" (hot backup without save-off,
// restore with the server running).
func (r *Reconciler) Container(ctx context.Context, serverID string) (*docker.Container, error) {
	return r.find(ctx, serverID)
}

// ContainerID returns the server's container id, or "" if it does not exist.
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
		obs.Error = msg // plan-4: reserved and unable to start (HoldError)
	}
	r.mu.Unlock()
	if obs.Error == "" { // plan-9: latched by a crash loop
		if sp, err := r.st.GetSpec(serverID); err == nil && sp != nil {
			if l, err := r.st.CrashLatch(serverID); err == nil && l != nil && l.Version == sp.Version {
				obs.Error = CrashLoopMessage(l.Crashes)
			}
		}
	}
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
		// plan-6: the slug of the container found (the adopted one has no labels in Docker).
		obs.Mc = r.status(ctx, spec.ContainerName(c.Labels[spec.LabelSlug]), uint16(spec.GamePort))
	}
	if ins.PortsMissing && obs.Error == "" { // plan-8: started by someone else (restart policy, mc-router)
		hint := "press Restart to recreate the container"
		if c.Adopted { // plan-6: Restart does not delete the user's original
			hint = adoptedPortsHint
		}
		obs.Error = errPortsMissing.Error() + ": " + hint
	}
	return obs
}

// plan-8: Docker 29.7.2 failure. A container whose start failed on the host port later starts
// WITHOUT publishing its ports, and stays that way even if stopped and started again.
var (
	errPortsMissing = errors.New("running without publishing its ports (Docker failure after a failed start)")
	errDiscarded    = errors.New("container discarded: it will be recreated")
)

// adoptedPortsHint: what to do with an adopted one (plan-6) that is running without its ports, which is not discarded.
const adoptedPortsHint = "it is the imported server's original container and the agent does not delete it; save a change to the server's configuration so that it is recreated with its ports"

// startOrDiscard starts the container and checks that it publishes its ports. If the start fails, or
// it starts without ports (tainted by another party's failed start: the restart policy, mc-router),
// it deletes it (force) and returns the error wrapped in errDiscarded: the data is in the bind and the
// next pass recreates it with the §6.2 backoff (Power recreates it immediately). With ctx cancelled
// nothing is discarded: the Start may have reached Docker. An adopted one (plan-6) is never discarded.
func (r *Reconciler) startOrDiscard(ctx context.Context, c *docker.Container) error {
	err := r.eng.Start(ctx, c.ID)
	if err == nil {
		ins, ierr := r.eng.Inspect(ctx, c.ID)
		if ierr != nil || !ins.PortsMissing {
			return nil
		}
		err = errPortsMissing
	}
	if ctx.Err() != nil {
		return err
	}
	// plan-6: the adopted container is the user's original and is never deleted: it is only reported.
	// The first spec change replaces it with a managed one (reconcileLocked), with its ports.
	if c.Adopted {
		if errors.Is(err, errPortsMissing) {
			return fmt.Errorf("%w: %s", err, adoptedPortsHint)
		}
		return err
	}
	if rerr := r.eng.Remove(ctx, c.ID); rerr != nil && !errors.Is(rerr, docker.ErrNotFound) {
		return fmt.Errorf("%w (and the container could not be discarded: %v)", err, rerr)
	}
	return fmt.Errorf("%w (%w)", err, errDiscarded)
}

// find returns the server's container: the managed one (mcsm.server_id label) or, if there is none,
// the adopted one (plan-6). nil without error if it does not exist.
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
		return nil, fmt.Errorf("list containers: %w", err)
	}
	for i := range list {
		if list[i].Labels[spec.LabelServerID] == serverID {
			return &list[i], nil
		}
	}
	return nil, nil
}

// replace stops and deletes a container to recreate it. Always Stop (Docker does nothing on a stopped
// one): it avoids deciding from a snapshot of the state. The data is in the bind.
func (r *Reconciler) replace(ctx context.Context, c *docker.Container) error {
	if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("stop: %w", err)
	}
	if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return fmt.Errorf("remove: %w", err)
	}
	return nil
}

// markFailure records a failure of version ver. If the version changed since the
// last failure, the backoff starts over.
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

// setLastErr leaves a visible error in Observed without scheduling a backoff (failure of a
// manual action): the next successful reconciliation clears it.
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
