package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"mcsm/agent/internal/spec"
)

const (
	// FlushWait is the wait after save-all flush (spec §6.5).
	FlushWait = 3 * time.Second
	// resumeTimeout bounds save-on, which is sent even if the job is cancelled.
	resumeTimeout = 15 * time.Second
	// maxReply bounds the RCON reply that is copied to the job log.
	maxReply = 200
	// spaceCheckEvery: how many bytes written between free space checks.
	spaceCheckEvery = 64 << 20
)

// ErrResume indicates that autosave could not be re-enabled after a hot
// backup: the world may stay with save-off until someone runs save-on.
var ErrResume = errors.New("could not re-enable autosave (save-on); run save-on in the console")

// ErrServerStopped: the container of a hot backup stopped, restarted or changed
// during the backup. Minecraft saves the world when stopping even with save-off, so what was
// read may mix two states: the backup is not valid.
var ErrServerStopped = errors.New("the server stopped or restarted during the backup")

// ErrNoSpace: there is not (or is no longer) free space for the backup or restore without
// leaving the node's disk below the margin the servers need to keep saving.
var ErrNoSpace = errors.New("not enough free space")

// RconFunc runs a console command on the server. The deadline of each command is that
// of the context it receives (save-all flush on a large world takes more than 5 s).
type RconFunc func(ctx context.Context, command string) (string, error)

// CreateRequest describes a backup.
type CreateRequest struct {
	ServerID    string
	Slug        string
	SpecVersion uint64
	Trigger     string
	DataDir     string // <DATA_ROOT>/<slug>/data
	BackupsDir  string // <DATA_ROOT>/<slug>/backups
	Excludes    []string
	// Rcon is nil if the server is stopped: then it is copied without save-off.
	Rcon RconFunc
	// Running (required with Rcon) checks that the container is still the same as when it
	// started and that it has not stopped or restarted; otherwise it returns an error that wraps
	// ErrServerStopped. Any other error: it could not be checked.
	Running  func(ctx context.Context) error
	Now      func() time.Time
	Sleep    func(ctx context.Context, d time.Duration) error
	Progress func(pct uint32, msg string)
	Log      func(line string)
	// FreeSpace returns the free space of dir's filesystem (nil: statfs).
	FreeSpace func(dir string) (uint64, error)
}

func (r *CreateRequest) defaults() {
	if r.FreeSpace == nil {
		r.FreeSpace = freeSpace
	}
	if r.Now == nil {
		r.Now = time.Now
	}
	if r.Sleep == nil {
		r.Sleep = Sleep
	}
	if r.Progress == nil {
		r.Progress = func(uint32, string) {}
	}
	if r.Log == nil {
		r.Log = func(string) {}
	}
}

// Sleep waits d or until ctx ends.
func Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Create makes a consistent backup (spec §6.5). With the server running: save-off,
// save-all flush, a 3 s wait, tar and save-on as soon as the tar is closed (before the
// fsync, the metadata and the rename). save-on is also in a defer registered before
// save-off and with a context of its own: neither a failure nor a cancellation leaves the world without
// autosave, and it is sent only once. The file is written as .partial; its .json is
// written before giving it the final name (the inventory never sees a backup without
// metadata); if anything fails, the partial (and its .json) are deleted (spec §10) and no
// metadata is returned: a failed backup is never confirmed.
//
// Hot, req.Running checks when the tar is closed and again before the .json that the
// container is the same and did not stop or restart: Minecraft saves the world when stopping
// even with save-off, so a stop during the backup invalidates it (ErrServerStopped).
// Then save-on is unnecessary (save-off does not survive the restart) and is not sent. If save-on fails
// with the server running, the backup is also discarded and the error wraps ErrResume; if
// the backup also failed, the error wraps both.
func Create(ctx context.Context, req CreateRequest) (meta Meta, err error) {
	req.defaults()
	if !spec.ValidSlug(req.Slug) {
		return Meta{}, fmt.Errorf("invalid slug %q", req.Slug)
	}
	if req.Rcon != nil && req.Running == nil {
		return Meta{}, errors.New("hot backup without container check")
	}
	excl, err := NewExcluder(req.Excludes)
	if err != nil {
		return Meta{}, err
	}
	fi, serr := os.Lstat(req.DataDir)
	switch {
	case errors.Is(serr, fs.ErrNotExist):
		return Meta{}, fmt.Errorf("the server has no data to back up yet (%s)", req.DataDir)
	case serr != nil:
		return Meta{}, fmt.Errorf("read the data directory: %w", serr)
	case !fi.IsDir():
		return Meta{}, fmt.Errorf("%s is not a directory (symbolic links are not followed): it is not backed up", req.DataDir)
	}
	if err := os.MkdirAll(req.BackupsDir, 0o750); err != nil {
		return Meta{}, fmt.Errorf("create the backups directory: %w", err)
	}
	started := req.Now()
	name := Filename(req.Slug, started, req.SpecVersion)
	final := filepath.Join(req.BackupsDir, name)
	if _, serr := os.Lstat(final); serr == nil {
		return Meta{}, fmt.Errorf("the backup %s already exists", name)
	}
	// Before save-off: without space, the server does not even notice.
	margin, err := backupSpace(ctx, req, excl)
	if err != nil {
		return Meta{}, err
	}

	var hot *hotCopy // nil when cold
	if req.Rcon != nil {
		hot = &hotCopy{ctx: ctx, req: &req}
		// Registered BEFORE save-off: even if save-off fails (it may have reached the server),
		// the backup fails or the job is cancelled, save-on is sent with its own context.
		defer func() {
			if err = hot.finish(err); err != nil {
				meta = Meta{}
			}
		}()
		req.Progress(1, "Disabling autosave")
		out, rerr := req.Rcon(ctx, "save-off")
		if rerr != nil {
			return Meta{}, fmt.Errorf("RCON save-off: %w", rerr)
		}
		logRcon(req.Log, "save-off", "autosave disabled", out)
		if out, rerr = req.Rcon(ctx, "save-all flush"); rerr != nil {
			return Meta{}, fmt.Errorf("RCON save-all flush: %w", rerr)
		}
		logRcon(req.Log, "save-all flush", "world written to disk", out)
		if err := req.Sleep(ctx, FlushWait); err != nil {
			return Meta{}, err
		}
	}

	partial := final + partialExt
	size, sum, stats, err := writeArchive(ctx, req, excl, partial, margin, hot)
	if err != nil {
		return Meta{}, err
	}
	for _, w := range stats.Warnings {
		req.Log(w)
	}
	meta = Meta{
		Filename: name, ServerID: req.ServerID, Slug: req.Slug, SpecVersion: req.SpecVersion, Trigger: req.Trigger,
		SizeBytes: size, DataBytes: stats.Bytes, SHA256: sum, StartedAt: started.UTC(), FinishedAt: req.Now().UTC(),
		Excludes: req.Excludes, Files: stats.Files,
	}
	metaErr := WriteMeta(req.BackupsDir, meta)
	if metaErr != nil {
		req.Log("warning: could not write the .json metadata file (the backup is valid): " + metaErr.Error())
	}
	if err := rename(partial, final); err != nil {
		_ = os.Remove(partial)
		if metaErr == nil {
			_ = os.Remove(final + MetaExt)
		}
		return Meta{}, fmt.Errorf("save the backup: %w", err)
	}
	_ = syncDir(req.BackupsDir)
	req.Progress(99, "Backup written")
	req.Log(fmt.Sprintf("backup written: %s (%d files, %d compressed bytes)", name, stats.Files, size))
	return meta, nil
}

// writeArchive writes the backup to partial computing its sha256 and syncs it. When
// hot, as soon as the tar is closed (the world data is no longer read) it checks the
// container and sends save-on, and before returning it checks again. If anything fails, it deletes
// the partial.
func writeArchive(ctx context.Context, req CreateRequest, excl *Excluder, partial string, margin uint64, hot *hotCopy) (size int64, sum string, st ArchiveStats, err error) {
	f, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return 0, "", st, fmt.Errorf("create the backup: %w", err)
	}
	closed := false
	defer func() {
		if err != nil {
			if !closed {
				_ = f.Close()
			}
			_ = os.Remove(partial)
		}
	}()
	h := sha256.New()
	out := io.Writer(f)
	if margin > 0 {
		out = &spaceGuard{w: f, free: req.FreeSpace, dir: req.BackupsDir, margin: margin, since: -1}
	}
	req.Progress(2, "Copying data")
	st, err = WriteArchive(ctx, req.DataDir, io.MultiWriter(out, h), excl, func(done, total int64) {
		pct := uint32(97) // done exceeds total if a file grew after the scan
		if total > 0 && done < total {
			pct = 2 + uint32(done*95/total)
		}
		req.Progress(pct, "Copying data")
	})
	if err != nil {
		return 0, "", st, hot.explain(fmt.Errorf("copy the data: %w", err))
	}
	if err = hot.archived(); err != nil {
		return 0, "", st, err
	}
	if err = f.Sync(); err != nil {
		return 0, "", st, fmt.Errorf("save the backup to disk: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		return 0, "", st, err
	}
	closed = true
	if err = f.Close(); err != nil {
		return 0, "", st, fmt.Errorf("save the backup to disk: %w", err)
	}
	if err = hot.verify(); err != nil {
		return 0, "", st, err
	}
	return info.Size(), hex.EncodeToString(h.Sum(nil)), st, nil
}

// hotCopy carries the save-on and the container checks of a hot backup. Its
// methods accept nil (cold backup) except resume and finish.
type hotCopy struct {
	ctx       context.Context
	req       *CreateRequest
	resumed   bool  // save-on already sent (or dropped because of the stop): only once
	resumeErr error // save-on failed with the server running
	stopErr   error // the server stopped or restarted during the backup
}

// discarded adds to err that the backup was not saved.
func discarded(err error) error {
	return fmt.Errorf("%w; the backup was discarded: try again", err)
}

// check asks whether the container is still the same and running. A stop or a restart
// stay in stopErr (and save-on is unnecessary); if Docker does not allow checking it, the backup is not valid either.
func (h *hotCopy) check() error {
	cctx, cancel := context.WithTimeout(h.ctx, resumeTimeout)
	defer cancel()
	err := h.req.Running(cctx)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrServerStopped):
		if h.stopErr == nil {
			h.stopErr = discarded(err)
		}
		return h.stopErr
	default:
		return discarded(fmt.Errorf("could not check that the server stayed running during the backup (%w)", err))
	}
}

// explain: the tar failed. A file that changed while being read discards the backup; when
// hot, if it is because the server stopped, the reason is the stop (the file goes to the log).
func (h *hotCopy) explain(err error) error {
	if h != nil && h.ctx.Err() == nil {
		if serr := h.check(); errors.Is(serr, ErrServerStopped) {
			h.req.Log("warning: " + err.Error())
			if errors.Is(err, ErrSourceChanged) {
				return serr
			}
			return err
		}
	}
	if errors.Is(err, ErrSourceChanged) {
		return discarded(err)
	}
	return err
}

// archived: the tar is closed. It checks that the server stayed running and re-enables
// autosave; if save-on does not arrive because it just stopped, the reason is the stop.
func (h *hotCopy) archived() error {
	if h == nil {
		return nil
	}
	if err := h.check(); err != nil {
		return err
	}
	if err := h.resume(); err != nil {
		return discarded(err)
	}
	return h.stopErr
}

// verify: right before confirming (.json and final name), again: a stop that started
// during the tar may not have finished when it was closed (Minecraft is still saving).
func (h *hotCopy) verify() error {
	if h == nil {
		return nil
	}
	return h.check()
}

// resume sends save-on only once, with its own context (also with the job cancelled).
// If the server stopped or restarted, it is unnecessary: it starts again with autosave enabled. If it
// fails with the server running, it warns and returns an error that wraps ErrResume.
func (h *hotCopy) resume() error {
	if h.resumed {
		return h.resumeErr
	}
	h.resumed = true
	if h.stopErr != nil {
		h.req.Log("save-on is not needed: the server stopped or restarted and starts again with autosave enabled")
		return nil
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(h.ctx), resumeTimeout)
	defer cancel()
	out, err := h.req.Rcon(rctx, "save-on")
	if err == nil {
		logRcon(h.req.Log, "save-on", "autosave re-enabled", out)
		return nil
	}
	if errors.Is(h.check(), ErrServerStopped) {
		h.req.Log("save-on did not arrive: the server stopped or restarted and starts again with autosave enabled")
		return nil
	}
	h.req.Log("WARNING: save-on failed; autosave may still be disabled: " + err.Error())
	h.resumeErr = fmt.Errorf("%w: %v", ErrResume, err)
	return h.resumeErr
}

// finish goes in Create's defer: save-on goes out even if save-off, the backup or the job fail, and
// its failure is counted only once in the error.
func (h *hotCopy) finish(err error) error {
	rerr := h.resume()
	switch {
	case rerr == nil || errors.Is(err, ErrResume):
		return err
	case err == nil:
		return rerr
	default:
		return fmt.Errorf("%w; additionally, %w", err, rerr)
	}
}

// backupSpace checks, before touching the server, that the backup fits: the estimate (the
// server's last backup ×1.2 or, if it is the first, what the uncompressed data takes)
// plus the restore margin, max(5 %, 256 MiB), so that the node's servers
// can keep saving. It returns that margin, which spaceGuard watches during the tar, or 0 if
// the space could not be queried (a warning is logged and it is copied without watching).
func backupSpace(ctx context.Context, req CreateRequest, excl *Excluder) (uint64, error) {
	est, basis, err := estimateBackup(ctx, req, excl)
	if err != nil {
		return 0, err
	}
	free, err := req.FreeSpace(req.BackupsDir)
	if err != nil {
		req.Log("warning: could not check the free space on " + req.BackupsDir + ": " + err.Error())
		return 0, nil
	}
	need := requiredSpace(est)
	margin := need - uint64(max(est, 0))
	if free < need {
		return 0, fmt.Errorf("%w for the backup: %s needed (%s of backup according to %s, plus a margin of %s so the node's servers can keep saving) and %s free on %s; %s short",
			ErrNoSpace, humanBytes(need), humanBytes(uint64(max(est, 0))), basis, humanBytes(margin), humanBytes(free), req.BackupsDir, humanBytes(need-free))
	}
	return margin, nil
}

// estimateBackup estimates what the backup will take and explains where the figure comes from.
func estimateBackup(ctx context.Context, req CreateRequest, excl *Excluder) (int64, string, error) {
	if metas, err := List(req.BackupsDir, req.Slug); err == nil && len(metas) > 0 && metas[0].SizeBytes > 0 {
		last := metas[0].SizeBytes
		return last + last/5, "the last backup (" + humanBytes(uint64(last)) + ") plus 20 %", nil
	}
	root, err := os.OpenRoot(req.DataDir)
	if err != nil {
		return 0, "", fmt.Errorf("measure the data: %w", err)
	}
	defer root.Close()
	var st ArchiveStats
	_, total, err := scan(ctx, root, excl, &st)
	if err != nil {
		return 0, "", fmt.Errorf("measure the data: %w", err)
	}
	return total, "the uncompressed size of the data (it is the first backup)", nil
}

// spaceGuard stops writing the backup if the free space drops below the margin: another backup or another
// server may be filling the disk. It checks at the start and every spaceCheckEvery bytes; if
// it cannot query it, it continues.
type spaceGuard struct {
	w      io.Writer
	free   func(dir string) (uint64, error)
	dir    string
	margin uint64
	since  int64 // bytes since the last check; -1 = none yet
}

func (g *spaceGuard) Write(p []byte) (int, error) {
	if g.since < 0 || g.since >= spaceCheckEvery {
		g.since = 0
		if free, err := g.free(g.dir); err == nil && free < g.margin {
			return 0, fmt.Errorf("%w: free space dropped to %s during the backup, below the margin of %s on %s; backup cancelled to avoid filling the disk",
				ErrNoSpace, humanBytes(free), humanBytes(g.margin), g.dir)
		}
	}
	n, err := g.w.Write(p)
	g.since += int64(n)
	return n, err
}

// logRcon records in the job log the reply to a backup command. Minecraft
// answers with text even if the command fails ("Unable to save the game", "Unknown or
// incomplete command"): those replies are marked WARNING (the backup continues: the disk
// keeps the last complete save).
func logRcon(log func(string), cmd, done, reply string) {
	reply = oneLine(reply)
	switch {
	case reply == "":
		log(cmd + ": " + done)
	case looksLikeFailure(reply):
		log("WARNING: unexpected reply to " + cmd + ": " + reply)
	default:
		log(cmd + ": " + done + " (" + reply + ")")
	}
}

func looksLikeFailure(reply string) bool {
	r := strings.ToLower(reply)
	for _, w := range []string{"unable", "unknown", "incorrect", "error", "fail", "cannot", "can't"} {
		if strings.Contains(r, w) {
			return true
		}
	}
	return false
}

// oneLine removes color codes (§x), joins the lines and trims to maxReply bytes.
func oneLine(s string) string {
	var b strings.Builder
	skip := false
	for _, r := range s {
		switch {
		case skip:
			skip = false
		case r == '§':
			skip = true
		default:
			b.WriteRune(r)
		}
	}
	s = strings.Join(strings.Fields(b.String()), " ")
	if len(s) > maxReply {
		cut := maxReply
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
}

// syncDir syncs a directory's entries (renames and new files).
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
