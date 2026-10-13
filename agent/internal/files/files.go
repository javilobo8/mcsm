// Package files implements a server's file operations confined to
// its data directory (spec §6.6).
//
// Each path goes through three barriers:
//  1. Clean: lexical validation; ".." and control characters are rejected, never "fixed".
//  2. resolve: filepath.EvalSymlinks + prefix check with separator against the real root.
//  3. I/O is done with os.Root (openat without following links that leave the root): if a link
//     is changed between the check and the use (TOCTOU), the operation fails instead of escaping.
package files

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/spec"
)

// InlineMax is the maximum inline read/write over the WebSocket (spec §6.6).
const InlineMax = 2 << 20

// maxEntries limits a listing; the rest is marked as truncated. A variable for tests.
var maxEntries = 5000

// tmpPrefix starts the name of the temporaries of atomic writes (see TempGlob).
const tmpPrefix = ".mcsm-tmp-"

// TempGlob matches (path.Match) exactly the name of an atomic write's
// temporary: tmpPrefix and 16 lowercase hexadecimal characters (randHex). Those are hidden in
// listings, backups always exclude them (backup.Excluder) and SweepTemps sweeps
// the orphans. A user file that merely starts the same way (".mcsm-tmp-notes") is
// just another file: it is shown, copied and not swept.
const TempGlob = tmpPrefix + "[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]" +
	"[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"

// IsTempName reports whether name (a name, without folders) is that of an atomic write's
// temporary (TempGlob).
func IsTempName(name string) bool {
	ok, _ := path.Match(TempGlob, name)
	return ok
}

var (
	ErrInvalidPath   = errors.New("invalid path")
	ErrOutside       = errors.New("the path leaves the server's directory")
	ErrUnknownServer = errors.New("unknown server on this node")
	ErrNotFound      = errors.New("does not exist")
	ErrExists        = errors.New("already exists")
	ErrIsDir         = errors.New("is a folder")
	ErrNotDir        = errors.New("is not a folder")
	ErrTooLarge      = errors.New("too large to open inline (max. 2 MiB): download it")
	ErrRoot          = errors.New("the server's root folder cannot be modified")
	ErrTransfer      = errors.New("transfer failed")
)

// Code translates an error to its protocol code (Error.code).
func Code(err error) string {
	switch {
	case errors.Is(err, ErrInvalidPath):
		return errcode.InvalidPath
	case errors.Is(err, ErrOutside):
		return errcode.PathOutside
	case errors.Is(err, ErrUnknownServer):
		return errcode.UnknownServer
	case errors.Is(err, ErrNotFound):
		return errcode.NotFound
	case errors.Is(err, ErrExists):
		return errcode.Exists
	case errors.Is(err, ErrIsDir):
		return errcode.IsDir
	case errors.Is(err, ErrNotDir):
		return errcode.NotDir
	case errors.Is(err, ErrTooLarge):
		return errcode.TooLarge
	case errors.Is(err, ErrRoot):
		return errcode.Root
	case errors.Is(err, ErrTransfer):
		return errcode.TransferFailed
	default:
		return errcode.IOError
	}
}

// Entry describes a file or folder.
type Entry struct {
	Name    string
	Dir     bool
	Symlink bool
	Size    int64
	ModTime time.Time
	Mode    fs.FileMode // permission bits only
}

// Root returns a server's data directory: <dataRoot>/<slug>/data.
func Root(dataRoot, slug string) (string, error) {
	if !spec.ValidSlug(slug) {
		return "", fmt.Errorf("%w: slug %q", ErrInvalidPath, slug)
	}
	return filepath.Join(filepath.Clean(dataRoot), slug, "data"), nil
}

// FS operates inside a root.
type FS struct {
	root string
	// afterCheck is invoked between the check of a path and its use. Tests only (TOCTOU).
	afterCheck func()
}

// New creates an FS confined to root (normally the result of Root).
func New(root string) *FS { return &FS{root: filepath.Clean(root)} }

// Clean validates a path from the panel ("/", "mods/a.jar", "/config/x.yml") and returns it relative
// to the root, with "/" as separator ("." is the root).
func Clean(p string) (string, error) {
	if len(p) > 4096 {
		return "", fmt.Errorf("%w: too long", ErrInvalidPath)
	}
	parts := make([]string, 0, 8)
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".":
			continue
		case "..":
			return "", fmt.Errorf("%w: \"..\" is not allowed", ErrInvalidPath)
		}
		for _, r := range seg {
			if r < 0x20 || r == 0x7f {
				return "", fmt.Errorf("%w: contains control characters", ErrInvalidPath)
			}
		}
		parts = append(parts, seg)
	}
	if len(parts) == 0 {
		return ".", nil
	}
	return strings.Join(parts, "/"), nil
}

// display is the path as the user sees it ("/" + relative).
func display(rel string) string {
	if rel == "." {
		return "/"
	}
	return "/" + rel
}

// within checks that p is root or hangs under root. The separator prevents /x/data2
// from passing as "inside" /x/data.
func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// realRoot resolves the links of the root itself (DATA_ROOT may be a link).
func (f *FS) realRoot() (string, error) {
	r, err := filepath.EvalSymlinks(f.root)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("%w: the server's data folder does not exist yet (start it once)", ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("I/O error in the data folder: %v", errors.Unwrap(err))
	}
	return r, nil
}

// resolve applies spec §6.6 to a clean path: EvalSymlinks and prefix. It returns the real path
// relative to the real root (following the links that remain inside).
func (f *FS) resolve(rel string) (string, error) {
	root, err := f.realRoot()
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
			// If an intermediate component leaves the root it is reported as such, not as
			// "does not exist": what is outside is not revealed.
			if rel != "." {
				if _, perr := f.resolve(path.Dir(rel)); errors.Is(perr, ErrOutside) {
					return "", perr
				}
			}
			return "", fmt.Errorf("%w: %s", ErrNotFound, display(rel))
		}
		if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENAMETOOLONG) {
			return "", fmt.Errorf("%w: %s", ErrInvalidPath, display(rel))
		}
		// EACCES and the like: a host I/O failure, not a bad user path.
		return "", mapErr(err, rel)
	}
	if !within(root, real) {
		return "", fmt.Errorf("%w: %s", ErrOutside, display(rel))
	}
	out, err := filepath.Rel(root, real)
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrOutside, display(rel))
	}
	return filepath.ToSlash(out), nil
}

// resolveEntry resolves the parent folder (following links) and keeps the last component
// without following it: deleting or renaming a link acts on the link, never on its target.
func (f *FS) resolveEntry(rel string) (string, error) {
	if rel == "." {
		return "", ErrRoot
	}
	parent, err := f.resolve(path.Dir(rel))
	if err != nil {
		return "", err
	}
	return path.Join(parent, path.Base(rel)), nil
}

// open opens the real root as os.Root. It is opened on each operation: a backup restore
// renames the folder and a saved descriptor would point to the old one.
func (f *FS) open() (*os.Root, error) {
	if f.afterCheck != nil {
		f.afterCheck()
	}
	root, err := f.realRoot()
	if err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("I/O error in the data folder: %v", errors.Unwrap(err))
	}
	return r, nil
}

// The stdlib does not export errPathEscapes (os/file.go): there is no typed way to recognize it and the
// text is compared; TestTOCTOUSwapToSymlinkIsRefused fails if it changes.
// isEscape detects os.Root's error when a path leaves the root.
func isEscape(err error) bool {
	var pe *fs.PathError
	if errors.As(err, &pe) && pe.Err != nil && pe.Err.Error() == "path escapes from parent" {
		return true
	}
	var le *os.LinkError
	return errors.As(err, &le) && le.Err != nil && le.Err.Error() == "path escapes from parent"
}

// mapErr translates os.Root errors into the package's errors, without absolute host paths.
func mapErr(err error, rel string) error {
	if err == nil {
		return nil
	}
	d := display(rel)
	switch {
	case isEscape(err):
		return fmt.Errorf("%w: %s", ErrOutside, d)
	case errors.Is(err, fs.ErrNotExist):
		return fmt.Errorf("%w: %s", ErrNotFound, d)
	case errors.Is(err, fs.ErrExist):
		return fmt.Errorf("%w: %s", ErrExists, d)
	case errors.Is(err, syscall.ENOTDIR):
		return fmt.Errorf("%w: %s", ErrNotDir, d)
	case errors.Is(err, syscall.EISDIR):
		return fmt.Errorf("%w: %s", ErrIsDir, d)
	case errors.Is(err, syscall.EINVAL):
		return fmt.Errorf("%w: %s", ErrInvalidPath, d)
	}
	cause := err
	var pe *fs.PathError
	var le *os.LinkError
	if errors.As(err, &pe) {
		cause = pe.Err
	} else if errors.As(err, &le) {
		cause = le.Err
	}
	return fmt.Errorf("I/O error in %s: %v", d, cause)
}

func entryOf(name string, info fs.FileInfo) Entry {
	return Entry{
		Name: name, Dir: info.IsDir(), Symlink: info.Mode()&fs.ModeSymlink != 0,
		Size: info.Size(), ModTime: info.ModTime(), Mode: info.Mode().Perm(),
	}
}

// List returns a folder's contents: folders first and then by name. Links
// that point inside the root are described by their target; those that leave, as links.
func (f *FS) List(p string) ([]Entry, bool, error) {
	rel, err := Clean(p)
	if err != nil {
		return nil, false, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return nil, false, err
	}
	r, err := f.open()
	if err != nil {
		return nil, false, err
	}
	defer r.Close()
	d, err := r.Open(real)
	if err != nil {
		return nil, false, mapErr(err, rel)
	}
	defer d.Close()
	st, err := d.Stat()
	if err != nil {
		return nil, false, mapErr(err, rel)
	}
	if !st.IsDir() {
		return nil, false, fmt.Errorf("%w: %s", ErrNotDir, display(rel))
	}
	des, err := d.ReadDir(maxEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, false, mapErr(err, rel)
	}
	truncated := len(des) > maxEntries
	if truncated {
		des = des[:maxEntries]
	}
	out := make([]Entry, 0, len(des))
	for _, de := range des {
		if IsTempName(de.Name()) {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue // deleted between ReadDir and Info
		}
		e := entryOf(de.Name(), info)
		if e.Symlink {
			if target, err := r.Stat(path.Join(real, de.Name())); err == nil {
				e.Dir, e.Size, e.ModTime = target.IsDir(), target.Size(), target.ModTime()
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, truncated, nil
}

// Stat describes a path following the links that remain inside the root.
func (f *FS) Stat(p string) (Entry, error) {
	rel, err := Clean(p)
	if err != nil {
		return Entry{}, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return Entry{}, err
	}
	r, err := f.open()
	if err != nil {
		return Entry{}, err
	}
	defer r.Close()
	info, err := r.Stat(real)
	if err != nil {
		return Entry{}, mapErr(err, rel)
	}
	return entryOf(path.Base(display(rel)), info), nil
}

// openRegular opens only regular files. O_NONBLOCK avoids getting blocked when opening a
// FIFO someone created inside /data; on a regular file it has no effect.
func openRegular(r *os.Root, real, rel string) (*os.File, fs.FileInfo, error) {
	fh, err := r.OpenFile(real, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, mapErr(err, rel)
	}
	info, err := fh.Stat()
	if err != nil {
		fh.Close()
		return nil, nil, mapErr(err, rel)
	}
	if info.IsDir() {
		fh.Close()
		return nil, nil, fmt.Errorf("%w: %s", ErrIsDir, display(rel))
	}
	if !info.Mode().IsRegular() {
		fh.Close()
		return nil, nil, fmt.Errorf("%w: %s is not a regular file", ErrInvalidPath, display(rel))
	}
	return fh, info, nil
}

// Read reads a whole file if it does not exceed max (or InlineMax if max <= 0 or it is greater).
func (f *FS) Read(p string, max int64) ([]byte, int64, error) {
	if max <= 0 || max > InlineMax {
		max = InlineMax
	}
	rel, err := Clean(p)
	if err != nil {
		return nil, 0, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return nil, 0, err
	}
	r, err := f.open()
	if err != nil {
		return nil, 0, err
	}
	defer r.Close()
	fh, info, err := openRegular(r, real, rel)
	if err != nil {
		return nil, 0, err
	}
	defer fh.Close()
	if info.Size() > max {
		return nil, info.Size(), fmt.Errorf("%w: %s takes %d bytes", ErrTooLarge, display(rel), info.Size())
	}
	data, err := io.ReadAll(io.LimitReader(fh, max+1))
	if err != nil {
		return nil, 0, mapErr(err, rel)
	}
	if int64(len(data)) > max { // it grew while being read
		return nil, int64(len(data)), fmt.Errorf("%w: %s", ErrTooLarge, display(rel))
	}
	return data, info.Size(), nil
}

// Open opens a regular file to download it as a stream. The caller closes it.
func (f *FS) Open(p string) (*os.File, Entry, error) {
	rel, err := Clean(p)
	if err != nil {
		return nil, Entry{}, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return nil, Entry{}, err
	}
	r, err := f.open()
	if err != nil {
		return nil, Entry{}, err
	}
	defer r.Close() // the open file remains valid after closing the root
	fh, info, err := openRegular(r, real, rel)
	if err != nil {
		return nil, Entry{}, err
	}
	return fh, entryOf(path.Base(rel), info), nil
}
