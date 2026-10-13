package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// migratedInfix: <slug>.migrated-<ts> is the directory of a server that the source node keeps
// after a confirmed migration (spec §7, step 7).
const migratedInfix = ".migrated-"

var sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidSHA256 says whether s is a lowercase hexadecimal sha256 (64 characters).
func ValidSHA256(s string) bool { return sha256Re.MatchString(s) }

// MigratedName is the name under which a server's directory on the source node is set aside, next to it,
// when a migration is confirmed: e.g. survival.migrated-20261012T040000.000Z. It keeps data and
// its backups and leaves <slug> free (the server may come back, or another one be created with that slug).
func MigratedName(serverDir string, t time.Time) string {
	return filepath.Base(serverDir) + migratedInfix + t.UTC().Format(tsLayout)
}

// CheckSpace fails, wrapping ErrNoSpace, if dir cannot fit need bytes plus the margin
// max(5 %, 256 MiB) with which the node's servers can keep saving. If the free space
// cannot be queried it does not fail: the writes watch it afterwards. free nil uses statfs.
func CheckSpace(dir string, need int64, what string, free func(dir string) (uint64, error)) error {
	if free == nil {
		free = freeSpace
	}
	got, err := free(dir)
	if err != nil {
		return nil
	}
	n := uint64(max(need, 0))
	if req := requiredSpace(need); got < req {
		return fmt.Errorf("%w for %s: %s needed (%s plus a margin of %s so the node's servers can keep saving) and %s free on %s; %s short",
			ErrNoSpace, what, humanBytes(req), humanBytes(n), humanBytes(req-n), humanBytes(got), dir, humanBytes(req-got))
	}
	return nil
}

// ReceiveRequest describes a backup arriving from another node (migration, spec §7).
type ReceiveRequest struct {
	BackupsDir string
	ServerID   string
	Slug       string
	Filename   string    // <slug>-<ts>-<version>.tar.zst (ValidName with Slug)
	Body       io.Reader // the backup; at most Size+1 bytes are read
	Size       int64     // exact bytes that must arrive
	SHA256     string    // lowercase hex of the whole file
	// ExtractBytes is what it will take once extracted (0 = unknown: Size is taken). While it arrives it is
	// required that it still fits with the margin: the restore comes right afterwards.
	ExtractBytes int64
	Now          func() time.Time
	FreeSpace    func(dir string) (uint64, error) // nil: statfs
	Progress     func(done, total int64)
}

// Receive writes the backup as <Filename>.partial in BackupsDir computing its sha256 and, only if
// exactly Size bytes arrive with that sha256, writes its .json (trigger pre_migration) and
// renames it to its final name: Restore verifies it again with that .json. If anything fails, it is
// cancelled or space runs out, it leaves nothing (neither partial nor .json) and never overwrites an
// existing backup.
func Receive(ctx context.Context, req ReceiveRequest) (meta Meta, err error) {
	if req.Now == nil {
		req.Now = time.Now
	}
	if req.FreeSpace == nil {
		req.FreeSpace = freeSpace
	}
	if req.Progress == nil {
		req.Progress = func(int64, int64) {}
	}
	if !ValidName(req.Slug, req.Filename) {
		return Meta{}, fmt.Errorf("invalid backup name %q", req.Filename)
	}
	if req.Size <= 0 || !sha256Re.MatchString(req.SHA256) {
		return Meta{}, errors.New("invalid backup size or sha256")
	}
	started, version, _ := parseName(req.Slug, req.Filename)
	if err := os.MkdirAll(req.BackupsDir, 0o750); err != nil {
		return Meta{}, fmt.Errorf("create the backups directory: %w", err)
	}
	final := filepath.Join(req.BackupsDir, req.Filename)
	if _, serr := os.Lstat(final); serr == nil {
		return Meta{}, fmt.Errorf("the backup %s already exists", req.Filename)
	}
	extract := req.ExtractBytes
	if extract <= 0 {
		extract = req.Size
	}
	partial := final + partialExt
	f, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return Meta{}, fmt.Errorf("create the backup: %w", err)
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
	// What must stay free while it arrives: the extraction that comes afterwards, with its margin.
	guard := &spaceGuard{w: f, free: req.FreeSpace, dir: req.BackupsDir, margin: requiredSpace(extract), since: -1}
	src := &progressReader{r: ctxReader{ctx: ctx, r: io.LimitReader(req.Body, req.Size+1)}, total: req.Size, fn: req.Progress}
	var n int64
	n, err = io.Copy(io.MultiWriter(guard, h), src)
	if err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return Meta{}, fmt.Errorf("receive cancelled: %w", cerr)
		}
		return Meta{}, fmt.Errorf("receive the backup: %w", err)
	}
	if n < req.Size {
		return Meta{}, fmt.Errorf("the backup arrived incomplete: %d bytes of %d", n, req.Size)
	}
	if n > req.Size {
		return Meta{}, fmt.Errorf("the backup arrived with extra bytes: %d were expected", req.Size)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if sum != req.SHA256 {
		return Meta{}, fmt.Errorf("the backup arrived corrupted: sha256 %s, expected %s", sum, req.SHA256)
	}
	if err = f.Sync(); err != nil {
		return Meta{}, fmt.Errorf("save the backup to disk: %w", err)
	}
	closed = true
	if err = f.Close(); err != nil {
		return Meta{}, fmt.Errorf("save the backup to disk: %w", err)
	}
	meta = Meta{
		Filename: req.Filename, ServerID: req.ServerID, Slug: req.Slug, SpecVersion: version, Trigger: TriggerPreMigration,
		SizeBytes: req.Size, SHA256: sum, StartedAt: started.UTC(), FinishedAt: req.Now().UTC(), DataBytes: req.ExtractBytes,
	}
	if err = WriteMeta(req.BackupsDir, meta); err != nil {
		return Meta{}, fmt.Errorf("save the backup's metadata: %w", err)
	}
	if err = rename(partial, final); err != nil {
		_ = os.Remove(final + MetaExt)
		return Meta{}, fmt.Errorf("save the backup: %w", err)
	}
	_ = syncDir(req.BackupsDir)
	return meta, nil
}
