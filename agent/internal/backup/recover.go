package backup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Recovery is what RecoverInterrupted did.
type Recovery struct {
	Removed    []string // leftovers deleted (paths)
	RolledBack string   // pre-restore returned to data (name), or "" if none
	Warnings   []string // leftovers that could not be deleted or read (they do not prevent starting)
}

// RecoverInterrupted leaves a server's disk coherent after an agent shutdown or crash
// midway through a backup or a restore. It is called at startup, before reconciling
// (or with the server reserved), when no backup or restore is in progress:
//
//   - In backupsDir it deletes half-done backups (<backup>.partial, <backup>.json.partial) and
//     orphan .json files without their .tar.zst, and next to data the .json.partial files of the pre-restores.
//   - If data does not exist and there are pre-restores, the only one without a .json, if it is also the most recent,
//     goes back to data with a rename. Restore writes that .json after the swap, so
//     without it the swap did not finish (crash between the two renames, or
//     ErrDataMissing): it is the original data, and without it Docker would create an empty data when
//     starting the container and the server would generate a new world. It goes back to the original
//     data and not to the extracted backup because the job ends up FAILED ("interrupted"). In
//     any other case (only completed restores, several without a .json, or the one without it
//     is not the most recent) the choice is doubtful: nothing is moved and the error
//     wraps ErrDataMissing so that the server does not start with an empty world.
//   - With data in place, it deletes the data.restoring-* extraction temporaries. Without data they
//     are left: they may be all that remains.
//
// It only touches names that follow this package's conventions. If data does not exist and was not
// returned (doubtful or the rename failed), the error wraps ErrDataMissing: the server must
// not be started. Without data or pre-restores (new server) there is no error.
func RecoverInterrupted(backupsDir, dataDir, slug string) (Recovery, error) {
	var rec Recovery
	rec.removeFiles(backupsDir, func(name string) bool { return backupLeftover(backupsDir, slug, name) })

	parent := filepath.Dir(dataDir)
	ents, err := os.ReadDir(parent)
	if errors.Is(err, fs.ErrNotExist) {
		return rec, nil // server without a directory yet
	}
	if err != nil {
		rec.warn("leer " + parent + ": " + err.Error())
		return rec, nil
	}
	var pres, staging []string
	base := filepath.Base(dataDir)
	for _, e := range ents {
		name := e.Name()
		switch {
		case e.Type().IsRegular() && preRestoreMetaPartial(dataDir, name):
			rec.remove(filepath.Join(parent, name), false)
		case e.IsDir() && ValidPreRestoreName(dataDir, name):
			pres = append(pres, name)
		case strings.HasPrefix(name, base+restoringInfix) && tsRe.MatchString(strings.TrimPrefix(name, base+restoringInfix)):
			staging = append(staging, name)
		}
	}

	cur, err := currentData(dataDir)
	if err != nil {
		rec.warn(err.Error()) // data exists and is not a directory: nothing else is touched
		return rec, nil
	}
	if cur == nil {
		if len(pres) == 0 {
			return rec, nil // new server: the reconciliation creates data
		}
		sort.Strings(pres) // the timestamp sorts by date
		newest := pres[len(pres)-1]
		var unfinished []string // without .json: swaps that did not finish
		for _, name := range pres {
			if _, err := os.Lstat(filepath.Join(parent, name+MetaExt)); errors.Is(err, fs.ErrNotExist) {
				unfinished = append(unfinished, name)
			}
		}
		if len(unfinished) != 1 || unfinished[0] != newest {
			// Completed restores (data deleted afterwards) or a doubtful choice (several without a
			// .json, or the one without it is not the most recent: a clock that went backwards). An
			// empty world is not started nor is a blind choice made: the administrator decides (m9).
			return rec, fmt.Errorf("%w: %s is missing and next to it there is data from before a restore (%s); it is not known which to return, move the good ones to %s",
				ErrDataMissing, dataDir, strings.Join(pres, ", "), filepath.Base(dataDir))
		}
		prePath := filepath.Join(parent, newest)
		if err := rename(prePath, dataDir); err != nil {
			return rec, fmt.Errorf("%w: %s is missing after an interrupted restore and the original data could not be returned from %s: %v",
				ErrDataMissing, dataDir, prePath, err)
		}
		_ = syncDir(parent)
		rec.RolledBack = newest
	}
	for _, name := range staging {
		rec.remove(filepath.Join(parent, name), true)
	}
	return rec, nil
}

// backupLeftover reports whether name, in backupsDir, is a leftover of one of slug's backups: a
// .partial of a backup or of its .json, or a .json without its .tar.zst.
func backupLeftover(backupsDir, slug, name string) bool {
	if base, ok := strings.CutSuffix(name, partialExt); ok {
		archive, _ := strings.CutSuffix(base, MetaExt)
		return ValidName(slug, archive)
	}
	if archive, ok := strings.CutSuffix(name, MetaExt); ok && ValidName(slug, archive) {
		_, err := os.Lstat(filepath.Join(backupsDir, archive))
		return errors.Is(err, fs.ErrNotExist)
	}
	return false
}

// preRestoreMetaPartial reports whether name is the temporary of a dataDir pre-restore's .json.
func preRestoreMetaPartial(dataDir, name string) bool {
	pre, ok := strings.CutSuffix(name, MetaExt+partialExt)
	return ok && ValidPreRestoreName(dataDir, pre)
}

// removeFiles deletes the regular files in dir that satisfy match.
func (r *Recovery) removeFiles(dir string, match func(name string) bool) {
	ents, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		r.warn("leer " + dir + ": " + err.Error())
		return
	}
	for _, e := range ents {
		if e.Type().IsRegular() && match(e.Name()) {
			r.remove(filepath.Join(dir, e.Name()), false)
		}
	}
}

func (r *Recovery) remove(p string, recursive bool) {
	var err error
	if recursive {
		err = removeAll(p)
	} else {
		err = os.Remove(p)
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		r.warn("could not delete " + p + ": " + err.Error())
		return
	}
	r.Removed = append(r.Removed, p)
}

func (r *Recovery) warn(msg string) { r.Warnings = append(r.Warnings, msg) }
