// Package backup creates, lists, prunes and restores backups of a server's data (spec §6.5).
package backup

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/klauspost/compress/zstd"

	"mcsm/agent/internal/files"
)

// Excluder decides which paths do not go into the backup. Paths are relative to the data
// root and use `/`. A pattern without `/` is matched against the name at any depth
// ("logs", "*.tmp"); one with `/`, against the full relative path ("world/session.lock").
// An excluded directory is skipped entirely.
//
// The temporaries of atomic file writes (files.TempGlob, at any
// depth) are always left out, also with a nil Excluder: a backup during an
// upload would include the half-written temporary.
type Excluder struct{ base, full []string }

// NewExcluder validates the patterns (path.Match syntax).
func NewExcluder(patterns []string) (*Excluder, error) {
	e := &Excluder{}
	for _, p := range patterns {
		p = strings.Trim(p, "/")
		if p == "" {
			continue
		}
		if _, err := path.Match(p, ""); err != nil {
			return nil, fmt.Errorf("invalid exclusion pattern %q: %w", p, err)
		}
		if strings.Contains(p, "/") {
			e.full = append(e.full, p)
		} else {
			e.base = append(e.base, p)
		}
	}
	return e, nil
}

// Excluded reports whether the relative path rel is left out of the backup. With e nil it only excludes
// the temporaries of atomic writes.
func (e *Excluder) Excluded(rel string) bool {
	name := path.Base(rel)
	if files.IsTempName(name) {
		return true
	}
	if e == nil {
		return false
	}
	for _, p := range e.base {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	for _, p := range e.full {
		if ok, _ := path.Match(p, rel); ok {
			return true
		}
	}
	return false
}

// ArchiveStats summarizes a backup.
type ArchiveStats struct {
	Files    int
	Bytes    int64    // uncompressed content
	Warnings []string // skipped entries (deleted or no longer files during the backup)
}

// ProgressFunc receives the content bytes copied and the expected total.
type ProgressFunc func(done, total int64)

// entry is a scan entry. info (Lstat) fixes the entry's type and, except for
// regular files (whose header comes from what is there when they are opened), its header.
type entry struct {
	rel  string // relative to the root, with `/`
	info fs.FileInfo
	link string // target, if it is a symbolic link
}

// ErrSourceChanged: a file changed (size, mtime or bytes read) while its content was being
// copied. The backup is not valid: it is never silently truncated or padded.
var ErrSourceChanged = errors.New("changed while being copied")

// copyBufSize is the content copy buffer (read and extract).
const copyBufSize = 1 << 20

// WriteArchive writes the contents of src (without the directory itself) as a tar compressed
// with zstd. It does not follow symbolic links: it stores them as links. Everything is read through
// an os.Root opened at src: even if a container process swaps a directory for a
// link midway through the backup, the agent (root) never reads anything from outside the data. A
// file is copied as it is when opened; if it changes while being read, the backup fails with
// ErrSourceChanged (it is never truncated or padded). One that disappears before being opened is
// skipped (it ends up in Warnings). The sha256 is computed by the caller on the fly
// by wrapping w (io.MultiWriter). If it fails or is cancelled, it does NOT close the tar or the
// zstd frame: what was written is left truncated and unreadable for ExtractArchive instead of passing as a
// complete backup.
func WriteArchive(ctx context.Context, src string, w io.Writer, excl *Excluder, progress ProgressFunc) (ArchiveStats, error) {
	var st ArchiveStats
	if err := ctx.Err(); err != nil {
		return st, err
	}
	root, err := os.OpenRoot(src)
	if err != nil {
		return st, err
	}
	defer root.Close()
	entries, total, err := scan(ctx, root, excl, &st)
	if err != nil {
		return st, err
	}
	// Synchronous compression on a single thread: no goroutine keeps writing to w if
	// this fails, and it does not steal CPU from the servers running on the node.
	enc, err := zstd.NewWriter(w, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(1))
	if err != nil {
		return st, err
	}
	tw := tar.NewWriter(enc)
	buf := make([]byte, copyBufSize)
	var done int64
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return st, err
		}
		n, skipped, warn, err := writeEntry(ctx, tw, root, e, buf)
		if err != nil {
			return st, fmt.Errorf("%s: %w", e.rel, err)
		}
		if warn != "" {
			st.Warnings = append(st.Warnings, warn)
		}
		if e.info.Mode().IsRegular() && !skipped {
			st.Files++
		}
		done += n
		if progress != nil {
			progress(done, total)
		}
	}
	if err := tw.Close(); err != nil {
		return st, err
	}
	if err := enc.Close(); err != nil {
		return st, err
	}
	st.Bytes = done
	return st, nil
}

// scan walks the root in lexical order (each directory before its contents) applying
// the exclusions; it returns the entries and the total size of the regular files.
func scan(ctx context.Context, root *os.Root, excl *Excluder, st *ArchiveStats) ([]entry, int64, error) {
	var out []entry
	var total int64
	var walk func(dir string, want fs.FileInfo) error
	walk = func(dir string, want fs.FileInfo) error {
		des, changed, err := readDirIn(root, dir, want)
		if err != nil {
			return err
		}
		if changed {
			st.Warnings = append(st.Warnings, "skipped the contents of "+dir+" (it stopped being the same directory during the backup)")
			return nil
		}
		for _, d := range des {
			if err := ctx.Err(); err != nil {
				return err
			}
			rel := d.Name()
			if dir != "." {
				rel = dir + "/" + rel
			}
			if excl.Excluded(rel) {
				continue
			}
			info, err := d.Info()
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			e := entry{rel: rel, info: info}
			switch {
			case info.Mode()&fs.ModeSymlink != 0:
				if e.link, err = root.Readlink(rel); err != nil {
					if errors.Is(err, fs.ErrNotExist) {
						continue
					}
					return err
				}
				out = append(out, e)
			case info.Mode().IsRegular():
				total += info.Size()
				out = append(out, e)
			case info.IsDir():
				out = append(out, e)
				if err := walk(rel, info); err != nil {
					return err
				}
			default:
				st.Warnings = append(st.Warnings, "skipped (not a file or directory): "+rel)
			}
		}
		return nil
	}
	err := walk(".", nil)
	return out, total, err
}

// readDirIn lists a root directory, sorted by name. want is what the scan saw
// (nil for the root itself). If in the meantime it was replaced by a file, a FIFO or
// a link (outside or to another directory inside), it returns changed without listing it; if it
// disappeared, nothing. O_DIRECTORY makes opening a sneaked-in FIFO fail instead of blocking.
func readDirIn(root *os.Root, dir string, want fs.FileInfo) (des []fs.DirEntry, changed bool, err error) {
	f, err := root.OpenFile(dir, os.O_RDONLY|syscall.O_DIRECTORY, 0)
	if err != nil {
		if want == nil {
			return nil, false, err
		}
		// It is decided by what is there now, not by the error (os.Root does not export the "escapes" one).
		now, lerr := root.Lstat(dir)
		switch {
		case errors.Is(lerr, fs.ErrNotExist):
			return nil, false, nil // disappeared during the walk
		case lerr == nil && !now.IsDir():
			return nil, true, nil
		}
		return nil, false, err
	}
	defer f.Close()
	if want != nil {
		now, err := f.Stat()
		if err != nil {
			return nil, false, err
		}
		if !os.SameFile(want, now) { // e.g. a link to another directory inside, already followed
			return nil, true, nil
		}
	}
	des, err = f.ReadDir(-1)
	slices.SortFunc(des, func(a, b fs.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	return des, false, err
}

// writeEntry writes an entry. A regular file's header comes from what is there when it is
// opened (not from the scan): a file that changed earlier is copied as it is. If it changes
// while being read (bytes read, size or mtime differ at the end), it fails with
// ErrSourceChanged: what was written to the tar does not correspond to any state of the file.
func writeEntry(ctx context.Context, tw *tar.Writer, root *os.Root, e entry, buf []byte) (n int64, skipped bool, warn string, err error) {
	if !e.info.Mode().IsRegular() {
		hdr, err := entryHeader(e.info, e)
		if err != nil {
			return 0, false, "", err
		}
		return 0, false, "", tw.WriteHeader(hdr)
	}
	// O_NONBLOCK: if the file was swapped for a FIFO after the scan, opening it does not
	// block (and it is discarded below); on regular files it has no effect.
	f, err := root.OpenFile(e.rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, true, "skipped (deleted during the backup): " + e.rel, nil
		}
		return 0, false, "", err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return 0, false, "", err
	}
	if !before.Mode().IsRegular() {
		return 0, true, "skipped (stopped being a file during the backup): " + e.rel, nil
	}
	hdr, err := entryHeader(before, e)
	if err != nil {
		return 0, false, "", err
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return 0, false, "", err
	}
	n, err = io.CopyBuffer(tw, io.LimitReader(cancelReader{ctx, f}, hdr.Size), buf)
	if err != nil {
		return n, false, "", err
	}
	after, err := f.Stat()
	if err != nil {
		return n, false, "", err
	}
	if n != hdr.Size || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return n, false, "", ErrSourceChanged
	}
	return n, false, "", nil
}

// entryHeader builds e's PAX header from info.
func entryHeader(info fs.FileInfo, e entry) (*tar.Header, error) {
	hdr, err := tar.FileInfoHeader(info, e.link)
	if err != nil {
		return nil, err
	}
	hdr.Name = e.rel
	if info.IsDir() {
		hdr.Name += "/"
	}
	hdr.Format = tar.FormatPAX
	hdr.Uname, hdr.Gname = "", "" // numeric uid/gid only: the itzg image uses 1000
	hdr.AccessTime, hdr.ChangeTime = time.Time{}, time.Time{}
	return hdr, nil
}

// cancelReader cuts a long backup (a multi-GiB file) when ctx is cancelled.
type cancelReader struct {
	ctx context.Context
	r   io.Reader
}

func (c cancelReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// Default limits of an extraction (ExtractLimits with zeros).
const (
	DefaultMaxExtractBytes   int64 = 256 << 30 // 256 GiB uncompressed
	DefaultMaxExtractEntries       = 2_000_000

	maxEntryName  = 4096      // PATH_MAX
	maxZstdWindow = 128 << 20 // like `zstd --long`; bounds the decompressor's memory
	maxTrailing   = 1 << 20   // padding allowed after the end of the tar (GNU tar pads to 10 KiB)
	tarBlock      = 512
)

// errExtractBytes: the extraction exceeded ExtractLimits.MaxBytes.
var errExtractBytes = errors.New("the backup exceeds the limit")

// ExtractLimits bounds what an extraction can create (decompression bombs). A
// zero field takes the default value.
type ExtractLimits struct {
	MaxBytes   int64 // sum of the declared sizes of the regular files
	MaxEntries int   // tar entries, of any type
}

func (l ExtractLimits) withDefaults() ExtractLimits {
	if l.MaxBytes <= 0 {
		l.MaxBytes = DefaultMaxExtractBytes
	}
	if l.MaxEntries <= 0 {
		l.MaxEntries = DefaultMaxExtractEntries
	}
	return l
}

// geteuid is replaceable in tests (restoring the owner is only attempted as root).
var geteuid = os.Geteuid

// ExtractArchive extracts with the default limits (see ExtractArchiveLimits).
func ExtractArchive(ctx context.Context, r io.Reader, dst string, warn func(string)) error {
	return ExtractArchiveLimits(ctx, r, dst, warn, ExtractLimits{})
}

// ExtractArchiveLimits decompresses into dst, which must exist and be empty. Everything is created
// through an os.Root opened at dst: no write leaves it, not even after
// resolving links. It rejects the whole backup on an absolute path, one with `..` or invalid, or
// if it exceeds the limits; it creates no symbolic links, hard links or special files
// (it skips them, warning through warn). It restores permissions (without setuid, setgid or sticky), dates
// and, if the agent runs as root, the tar's owner (the itzg image uses uid 1000).
// If it fails, it deletes what was extracted: dst is left empty as it was.
func ExtractArchiveLimits(ctx context.Context, r io.Reader, dst string, warn func(string), lim ExtractLimits) error {
	if warn == nil {
		warn = func(string) {}
	}
	fi, err := os.Lstat(dst)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("the destination %s is not a directory", dst)
	}
	root, err := os.OpenRoot(dst)
	if err != nil {
		return err
	}
	defer root.Close()
	names, err := dirNames(root, 1)
	if err != nil {
		return err
	}
	if len(names) > 0 {
		return fmt.Errorf("the destination %s is not empty", dst)
	}
	dec, err := zstd.NewReader(r, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxWindow(maxZstdWindow))
	if err != nil {
		return err
	}
	defer dec.Close()
	x := &extractor{ctx: ctx, root: root, warn: warn, lim: lim.withDefaults(), buf: make([]byte, copyBufSize)}
	if err := x.run(dec); err != nil {
		if names, lerr := dirNames(root, -1); lerr == nil {
			for _, n := range names {
				_ = root.RemoveAll(n)
			}
		}
		return err
	}
	return nil
}

// dirNames lists up to n names (n < 0: all) of the root.
func dirNames(root *os.Root, n int) ([]string, error) {
	d, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer d.Close()
	names, err := d.Readdirnames(n)
	if errors.Is(err, io.EOF) {
		err = nil
	}
	return names, err
}

type extractor struct {
	ctx         context.Context
	root        *os.Root
	warn        func(string)
	lim         ExtractLimits
	buf         []byte
	entries     int
	bytes       int64
	ownerWarned bool
}

type dirMeta struct {
	name  string
	mode  fs.FileMode
	mtime time.Time
}

func (x *extractor) run(dec io.Reader) error {
	tail := &tailReader{r: cancelReader{x.ctx, dec}} // ctx also inside Next()
	tr := tar.NewReader(tail)
	var dirs []dirMeta
	for {
		if err := x.ctx.Err(); err != nil {
			return err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if errors.Is(err, tar.ErrInsecurePath) && hdr != nil {
			return fmt.Errorf("entry with unsafe path %q: backup rejected", hdr.Name)
		}
		if err != nil {
			return fmt.Errorf("unreadable or corrupted backup: %w", err)
		}
		if x.entries++; x.entries > x.lim.MaxEntries {
			return fmt.Errorf("the backup exceeds the limit of %d entries: rejected", x.lim.MaxEntries)
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			continue // global PAX metadata (git archive); archive/tar already read it, bounded
		}
		name, err := entryName(hdr.Name)
		if err != nil {
			return err
		}
		// archive/tar only ignores the Size of "header only" types; for the others, whatever is not
		// read is discarded by Next() decompressing it in full. Everything counts toward the limit.
		if !headerOnly(hdr.Typeflag) {
			if hdr.Size > x.lim.MaxBytes-x.bytes {
				return fmt.Errorf("%w of %d decompressed bytes: rejected", errExtractBytes, x.lim.MaxBytes)
			}
			x.bytes += hdr.Size
		}
		mode := fs.FileMode(hdr.Mode).Perm() // without setuid, setgid or sticky
		switch hdr.Typeflag {
		case tar.TypeDir:
			if name == "." {
				continue // the destination itself: its permissions are decided by the caller
			}
			if err := x.root.MkdirAll(name, 0o755); err != nil {
				return err
			}
			if geteuid() == 0 {
				x.ownerErr(name, x.root.Lchown(name, hdr.Uid, hdr.Gid))
			}
			dirs = append(dirs, dirMeta{name, mode, hdr.ModTime})
		case tar.TypeReg:
			if name == "." {
				return fmt.Errorf("entry with invalid name %q: backup rejected", hdr.Name)
			}
			if dir := path.Dir(name); dir != "." {
				if err := x.root.MkdirAll(dir, 0o755); err != nil {
					return err
				}
			}
			if err := x.file(name, tr, hdr, mode); err != nil {
				return err
			}
		default:
			// GNU sparse, contiguous, unknown types…: they are not restored, and if they carry content
			// the backup is not ours nor a plain tar of a data directory.
			if hdr.Size > 0 {
				return fmt.Errorf("entry %q of unsupported type (%q) with content: backup rejected", hdr.Name, hdr.Typeflag)
			}
			x.warn(fmt.Sprintf("skipped %s: links and special files are not restored", hdr.Name))
		}
	}
	// archive/tar also gives io.EOF if the stream ends at an entry boundary: without the
	// two final zero blocks the backup is cut off (or empty) and is not accepted.
	if tail.zeros < 2*tarBlock {
		return errors.New("incomplete backup (the end of the tar is missing): rejected")
	}
	// Reading what remains of the frame forces zstd to check its checksum: this way
	// corrupted data is detected even if it had been decompressed without error.
	n, err := io.Copy(io.Discard, io.LimitReader(dec, maxTrailing+1))
	if err != nil {
		return fmt.Errorf("unreadable or corrupted backup: %w", err)
	}
	if n > maxTrailing {
		return errors.New("backup with extra data after the end of the tar: rejected")
	}
	// Permissions and dates of the directories at the end (writing inside changes their mtime), from
	// the deepest to the top ones.
	for i := len(dirs) - 1; i >= 0; i-- {
		_ = x.root.Chmod(dirs[i].name, dirs[i].mode)
		_ = x.root.Chtimes(dirs[i].name, dirs[i].mtime, dirs[i].mtime)
	}
	return nil
}

// file creates name (O_EXCL: it never overwrites or follows anything existing) with r's content. If
// anything fails, it deletes the half-written file.
func (x *extractor) file(name string, r io.Reader, hdr *tar.Header, mode fs.FileMode) (err error) {
	f, err := x.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if err != nil {
			if !closed {
				_ = f.Close()
			}
			_ = x.root.Remove(name)
		}
	}()
	// struct{io.Writer} hides File.ReadFrom so that the copy uses buf.
	if _, err = io.CopyBuffer(struct{ io.Writer }{f}, cancelReader{x.ctx, r}, x.buf); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			err = fmt.Errorf("unreadable or corrupted backup: %w", err)
		}
		return err
	}
	// On the descriptor (fchown/fchmod): no races with the path. chown before chmod,
	// because chown can clear mode bits.
	if geteuid() == 0 {
		x.ownerErr(name, f.Chown(hdr.Uid, hdr.Gid))
	}
	if err = f.Chmod(mode); err != nil {
		return err
	}
	closed = true
	if err = f.Close(); err != nil {
		return err
	}
	_ = x.root.Chtimes(name, hdr.ModTime, hdr.ModTime)
	return nil
}

// ownerErr warns (only once per extraction) that an owner could not be restored:
// the backup is still valid, but the server may not be able to write those files.
func (x *extractor) ownerErr(name string, err error) {
	if err == nil || x.ownerWarned {
		return
	}
	x.ownerWarned = true
	x.warn(fmt.Sprintf("warning: could not restore the owner of %s (%v); there may be more cases", name, err))
}

// headerOnly are the types whose Size archive/tar ignores (they have no content).
func headerOnly(flag byte) bool {
	switch flag {
	case tar.TypeLink, tar.TypeSymlink, tar.TypeChar, tar.TypeBlock, tar.TypeDir, tar.TypeFifo:
		return true
	}
	return false
}

// tailReader counts the run of zero bytes that ends what has been read so far.
type tailReader struct {
	r     io.Reader
	zeros int64
}

func (t *tailReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	i := n - 1
	for i >= 0 && p[i] == 0 {
		i--
	}
	if i < 0 {
		t.zeros += int64(n)
	} else {
		t.zeros = int64(n - 1 - i)
	}
	return n, err
}

// entryName validates a tar entry's name and returns it normalized (relative,
// with `/`, without empty or `.` components; "." for the destination itself). It rejects absolute
// paths, any `..` component (even if it does not leave the destination), NUL and
// oversized names: such an entry makes the whole backup hostile.
func entryName(raw string) (string, error) {
	if raw == "" || len(raw) > maxEntryName || strings.ContainsRune(raw, 0) {
		return "", fmt.Errorf("entry with invalid name %q: backup rejected", raw)
	}
	if strings.HasPrefix(raw, "/") {
		return "", fmt.Errorf("entry with absolute path %q: backup rejected", raw)
	}
	parts := make([]string, 0, strings.Count(raw, "/")+1)
	for p := range strings.SplitSeq(raw, "/") {
		switch p {
		case "", ".":
		case "..":
			return "", fmt.Errorf("entry that leaves the destination %q: backup rejected", raw)
		default:
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return ".", nil
	}
	return strings.Join(parts, "/"), nil
}
