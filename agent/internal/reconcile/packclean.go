package reconcile

import (
	"context"
	"fmt"

	"mcsm/agent/internal/packclean"
	"mcsm/agent/internal/spec"
)

// plan-11: events of the previous modpack's cleanup (catalog in the comment of message Event, agent.proto).
const (
	// KindPackCleanup: the agent deleted the files of a modpack that was uninstalled or replaced.
	KindPackCleanup = "pack_cleanup"
	// KindPackCleanupSkipped: those files could not be deleted (data folder outside DATA_ROOT).
	KindPackCleanupSkipped = "pack_cleanup_skipped"
)

// SetDataWriteGuard sets what registers a write to a server's data folder (App: fileWrites.enter), so that
// a restore that reserves the server waits for it. nil = nothing. It is called before launching goroutines (App.New).
func (r *Reconciler) SetDataWriteGuard(fn func(serverID string) (leave func())) {
	r.dataWriteGuard = fn
}

func (r *Reconciler) dataWrite(serverID string) (leave func()) {
	if r.dataWriteGuard == nil {
		return func() {}
	}
	return r.dataWriteGuard(serverID)
}

// packCleanupPlatform is the platform whose files storing next requires deleting (stored may be nil).
func packCleanupPlatform(storedJSON, nextJSON []byte) string {
	return spec.PackCleanupPlatform(spec.ModpackOf(storedJSON), spec.ModpackOf(nextJSON))
}

// cleanPack deletes the files of the modpacks pending cleanup (store.PackCleanups) from the server's data
// folder. With the server's lock held, without a container (removed or never created) and before creating
// the next one: an error stops the creation (backoff, Observed.error) and the marker stays for the retry.
// A platform equal to the current pack's is left to itzg, which replaces its files itself (spike F4/F5).
func (r *Reconciler) cleanPack(ctx context.Context, serverID string, parsed spec.Spec, dataDir string) error {
	pending, err := r.st.PackCleanups(serverID)
	if err != nil || len(pending) == 0 {
		return err
	}
	current := ""
	if parsed.Modpack != nil {
		current = parsed.Modpack.Platform
	}
	var platforms []string
	for _, p := range pending {
		if p != current {
			platforms = append(platforms, p)
		}
	}
	if len(platforms) == 0 {
		return r.st.ClearPackCleanup(serverID)
	}
	if parsed.DataPath != "" {
		// The agent only mounts DATA_ROOT: it cannot see (nor delete) a dataPath's files.
		r.event(serverID, KindPackCleanupSkipped, "The previous modpack's files were not removed: the data folder is outside DATA_ROOT. Remove them from the host if the server fails to start")
		return r.st.ClearPackCleanup(serverID)
	}
	leave := r.dataWrite(serverID)
	defer leave()
	opt := packclean.Options{Log: r.log}
	if ln := parsed.Properties["level-name"]; ln != "" {
		opt.LevelNames = []string{ln}
	}
	for _, p := range platforms {
		if err := ctx.Err(); err != nil {
			return err
		}
		res, err := packclean.Clean(dataDir, p, opt)
		if err != nil {
			return fmt.Errorf("remove the previous modpack's files: %w", err)
		}
		r.log.Info("previous modpack's files removed", "server", serverID, "platform", p, "removed", res.Removed, "kept", res.Kept)
		if res.Removed > 0 {
			r.event(serverID, KindPackCleanup, fmt.Sprintf("Removed %d files installed by the previous modpack (%s)", res.Removed, platformLabel(p)))
		}
	}
	return r.st.ClearPackCleanup(serverID)
}

func platformLabel(p string) string {
	if p == spec.PlatformAutoCurseForge {
		return "CurseForge"
	}
	return "Modrinth"
}

// event emits through the sink, if there is one (with the server's lock held: the sink never blocks).
func (r *Reconciler) event(serverID, kind, msg string) {
	if r.events != nil {
		r.events(serverID, kind, msg)
	}
}
