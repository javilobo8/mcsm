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
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// ErrDataMissing indicates that the restore set the data aside and could not return it: the
// data directory does NOT exist (the originals are still intact in the pre-restore that
// the error names). The caller must not start the server: Docker would create an empty data
// and the server would generate a new world on top.
var ErrDataMissing = errors.New("the server has been left without a data directory; do not start it until the data is put back in place")

// Margin of the space check: the greater of 5 % of what is going to be extracted and
// 256 MiB (block rounding, directories, and room for the node's servers to keep
// saving in the meantime).
const (
	spaceMarginPct = 5
	spaceMarginMin = 256 << 20
)

// RestoreRequest describes a restore. The server must be stopped: the caller stops it
// and also has it reserved in the reconciler.
type RestoreRequest struct {
	ServerID   string
	Slug       string
	Filename   string // name of the .tar.zst backup in BackupsDir
	DataDir    string
	BackupsDir string
	Now        func() time.Time
	Progress   func(pct uint32, msg string)
	Log        func(line string)
}

func (r *RestoreRequest) defaults() {
	if r.Now == nil {
		r.Now = time.Now
	}
	if r.Progress == nil {
		r.Progress = func(uint32, string) {}
	}
	if r.Log == nil {
		r.Log = func(string) {}
	}
}

// Injection points for tests: free space, the flush to disk, the swap's renames
// and the deletion of the temporary (to simulate failures and cancellations midway).
// They are package variables, so this package's tests do not use t.Parallel.
var (
	freeSpace = statfsFree
	syncFS    = syncFilesystem
	rename    = os.Rename
	removeAll = os.RemoveAll
)

// Restore replaces DataDir with the contents of a backup WITHOUT ever deleting the previous
// data (spec §6.5): it verifies the sha256 if there is one, checks the free space, extracts into
// <data>.restoring-<ts>, flushes it to disk, renames DataDir to <data>.pre-restore-<ts> and
// the extracted one to DataDir. As long as the swap has not completed, a failure or a
// cancellation leaves DataDir as it was (if the second rename fails, the first is
// undone; if that also fails, the error wraps ErrDataMissing) and the temporary
// directory is deleted. It returns the pre-restore directory's metadata (Filename empty if
// there was no previous data).
func Restore(ctx context.Context, req RestoreRequest) (Meta, error) {
	req.defaults()
	if !ValidName(req.Slug, req.Filename) {
		return Meta{}, fmt.Errorf("invalid backup name %q", req.Filename)
	}
	src := filepath.Join(req.BackupsDir, req.Filename)
	fi, err := os.Lstat(src)
	if err != nil {
		return Meta{}, fmt.Errorf("the backup %s is not on the node: %w", req.Filename, err)
	}
	if !fi.Mode().IsRegular() {
		return Meta{}, fmt.Errorf("the backup %s is not a regular file", req.Filename)
	}
	// What it will take: the uncompressed content if the backup recorded it; otherwise, at least
	// what it takes compressed.
	need := fi.Size()
	m, merr := ReadMeta(req.BackupsDir, req.Filename)
	if merr == nil && m.DataBytes > 0 {
		need = m.DataBytes
	}
	switch {
	case merr == nil && m.SHA256 != "":
		req.Progress(2, "Verifying the backup (sha256)")
		sum, err := fileSHA256(ctx, src)
		if err != nil {
			return Meta{}, fmt.Errorf("verify the backup: %w", err)
		}
		if sum != m.SHA256 {
			return Meta{}, fmt.Errorf("the backup is corrupted: sha256 %s, expected %s", sum, m.SHA256)
		}
		req.Log("sha256 verificado")
	case merr == nil:
		req.Log("warning: the backup's metadata carries no sha256; restoring without verifying")
	case errors.Is(merr, fs.ErrNotExist):
		req.Log("warning: the backup has no sha256 stored (its .json is missing); restoring without verifying")
	default:
		req.Log("warning: could not read the backup's .json (" + merr.Error() + "); restoring without verifying the sha256")
	}

	// Everything that can fail without writing anything, before extracting.
	now := req.Now()
	parent := filepath.Dir(req.DataDir)
	preName := PreRestoreName(req.DataDir, now)
	prePath := filepath.Join(parent, preName)
	if _, err := currentData(req.DataDir); err != nil {
		return Meta{}, err
	}
	// rename(2) would silently replace an empty directory with that name.
	if _, err := os.Lstat(prePath); err == nil {
		return Meta{}, fmt.Errorf("%s already exists: it is not overwritten; try again", preName)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Meta{}, err
	}
	free, known, err := checkSpace(parent, need, req.Log)
	if err != nil {
		return Meta{}, err
	}
	// S2: what is extracted cannot exceed what fits leaving the margin (a backup without a .json
	// arrives with need = compressed size and could decompress to much more).
	var lim ExtractLimits
	room := int64(-1)
	if known {
		room = int64(min(free-(requiredSpace(need)-uint64(max(need, 0))), uint64(DefaultMaxExtractBytes)))
		lim.MaxBytes = max(room, 1)
	}

	staging := req.DataDir + restoringInfix + now.UTC().Format(tsLayout)
	if err := os.Mkdir(staging, 0o755); err != nil {
		return Meta{}, fmt.Errorf("prepare the restore: %w", err)
	}
	swapped := false
	defer func() {
		if swapped {
			return
		}
		// Freshly created directory of our own (Mkdir fails if it already existed): deleting it is safe.
		if err := removeAll(staging); err != nil {
			req.Log("warning: could not delete the temporary directory " + staging + " (delete it by hand): " + err.Error())
		}
	}()
	f, err := os.Open(src)
	if err != nil {
		return Meta{}, err
	}
	defer f.Close()
	req.Progress(10, "Extracting the backup")
	pr := &progressReader{r: ctxReader{ctx: ctx, r: f}, total: max(fi.Size(), 1), fn: func(done, total int64) {
		req.Progress(10+uint32(done*80/total), "Extracting the backup")
	}}
	if err := ExtractArchiveLimits(ctx, pr, staging, req.Log, lim); err != nil {
		if cerr := ctx.Err(); cerr != nil { // not a corrupted backup: it was cancelled
			return Meta{}, fmt.Errorf("restore cancelled: %w", cerr)
		}
		if errors.Is(err, errExtractBytes) && room >= 0 && room < DefaultMaxExtractBytes {
			return Meta{}, fmt.Errorf("%w for restoring: the decompressed backup takes more than %s, which is what fits in %s leaving the margin for the node's servers to keep saving",
				ErrNoSpace, humanBytes(uint64(room)), parent)
		}
		return Meta{}, fmt.Errorf("extract the backup: %w", err)
	}
	// What was extracted, on disk before activating it: a power cut after the swap must not
	// leave half-written files in data (the previous ones will already be in the pre-restore).
	if err := syncCtx(ctx, staging); err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return Meta{}, fmt.Errorf("restore cancelled: %w", cerr)
		}
		return Meta{}, fmt.Errorf("flush the extracted backup to disk: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return Meta{}, fmt.Errorf("restore cancelled: %w", err)
	}

	cur, err := currentData(req.DataDir)
	if err != nil {
		return Meta{}, err
	}
	hadData := cur != nil
	if hadData {
		matchOwner(staging, cur)
		req.Progress(92, "Keeping the current data in "+preName)
		if err := rename(req.DataDir, prePath); err != nil {
			return Meta{}, fmt.Errorf("set the current data aside: %w", err)
		}
	}
	if err := rename(staging, req.DataDir); err != nil {
		if hadData {
			if uerr := rename(prePath, req.DataDir); uerr != nil {
				return Meta{}, fmt.Errorf("%w: activate the backup: %v; the original data could not be returned either, and it remains in %s: %v",
					ErrDataMissing, err, prePath, uerr)
			}
		}
		return Meta{}, fmt.Errorf("activate the backup: %w", err)
	}
	swapped = true
	req.Log("backup restored to " + req.DataDir)
	if !hadData {
		_ = syncDir(parent)
		return Meta{}, nil
	}
	pre := Meta{
		Filename: preName, ServerID: req.ServerID, Slug: req.Slug, Trigger: TriggerPreRestore,
		SizeBytes: dirSize(prePath), StartedAt: now.UTC(), FinishedAt: req.Now().UTC(),
	}
	if err := writeJSON(prePath+MetaExt, pre); err != nil {
		req.Log("warning: could not write the .json of " + preName + ": " + err.Error())
	}
	_ = syncDir(parent) // the two renames and the pre-restore's .json
	req.Log("previous data kept in " + preName + " (it is not deleted automatically)")
	return pre, nil
}

// syncCtx flushes dir's filesystem to disk while still attending to ctx.
// syncfs(2) cannot be interrupted. If it is cancelled in the meantime (e.g. the agent is
// shutting down), waiting stops and the restore fails without swapping anything; the
// goroutine stays in the kernel until the flush returns and then ends by itself.
// Trade-off: a goroutine and a descriptor held in exchange for not blocking the
// restore (with the server stopped and reserved) on a slow flush. A completely dead data
// filesystem would already block the extraction and the temporary's cleanup;
// only the data FS is flushed, never the host's other mounts.
func syncCtx(ctx context.Context, dir string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	done := make(chan error, 1) // with room: the abandoned goroutine does not hang when sending
	go func() { done <- syncFS(dir) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// syncFilesystem does syncfs(2) of the filesystem containing dir: only that FS,
// not sync(2), which walks all the host's mounts (and hangs with a dead NFS).
func syncFilesystem(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return unix.Syncfs(int(d.Fd()))
}

// currentData returns the current data directory, nil if it does not exist, or an error if it is
// something else (a symbolic link is not set aside either: renaming it would not move the data).
func currentData(dataDir string) (fs.FileInfo, error) {
	fi, err := os.Lstat(dataDir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, nil
	case err != nil:
		return nil, err
	case !fi.IsDir():
		return nil, fmt.Errorf("%s exists and is not a directory: it is not restored", dataDir)
	}
	return fi, nil
}

// requiredSpace is what must stay free to extract need bytes: need plus the margin.
func requiredSpace(need int64) uint64 {
	n := uint64(max(need, 0))
	return n + max(n*spaceMarginPct/100, spaceMarginMin)
}

// checkSpace fails if dir cannot fit the extraction with its margin and returns the free
// space (known false if it could not be queried: then it warns and lets it continue; if it really
// does not fit, the extraction will fail without touching the data).
func checkSpace(dir string, need int64, log func(string)) (free uint64, known bool, err error) {
	free, err = freeSpace(dir)
	if err != nil {
		log("warning: could not check the free space on " + dir + ": " + err.Error())
		return 0, false, nil
	}
	if req := requiredSpace(need); free < req {
		return free, true, fmt.Errorf("%w for restoring: %s needed (%s of data plus a margin of %s for block rounding and so the node's servers can keep saving) and %s free on %s; %s short",
			ErrNoSpace, humanBytes(req), humanBytes(uint64(max(need, 0))), humanBytes(req-uint64(max(need, 0))), humanBytes(free), dir, humanBytes(req-free))
	}
	return free, true, nil
}

// statfsFree is the space available to unprivileged users (without root's reserve):
// the server, which is not root, also needs room to write afterwards.
func statfsFree(dir string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return freeBytes(uint64(st.Bavail), int64(st.Frsize), int64(st.Bsize)), nil
}

// freeBytes: f_bavail is in units of f_frsize (on FUSE it may not match
// f_bsize); if the FS does not report f_frsize, f_bsize is used.
func freeBytes(bavail uint64, frsize, bsize int64) uint64 {
	unit := frsize
	if unit <= 0 {
		unit = bsize
	}
	return bavail * uint64(max(unit, 0))
}

func humanBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

type progressReader struct {
	r     io.Reader
	done  int64
	total int64
	fn    func(done, total int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.done += int64(n)
	p.fn(min(p.done, p.total), p.total)
	return n, err
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

func fileSHA256(ctx context.Context, p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, ctxReader{ctx: ctx, r: f}); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// matchOwner copies permissions and (if the agent is root) the owner of the original data
// directory to the restored one: the itzg image expects /data owned by uid 1000.
func matchOwner(p string, like fs.FileInfo) {
	_ = os.Chmod(p, like.Mode().Perm())
	if st, ok := like.Sys().(*syscall.Stat_t); ok && geteuid() == 0 {
		_ = os.Lchown(p, int(st.Uid), int(st.Gid))
	}
}

func dirSize(root string) int64 {
	var n int64
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, ierr := d.Info(); ierr == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}
