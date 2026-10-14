package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/files"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
)

// Migration between nodes (Plan 7, spec §7). The panel orchestrates; the agent runs idempotent
// steps. Source: BackupPush (uploads the pre_migration backup to the panel) and MigrateRetire (retires
// it on confirmation). Target: MigrateReceive (receives and restores) and MigrateAbort (undoes).

// errMigrateExists: the target already has the server or its directory; nothing is overwritten.
var errMigrateExists = errors.New("already exists")

// migrateErrCode translates a failure of the migration messages to the protocol's Error.code.
func migrateErrCode(err error) string {
	switch {
	case errors.Is(err, reconcile.ErrBusy), errors.Is(err, errTransfersBusy), errors.Is(err, errClosing), errors.Is(err, errFilesClosing):
		return errcode.Busy
	case errors.Is(err, errUnknownServer):
		return errcode.UnknownServer
	case errors.Is(err, errBadRequest):
		return errcode.InvalidRequest
	case errors.Is(err, errMigrateExists):
		return errcode.Exists
	case errors.Is(err, backup.ErrNoSpace):
		return errcode.TooLarge
	case errors.Is(err, files.ErrTransfer):
		return errcode.TransferFailed
	case errors.Is(err, fs.ErrNotExist):
		return errcode.NotFound
	default:
		return errcode.BackupFailed
	}
}

// handleBackupPush uploads a backup to the panel (PUT /agent/transfer/{id}) and answers with its
// metadata when the panel has received all of it. It counts as a Files* in progress for the shutdown
// (xfer.enter) and takes one of the node's transfer slots. ctx: the agent's life context.
func (a *App) handleBackupPush(ctx context.Context, id uint64, m *mcsmv1.BackupPush, send func(*mcsmv1.Envelope) error) {
	if !a.xfer.enter() {
		_ = send(errMsg(id, errcode.Busy, errFilesClosing))
		return
	}
	defer a.xfer.leave()
	res, err := a.backupPush(ctx, m)
	if err != nil {
		_ = send(errMsg(id, migrateErrCode(err), err))
		return
	}
	_ = send(&mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_BackupPushResult{BackupPushResult: res}})
}

func (a *App) backupPush(ctx context.Context, m *mcsmv1.BackupPush) (*mcsmv1.BackupPushResult, error) {
	t, err := a.bk.target(m.GetServerId())
	if err != nil {
		return nil, err
	}
	if !backup.ValidName(t.slug, m.GetFilename()) {
		return nil, fmt.Errorf("%w: invalid backup name %q", errBadRequest, m.GetFilename())
	}
	meta, err := backup.ReadMeta(t.backupsDir, m.GetFilename())
	if err != nil || meta.SHA256 == "" {
		return nil, fmt.Errorf("the backup %s has no sha256 in its .json: it is not sent without being able to verify it", m.GetFilename())
	}
	// Opened before claiming the transfer: a backup that no longer exists does not consume it. The
	// descriptor stays valid even if pruning deletes it while it is being sent.
	f, err := os.Open(filepath.Join(t.backupsDir, m.GetFilename()))
	if err != nil {
		return nil, fmt.Errorf("open the backup: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: the backup is not a regular file", errBadRequest)
	}
	xfer, err := a.transfers()
	if err != nil {
		return nil, err
	}
	release, err := a.xfer.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	size := fi.Size()
	err = a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		// LimitReader: what it measured when opened is sent; if it shrinks, Put fails because of Content-Length.
		if err := xfer.Put(ctx, m.GetTransferId(), track(io.LimitReader(f, size)), size); err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &mcsmv1.BackupPushResult{SizeBytes: uint64(size), Sha256: meta.SHA256, DataBytes: uint64(max(meta.DataBytes, 0))}, nil
}

// ── Receiving on the target ──

const (
	// jobTypeMigrateIn is the receive's job type (JobProgress.type, inventory).
	jobTypeMigrateIn = "migrate_in"
	// holdMigration is the reason for the reservation during a migration's steps.
	holdMigration = "migration"
	// migrationMarker is created in <DATA_ROOT>/<slug> when receiving a migration and contains its id:
	// MigrateAbort only deletes a directory with that same migration's marker.
	migrationMarker = ".mcsm-migration"
	// committedMark precedes the id in the marker of a confirmed migration (MigrateConfirm):
	// "committed <migration_id>". From then on no MigrateAbort deletes that directory.
	committedMark = "committed "
	// retiringMarker is written in the source's <DATA_ROOT>/<slug>, with the migration's id, before
	// forgetting the spec when retiring it: a retry without a spec only touches a <slug> with that mark.
	retiringMarker = ".mcsm-retiring"
	// maxMigrateBytes bounds size_bytes and data_bytes (an absurd value would overflow the arithmetic).
	maxMigrateBytes = 1 << 50
)

func (b *backupService) handleMigrateReceive(id uint64, m *mcsmv1.MigrateReceive, send func(*mcsmv1.Envelope) error) {
	if err := b.startReceive(m); err != nil {
		_ = send(errMsg(id, migrateErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// startReceive validates, registers the job (an already known job_id resends its state, §5.4),
// checks that neither the server nor its directory exist on this node and that the backup plus its
// extraction fit with the margin, reserves the server and launches the receive in the background.
func (b *backupService) startReceive(m *mcsmv1.MigrateReceive) error {
	if m.GetJobId() == "" || m.GetServerId() == "" || m.GetMigrationId() == "" {
		return fmt.Errorf("%w: job_id, server_id or migration_id missing", errBadRequest)
	}
	if !spec.ValidSlug(m.GetSlug()) || !backup.ValidName(m.GetSlug(), m.GetFilename()) {
		return fmt.Errorf("%w: invalid slug or backup name", errBadRequest)
	}
	if m.GetSizeBytes() == 0 || m.GetSizeBytes() > maxMigrateBytes || m.GetDataBytes() > maxMigrateBytes || !backup.ValidSHA256(m.GetSha256()) {
		return fmt.Errorf("%w: invalid backup size or sha256", errBadRequest)
	}
	j, existing, err := b.jobs.Begin(m.GetJobId(), m.GetServerId(), jobTypeMigrateIn)
	if err != nil {
		return err
	}
	if existing != nil {
		b.jobs.Replay(existing)
		return nil
	}
	fail := func(err error) error {
		b.finish(j, err, "")
		return err
	}
	sp, err := b.a.st.GetSpec(m.GetServerId())
	if err != nil {
		return fail(err)
	}
	if sp != nil {
		return fail(fmt.Errorf("%w: the server is already on this node", errMigrateExists))
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	if _, err := os.Lstat(dir); err == nil {
		return fail(fmt.Errorf("%w: %s already exists on the target node; move or delete it before migrating here", errMigrateExists, dir))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fail(err)
	}
	size, extract := int64(m.GetSizeBytes()), int64(m.GetDataBytes())
	if extract <= 0 {
		extract = size
	}
	if err := backup.CheckSpace(b.a.cfg.DataRoot, size+extract, "receiving the migration", b.freeSpace); err != nil {
		return fail(err)
	}
	// Reservation without a spec: an ApplySpec arriving during the receive is only stored; it is applied
	// (and creates the container) on release, with data already restored. No Files* can write to this
	// server (serverFS answers unknown_server before fileWrites.enter): there are no writes to wait for.
	release, err := b.a.rec.Hold(m.GetServerId(), holdMigration)
	if err != nil {
		return fail(err)
	}
	if !b.spawn(func() { b.runReceive(m, dir, j, release) }) {
		release(b.a.life)
		return fail(errClosing)
	}
	return nil
}

func (b *backupService) runReceive(m *mcsmv1.MigrateReceive, dir string, j *jobs.Job, release func(context.Context)) {
	ctx := b.a.life
	err := b.withSlot(ctx, j, func() error { return b.receive(ctx, m, dir, j) })
	err = interrupted(ctx, err)
	release(b.a.life) // normally without a spec: there is nothing to reconcile
	b.finish(j, err, "Backup received, verified and restored at "+filepath.Join(dir, "data"))
}

// receive creates <DATA_ROOT>/<slug> (exclusive) with the migration's marker, downloads the backup
// to its backups/ checking size and sha256, and restores it as data/ with backup.Restore (which
// verifies it again, checks the space and bounds the extraction). If anything fails, it deletes the
// whole directory: this receive created it.
func (b *backupService) receive(ctx context.Context, m *mcsmv1.MigrateReceive, dir string, j *jobs.Job) (err error) {
	if err := os.Mkdir(dir, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%w: %s already exists on the target node", errMigrateExists, dir)
		}
		return fmt.Errorf("create %s: %w", dir, err)
	}
	defer func() {
		if err == nil {
			return
		}
		if rerr := os.RemoveAll(dir); rerr != nil {
			j.Log("warning: could not delete " + dir + " (delete it by hand): " + rerr.Error())
		}
	}()
	if err := os.WriteFile(filepath.Join(dir, migrationMarker), []byte(m.GetMigrationId()+"\n"), 0o644); err != nil {
		return fmt.Errorf("mark the migration directory: %w", err)
	}
	xfer, err := b.a.transfers()
	if err != nil {
		return err
	}
	releaseSlot, err := b.a.xfer.acquire()
	if err != nil {
		return err
	}
	backupsDir := backup.Dir(b.a.cfg.DataRoot, m.GetSlug())
	size := int64(m.GetSizeBytes())
	j.Progress(1, "Receiving the backup from the panel")
	err = b.a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		body, got, err := xfer.Get(ctx, m.GetTransferId())
		if err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		defer body.Close()
		if got >= 0 && got != size {
			return fmt.Errorf("%w: the panel announces %d bytes and the backup is %d", files.ErrTransfer, got, size)
		}
		_, err = backup.Receive(ctx, backup.ReceiveRequest{
			BackupsDir: backupsDir, ServerID: m.GetServerId(), Slug: m.GetSlug(), Filename: m.GetFilename(),
			Body: track(body), Size: size, SHA256: m.GetSha256(), ExtractBytes: int64(m.GetDataBytes()),
			Now: b.clock.Now, FreeSpace: b.freeSpace,
			Progress: func(done, total int64) {
				j.Progress(1+uint32(done*49/max(total, 1)), "Receiving the backup from the panel")
			},
		})
		return err
	})
	releaseSlot()
	if err != nil {
		return err
	}
	j.Log("backup received and verified (sha256 " + m.GetSha256() + ")")
	_, err = b.restore(ctx, backup.RestoreRequest{
		ServerID: m.GetServerId(), Slug: m.GetSlug(), Filename: m.GetFilename(),
		DataDir: filepath.Join(dir, "data"), BackupsDir: backupsDir, Now: b.clock.Now,
		Progress: func(pct uint32, msg string) { j.Progress(50+pct/2, msg) }, Log: j.Log, SyncFS: b.syncFS,
	})
	return err
}

// ── Undoing on the target and retiring the source ──

func (b *backupService) handleMigrateAbort(id uint64, m *mcsmv1.MigrateAbort, send func(*mcsmv1.Envelope) error) {
	b.respondAsync(id, send, func() error { return b.abortMigration(m) })
}

func (b *backupService) handleMigrateRetire(id uint64, m *mcsmv1.MigrateRetire, send func(*mcsmv1.Envelope) error) {
	b.respondAsync(id, send, func() error { return b.retireMigration(m) })
}

func (b *backupService) handleMigrateConfirm(id uint64, m *mcsmv1.MigrateConfirm, send func(*mcsmv1.Envelope) error) {
	b.respondAsync(id, send, func() error { return b.confirmMigration(m) })
}

// respondAsync runs fn in the background, counted in wg like the backups (the shutdown waits for it), and
// answers Ack or Error when finished. If the agent is shutting down, busy.
func (b *backupService) respondAsync(id uint64, send func(*mcsmv1.Envelope) error, fn func() error) {
	if !b.spawn(func() {
		if err := fn(); err != nil {
			_ = send(errMsg(id, migrateErrCode(err), err))
			return
		}
		_ = send(ack(id))
	}) {
		_ = send(errMsg(id, errcode.Busy, errClosing))
	}
}

func checkMigrationMsg(serverID, slug, migrationID string) error {
	if serverID == "" || migrationID == "" || !spec.ValidSlug(slug) {
		return fmt.Errorf("%w: server_id or migration_id missing, or the slug is not valid", errBadRequest)
	}
	return nil
}

// migMark is the .mcsm-migration marker of a <DATA_ROOT>/<slug> received by migration.
type migMark struct {
	present   bool
	committed bool // "committed <id>": confirmed (MigrateConfirm)
	id        string
}

// pendingOf: the directory was created by migration id and has not been confirmed yet.
func (m migMark) pendingOf(id string) bool { return m.present && !m.committed && m.id == id }

func (m migMark) String() string {
	switch {
	case !m.present:
		return "no migration marker"
	case m.committed:
		return "migration " + m.id + " confirmed"
	default:
		return "migration " + m.id + " not confirmed"
	}
}

func readMigMark(dir string) (migMark, error) {
	b, err := os.ReadFile(filepath.Join(dir, migrationMarker))
	if errors.Is(err, fs.ErrNotExist) {
		return migMark{}, nil
	}
	if err != nil {
		return migMark{}, err
	}
	s := strings.TrimSpace(string(b))
	if id, ok := strings.CutPrefix(s, committedMark); ok {
		return migMark{present: true, committed: true, id: id}, nil
	}
	return migMark{present: true, id: s}, nil
}

// writeMarker writes a marker atomically (temporary + rename): a cut midway never
// leaves an empty or half-written marker.
func writeMarker(dir, name, content string) error {
	tmp := filepath.Join(dir, name+".tmp")
	if err := os.WriteFile(tmp, []byte(content+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// abortMigration undoes on the target what an unconfirmed migration left: the spec and the
// container (Forget and release the reservation, which stops and deletes it via its tombstone) and the directory,
// only if it carries this migration's UNCONFIRMED marker, no other server on the node uses it
// and there is no container left that mounts it. The marker is read before touching the spec: if the server
// is on this node and its directory is not an unconfirmed copy of this migration (confirmed with
// MigrateConfirm, from another migration or without a marker), invalid_request without touching anything. This way a late abort
// (e.g. from a panel restored from a snapshot prior to the commit) never deletes the live
// server. Repeating it does nothing.
func (b *backupService) abortMigration(m *mcsmv1.MigrateAbort) error {
	if err := checkMigrationMsg(m.GetServerId(), m.GetSlug(), m.GetMigrationId()); err != nil {
		return err
	}
	id := m.GetServerId()
	unlock, err := b.migLocks.lock(b.a.life, id)
	if err != nil {
		return err
	}
	defer unlock()
	sp, err := b.a.st.GetSpec(id)
	if err != nil {
		return err
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	mark, err := readMigMark(dir)
	if err != nil {
		return err
	}
	switch {
	case sp != nil && sp.Slug != m.GetSlug():
		return fmt.Errorf("%w: the server has another slug on this node (%s)", errBadRequest, sp.Slug)
	case sp != nil:
		if !mark.pendingOf(m.GetMigrationId()) {
			return fmt.Errorf("%w: the server on this node is not an unconfirmed copy of migration %s (%s); it is not touched", errBadRequest, m.GetMigrationId(), mark)
		}
		if err := b.forgetHeld(id, nil); err != nil {
			return err
		}
	default:
		if reason := b.a.rec.HeldReason(id); reason != "" {
			return fmt.Errorf("%w: it will be retried when finished", reconcile.Busy(reason))
		}
	}
	if err := b.removalDone(id); err != nil {
		return err
	}
	b.a.hub.Reset(id)
	if mark, err = readMigMark(dir); err != nil {
		return err
	}
	if !mark.pendingOf(m.GetMigrationId()) {
		if mark.present {
			b.a.log.Warn("undo migration: the directory is not from this unconfirmed migration; it is not touched", "dir", dir, "marker", mark.String())
		}
		return nil // nothing from this migration on disk (or already deleted)
	}
	if err := b.dirFree(id, m.GetSlug()); err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("delete %s: %w", dir, err)
	}
	return nil
}

// confirmMigration marks as confirmed the migration that brought the server to this node:
// it rewrites the marker as "committed <id>". Without a marker (or already confirmed), it does nothing.
func (b *backupService) confirmMigration(m *mcsmv1.MigrateConfirm) error {
	if err := checkMigrationMsg(m.GetServerId(), m.GetSlug(), m.GetMigrationId()); err != nil {
		return err
	}
	unlock, err := b.migLocks.lock(b.a.life, m.GetServerId())
	if err != nil {
		return err
	}
	defer unlock()
	sp, err := b.a.st.GetSpec(m.GetServerId())
	if err != nil {
		return err
	}
	if sp != nil && sp.Slug != m.GetSlug() {
		return fmt.Errorf("%w: the server has another slug on this node (%s)", errBadRequest, sp.Slug)
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	mark, err := readMigMark(dir)
	switch {
	case err != nil:
		return err
	case !mark.present:
		return nil
	case mark.id != m.GetMigrationId():
		return fmt.Errorf("%w: %s carries another migration's marker (%s); it is not touched", errBadRequest, dir, mark)
	case mark.committed:
		return nil
	}
	return writeMarker(dir, migrationMarker, committedMark+m.GetMigrationId())
}

// retireMigration retires the server from the source after confirming the migration. With the spec on the
// node it checks that it is the version that was migrated (source_version: a server that later came back to
// this node has another) and marks <slug> with .mcsm-retiring; with the reservation held, it stops the
// container if someone started it and checks that it stopped, forgets the spec and releases the reservation
// (which deletes the container via its tombstone). Only then, with no container mounting it, it sets
// <DATA_ROOT>/<slug> (data and backups) aside to <DATA_ROOT>/<slug>.migrated-<ts> or, with delete_data,
// deletes it. A retry without a spec (after a cut, a pending container deletion or a lost
// response) only touches a <slug> with this retirement's mark: one freshly created by a receive
// (unconfirmed migration marker) or a foreign one gives invalid_request.
func (b *backupService) retireMigration(m *mcsmv1.MigrateRetire) error {
	if err := checkMigrationMsg(m.GetServerId(), m.GetSlug(), m.GetMigrationId()); err != nil {
		return err
	}
	id := m.GetServerId()
	unlock, err := b.migLocks.lock(b.a.life, id)
	if err != nil {
		return err
	}
	defer unlock()
	sp, err := b.a.st.GetSpec(id)
	if err != nil {
		return err
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	if sp != nil {
		if sp.Slug != m.GetSlug() {
			return fmt.Errorf("%w: the server has another slug on this node (%s)", errBadRequest, sp.Slug)
		}
		if sp.Version != m.GetSourceVersion() {
			return fmt.Errorf("%w: the server on this node has version %d and the migration was done with %d (did it come back here afterwards?); it is not touched",
				errBadRequest, sp.Version, m.GetSourceVersion())
		}
		if _, err := os.Lstat(dir); err == nil {
			if err := writeMarker(dir, retiringMarker, m.GetMigrationId()); err != nil {
				return fmt.Errorf("mark %s for retirement: %w", dir, err)
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := b.forgetHeld(id, func() error { return b.stopForRetire(id) }); err != nil {
			return err
		}
	}
	if err := b.removalDone(id); err != nil {
		return err
	}
	b.a.hub.Reset(id)
	if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := b.retiringDir(dir, m.GetMigrationId()); err != nil {
		return err
	}
	if err := b.dirFree(id, m.GetSlug()); err != nil {
		return err
	}
	if m.GetDeleteData() {
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("delete %s: %w", dir, err)
		}
		b.a.log.Info("migration confirmed: source data deleted", "server", id, "dir", dir)
		return nil
	}
	to := filepath.Join(b.a.cfg.DataRoot, backup.MigratedName(dir, b.clock.Now()))
	// rename(2) would silently replace an empty directory with that name.
	if _, err := os.Lstat(to); err == nil {
		return fmt.Errorf("%w: %s already exists; it will be retried", reconcile.Busy(holdMigration), to)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Rename(dir, to); err != nil {
		return fmt.Errorf("set %s aside: %w", dir, err)
	}
	b.a.log.Info("migration confirmed: the source data is kept", "server", id, "at", to)
	return nil
}

// retiringDir checks that <slug> carries this migration's .mcsm-retiring mark (written by the
// retirement with the spec and version checked). If not, it is not this retirement's directory.
func (b *backupService) retiringDir(dir, migrationID string) error {
	got, err := os.ReadFile(filepath.Join(dir, retiringMarker))
	if err == nil && strings.TrimSpace(string(got)) == migrationID {
		return nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if mark, merr := readMigMark(dir); merr == nil && mark.present && !mark.committed {
		return fmt.Errorf("%w: %s is a receive in progress or the leftover of another migration (%s); it is not touched", errBadRequest, dir, mark)
	}
	return fmt.Errorf("%w: %s does not carry this retirement's mark (%s); it is not touched", errBadRequest, dir, retiringMarker)
}

// keyedLocks: one lock per server (zero value usable). lock waits for its turn or for the agent's
// shutdown.
type keyedLocks struct {
	mu    sync.Mutex
	locks map[string]*keyedLock
	// notify (tests): receives a notice, without blocking, every time someone starts waiting for a turn.
	notify chan struct{}
}

type keyedLock struct {
	ch      chan struct{}
	refs    int // those who hold it or wait for it (deleted on reaching 0)
	waiting int
}

func (k *keyedLocks) lock(ctx context.Context, id string) (func(), error) {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = map[string]*keyedLock{}
	}
	l := k.locks[id]
	if l == nil {
		l = &keyedLock{ch: make(chan struct{}, 1)}
		k.locks[id] = l
	}
	l.refs++
	l.waiting++
	if k.notify != nil {
		select {
		case k.notify <- struct{}{}:
		default:
		}
	}
	k.mu.Unlock()
	done := func() {
		k.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(k.locks, id)
		}
		k.mu.Unlock()
	}
	select {
	case l.ch <- struct{}{}:
		k.mu.Lock()
		l.waiting--
		k.mu.Unlock()
		return func() { <-l.ch; done() }, nil
	case <-ctx.Done():
		k.mu.Lock()
		l.waiting--
		k.mu.Unlock()
		done()
		return nil, errClosing
	}
}

// waiting: how many wait for a turn for id (tests).
func (k *keyedLocks) waiting(id string) int {
	k.mu.Lock()
	defer k.mu.Unlock()
	if l := k.locks[id]; l != nil {
		return l.waiting
	}
	return 0
}

// dirFree checks, before deleting or setting aside <DATA_ROOT>/<slug>, that no other server on the
// node uses that slug (invalid_request: it is not touched) and that the server no longer has a container that
// mounts it (busy: it will be retried). Docker not responding also prevents touching it.
func (b *backupService) dirFree(serverID, slug string) error {
	specs, err := b.a.st.ListSpecs()
	if err != nil {
		return err
	}
	for _, sp := range specs {
		if sp.Slug == slug && sp.ServerId != serverID {
			return fmt.Errorf("%w: %s is the directory of another server on this node (%s); it is not touched", errBadRequest, slug, sp.ServerId)
		}
	}
	c, err := b.a.rec.Container(b.a.life, serverID)
	if err != nil {
		return errCheckContainer(err)
	}
	if c != nil {
		return fmt.Errorf("%w: the server's container still exists; it will be retried", reconcile.Busy(holdMigration))
	}
	return nil
}

// forgetHeld reserves the server, waits for the file writes in progress, runs before (if
// there is one) with the reservation held, forgets the spec (leaves a tombstone) and releases the reservation, which stops and deletes
// its container. If anything fails before forgetting, it releases without more: the server stays as it was.
func (b *backupService) forgetHeld(id string, before func() error) error {
	ctx := b.a.life
	release, err := b.a.rec.Hold(id, holdMigration)
	if err != nil {
		return err
	}
	if err := b.waitFileWrites(id); err != nil {
		release(ctx)
		return err
	}
	if before != nil {
		if err := before(); err != nil {
			release(ctx)
			return err
		}
	}
	if err := b.a.rec.Forget(id); err != nil {
		release(ctx)
		return err
	}
	release(ctx) // with a tombstone: it completes the container's deletion (or leaves it to the tombstone retry)
	return nil
}

// waitFileWrites waits, for at most drainWait, for the file writes that were already
// in progress on the server when reserving it to finish (new ones already answer busy). See fileWrites.
func (b *backupService) waitFileWrites(id string) error {
	select {
	case <-b.a.fileWrites.drained(id):
		return nil
	case <-b.clock.Until(b.clock.Now().Add(b.drainWait)):
		return fmt.Errorf("%w: there are file operations in progress on the server; it will be retried", reconcile.Busy(holdMigration))
	case <-b.a.life.Done():
		return errClosing
	}
}

// removalDone fails with busy if the container's deletion was left pending (tombstone): the tombstone
// pass retries it and the panel repeats the order.
func (b *backupService) removalDone(id string) error {
	tomb, err := b.a.st.HasTombstone(id)
	if err != nil {
		return err
	}
	if tomb {
		return fmt.Errorf("%w: the server's container could not be deleted yet; it will be retried", reconcile.Busy(holdMigration))
	}
	return nil
}

// stopForRetire stops the container if it is still running (the panel stopped it in step 1, but someone
// may have started it by hand) and checks that it stopped: a running server is never retired.
func (b *backupService) stopForRetire(id string) error {
	ctx := b.a.life
	running, err := b.isRunning(ctx, id)
	if err != nil || !running {
		return err
	}
	c, err := b.a.rec.Container(ctx, id)
	if err != nil {
		return errCheckContainer(err)
	}
	if c != nil {
		if err := b.a.eng.Stop(ctx, c.ID, reconcile.StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return fmt.Errorf("stop the server on the source: %w", err)
		}
	}
	if running, err := b.isRunning(ctx, id); err != nil {
		return err
	} else if running {
		return errors.New("the server is still running on the source: it is not retired")
	}
	return nil
}

// preMigrationReady: the backup prior to a migration requires the server to be stopped (the panel stops it in
// step 1; a start arriving afterwards would make it hot and the source would stay alive alongside
// the target) and without half-done file writes (like the restore). It is called with the reservation
// held: Power and Files already answer busy.
//
// plan-8 (H1): nor an on-demand server (hostname with the router's autoscale). mc-router would
// start it on its own until the retirement, and parking it (Park) only covers the backup: when the
// reservation is released it is recreated and started (mc-router does not see containers that never started), alive on the
// source at the same time as the backup on the target. The panel already rejects it when planning; this covers an
// out-of-date view of the node's router.
func (b *backupService) preMigrationReady(serverID string, j *jobs.Job) error {
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if b.a.onDemand(t.spec) {
		return fmt.Errorf("%w: the server has a hostname and this node's router has autoscale enabled (mc-router could start it during the migration); remove the autoscale or the hostname before migrating it", errBadRequest)
	}
	running, err := b.isRunning(b.a.life, serverID)
	if err != nil {
		return err
	}
	if running {
		return fmt.Errorf("%w: the server is running; the backup prior to a migration is made with the server stopped", errBadRequest)
	}
	return b.drainFileWrites(serverID, j)
}
