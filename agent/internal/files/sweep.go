package files

import (
	"context"
	"io/fs"
	"time"
)

// SweepTemps deletes the temporaries of atomic writes that were left orphaned (the agent died
// or shut down midway through an upload) and have gone unmodified for more than olderThan: those of an
// in-progress write change with every chunk, and a transfer stalled for more than a minute is
// cut off. It walks the root with os.Root, without following links or leaving it, and only deletes regular
// files with the exact name of a temporary. An unreadable folder does not stop the sweep; the
// context does. It returns how many it deleted.
func (f *FS) SweepTemps(ctx context.Context, olderThan time.Duration, now time.Time) (int, error) {
	r, err := f.open()
	if err != nil {
		return 0, err
	}
	defer r.Close()
	n := 0
	err = fs.WalkDir(r.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil || d.IsDir() || !IsTempName(d.Name()) {
			return nil
		}
		info, err := r.Lstat(p)
		if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) <= olderThan {
			return nil
		}
		if r.Remove(p) == nil {
			n++
		}
		return nil
	})
	return n, err
}
