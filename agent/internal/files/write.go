package files

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"syscall"
)

// writeTarget is the already validated destination of a write.
type writeTarget struct {
	real  string      // real path relative to the root
	mode  fs.FileMode // permissions to keep (0o644 if new)
	owner fs.FileInfo // whose uid/gid to copy: the replaced file or its folder
}

// prepareWrite validates a write's destination: the folder exists and is inside, the destination
// is not a folder and, if it is a link that stays inside, it is written to its real target.
func (f *FS) prepareWrite(r *os.Root, rel string) (writeTarget, error) {
	target, err := f.resolveEntry(rel)
	if err != nil {
		return writeTarget{}, err
	}
	li, err := r.Lstat(target)
	switch {
	case err == nil:
		if li.Mode()&fs.ModeSymlink != 0 {
			if target, err = f.resolve(target); err != nil {
				return writeTarget{}, err
			}
			if li, err = r.Stat(target); err != nil {
				return writeTarget{}, mapErr(err, rel)
			}
		}
		if li.IsDir() {
			return writeTarget{}, fmt.Errorf("%w: %s", ErrIsDir, display(rel))
		}
		if !li.Mode().IsRegular() {
			return writeTarget{}, fmt.Errorf("%w: %s is not a regular file", ErrInvalidPath, display(rel))
		}
		return writeTarget{real: target, mode: li.Mode().Perm(), owner: li}, nil
	case errors.Is(err, fs.ErrNotExist):
		pi, err := r.Stat(path.Dir(target))
		if err != nil {
			return writeTarget{}, mapErr(err, path.Dir(rel))
		}
		if !pi.IsDir() {
			return writeTarget{}, fmt.Errorf("%w: %s", ErrNotDir, display(path.Dir(rel)))
		}
		return writeTarget{real: target, mode: 0o644, owner: pi}, nil
	default:
		return writeTarget{}, mapErr(err, rel)
	}
}

// CheckWrite validates that p can be written without touching anything. It serves to fail before
// starting a transfer; WriteFrom validates again when writing.
func (f *FS) CheckWrite(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	_, err = f.prepareWrite(r, rel)
	return err
}

// readErr marks errors that come from the source (the transfer), not from the disk.
type readErr struct{ error }

func (e readErr) Unwrap() error { return e.error }

type tagReader struct{ r io.Reader }

func (t tagReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && err != io.EOF {
		err = readErr{err}
	}
	return n, err
}

func randHex() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// WriteFrom writes src to p atomically: temporary in the same folder, fsync and rename.
// If anything fails, the previous file is left intact and the temporary is deleted. expected >= 0 demands
// that exact number of bytes (a truncated transfer never replaces the file) and reads no
// more than expected+1 from the source; with expected < 0 there is no cap. It keeps the
// permissions and owner of the replaced file; a new one inherits its folder's owner, so that
// the server (uid 1000 in itzg) can keep rewriting it even if the agent is root.
// It copies as a stream: the memory used does not depend on the size.
func (f *FS) WriteFrom(p string, src io.Reader, expected int64) (int64, error) {
	rel, err := Clean(p)
	if err != nil {
		return 0, err
	}
	r, err := f.open()
	if err != nil {
		return 0, err
	}
	defer r.Close()
	wt, err := f.prepareWrite(r, rel)
	if err != nil {
		return 0, err
	}
	tmp := path.Join(path.Dir(wt.real), tmpPrefix+randHex())
	fh, err := r.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, wt.mode)
	if err != nil {
		return 0, mapErr(err, rel)
	}
	closed, renamed := false, false
	defer func() {
		if !closed {
			fh.Close()
		}
		if !renamed {
			_ = r.Remove(tmp)
		}
	}()
	if expected >= 0 && expected < math.MaxInt64 {
		src = io.LimitReader(src, expected+1) // a source that sends too much does not fill the disk
	}
	n, err := io.Copy(fh, tagReader{src})
	if err != nil {
		var re readErr
		if errors.As(err, &re) {
			return n, fmt.Errorf("%w: %v", ErrTransfer, re.error)
		}
		return n, mapErr(err, rel)
	}
	switch {
	case expected >= 0 && n > expected:
		return n, fmt.Errorf("%w: the source sends more than %d bytes", ErrTransfer, expected)
	case expected >= 0 && n < expected:
		return n, fmt.Errorf("%w: received %d of %d bytes", ErrTransfer, n, expected)
	}
	if err := fh.Chmod(wt.mode); err != nil { // the umask may have trimmed the permissions on creation
		return n, mapErr(err, rel)
	}
	chownLike(fh, wt.owner)
	if err := fh.Sync(); err != nil {
		return n, mapErr(err, rel)
	}
	closed = true
	if err := fh.Close(); err != nil {
		return n, mapErr(err, rel)
	}
	if err := r.Rename(tmp, wt.real); err != nil {
		return n, mapErr(err, rel)
	}
	renamed = true
	if d, err := r.Open(path.Dir(wt.real)); err == nil { // so the rename survives a power cut
		_ = d.Sync()
		d.Close()
	}
	return n, nil
}

// Write is the inline write (editor): at most InlineMax bytes.
func (f *FS) Write(p string, data []byte) error {
	if len(data) > InlineMax {
		return fmt.Errorf("%w: %d bytes", ErrTooLarge, len(data))
	}
	_, err := f.WriteFrom(p, bytes.NewReader(data), int64(len(data)))
	return err
}

// chownLike copies uid/gid from ref. Without privileges it fails with EPERM and is ignored: the file
// stays with the agent's user, which is the same as the folder's in that case.
func chownLike(fh *os.File, ref fs.FileInfo) {
	if st, ok := ref.Sys().(*syscall.Stat_t); ok {
		_ = fh.Chown(int(st.Uid), int(st.Gid))
	}
}

// Mkdir creates a folder (its parent must exist) with the parent folder's owner.
func (f *FS) Mkdir(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	target, err := f.resolveEntry(rel)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	pi, err := r.Stat(path.Dir(target))
	if err != nil {
		return mapErr(err, path.Dir(rel))
	}
	if err := r.Mkdir(target, 0o755); err != nil {
		return mapErr(err, rel)
	}
	if st, ok := pi.Sys().(*syscall.Stat_t); ok {
		_ = r.Lchown(target, int(st.Uid), int(st.Gid))
	}
	return nil
}

// Rename moves or renames without overwriting: if the destination exists it returns ErrExists.
// Renaming a link moves the link, not its target.
func (f *FS) Rename(from, to string) error {
	src, err := Clean(from)
	if err != nil {
		return err
	}
	dst, err := Clean(to)
	if err != nil {
		return err
	}
	s, err := f.resolveEntry(src)
	if err != nil {
		return err
	}
	d, err := f.resolveEntry(dst)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	if _, err := r.Lstat(s); err != nil {
		return mapErr(err, src)
	}
	if _, err := r.Lstat(d); err == nil {
		return fmt.Errorf("%w: %s", ErrExists, display(dst))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return mapErr(err, dst)
	}
	if err := r.Rename(s, d); err != nil {
		return mapErr(err, dst)
	}
	return nil
}

// Delete deletes a file, a link (not its target) or a folder with all its contents.
func (f *FS) Delete(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	target, err := f.resolveEntry(rel)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	li, err := r.Lstat(target)
	if err != nil {
		return mapErr(err, rel)
	}
	if li.IsDir() {
		return mapErr(r.RemoveAll(target), rel)
	}
	return mapErr(r.Remove(target), rel)
}
