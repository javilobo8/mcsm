package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// crashedSwap leaves the disk as after a crash between Restore's two renames: without data,
// with the original data in the pre-restore (still without a .json) and the extracted backup in the
// temporary, both with the same timestamp.
func crashedSwap(t *testing.T, at time.Time) (dataDir, backupsDir, pre, staging string) {
	t.Helper()
	root := t.TempDir()
	dataDir = filepath.Join(root, "survival", "data")
	backupsDir = filepath.Join(root, "survival", "backups")
	pre = filepath.Join(root, "survival", PreRestoreName(dataDir, at))
	staging = dataDir + restoringInfix + at.UTC().Format(tsLayout)
	mustWrite(t, filepath.Join(pre, "world", "level.dat"), "ORIGINAL", 0o644)
	mustWrite(t, filepath.Join(staging, "world", "level.dat"), "BACKUP", 0o644)
	return dataDir, backupsDir, pre, staging
}

func TestRecoverRemovesPartialsAndOrphanMeta(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	cut := Filename("survival", t0.Add(time.Minute), 3)      // backup cut off midway
	orphan := Filename("survival", t0.Add(2*time.Minute), 3) // .json without its .tar.zst
	gone := []string{cut + partialExt, cut + MetaExt + partialExt, orphan + MetaExt}
	foreign := []string{"notes.txt", "other-20261012T040000.000Z-1.tar.zst.partial", "survival-bad.tar.zst.partial"}
	for _, n := range append(append([]string{}, gone...), foreign...) {
		mustWrite(t, filepath.Join(backupsDir, n), "x", 0o640)
	}
	preMetaTmp := filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, t0)+MetaExt+partialExt)
	mustWrite(t, preMetaTmp, "{", 0o640)

	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range gone {
		if exists(filepath.Join(backupsDir, n)) {
			t.Errorf("%s must be deleted", n)
		}
		if !slices.Contains(rec.Removed, filepath.Join(backupsDir, n)) {
			t.Errorf("Removed does not include %s: %v", n, rec.Removed)
		}
	}
	if exists(preMetaTmp) {
		t.Error("a pre-restore's .json.partial must be deleted")
	}
	for _, n := range append([]string{m.Filename, m.Filename + MetaExt}, foreign...) {
		if !exists(filepath.Join(backupsDir, n)) {
			t.Errorf("%s is not a leftover of this server: it is not touched", n)
		}
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" || rec.RolledBack != "" {
		t.Fatalf("the data is not touched: %+v", rec)
	}
}

// Crash between the two renames: it goes back to the original data (the job ends up FAILED
// "interrupted", so the restore is not completed) and the temporary is left over.
func TestRecoverRollsBackInterruptedSwap(t *testing.T) {
	dataDir, backupsDir, pre, staging := crashedSwap(t, t0)
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil {
		t.Fatal(err)
	}
	if rec.RolledBack != filepath.Base(pre) {
		t.Fatalf("RolledBack = %q", rec.RolledBack)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "ORIGINAL" {
		t.Fatal("data must have the original data again")
	}
	if exists(pre) || exists(staging) {
		t.Fatalf("no pre-restore or temporary must remain: pre=%v staging=%v", exists(pre), exists(staging))
	}
	if !slices.Contains(rec.Removed, staging) {
		t.Fatalf("Removed = %v", rec.Removed)
	}
}

// After an ErrDataMissing (both renames fail and Restore already deleted the temporary), the
// next startup returns the original data to its place.
func TestRecoverRollsBackAfterDataMissing(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	at := t0.Add(time.Hour)
	stubRename(t, func(oldpath, newpath string) error {
		if newpath == dataDir {
			return errors.New("simulated failure")
		}
		return os.Rename(oldpath, newpath)
	})
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); !errors.Is(err, ErrDataMissing) {
		t.Fatalf("setup: %v", err)
	}
	rename = os.Rename
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil {
		t.Fatal(err)
	}
	if rec.RolledBack != PreRestoreName(dataDir, at) || mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" {
		t.Fatalf("rec = %+v", rec)
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 0 {
		t.Fatalf("the pre-restore becomes data again: %+v", list)
	}
}

// A completed restore leaves the pre-restore's .json. If data is missing afterwards it is not a
// half-done swap, but an empty world is not started either: it does not choose what to return and
// the error (ErrDataMissing) blocks the server until someone decides (m9).
func TestRecoverBlocksWhenOnlyCompletedRestoresRemain(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	at := t0.Add(time.Hour)
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dataDir); err != nil {
		t.Fatal(err)
	}
	pre := PreRestoreName(dataDir, at)
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if !errors.Is(err, ErrDataMissing) || !strings.Contains(err.Error(), pre) || rec.RolledBack != "" {
		t.Fatalf("rec = %+v, err = %v", rec, err)
	}
	if exists(dataDir) || !exists(filepath.Join(filepath.Dir(dataDir), pre)) {
		t.Fatal("neither data nor the pre-restore must change")
	}
}

// Without data and without pre-restores (new server, or deleted by hand with no trace of restores):
// nothing to decide, it is not an error.
func TestRecoverWithoutDataNorPreRestoreIsFine(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "survival", "data")
	if err := os.MkdirAll(filepath.Join(root, "survival", "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	if rec, err := RecoverInterrupted(filepath.Join(root, "survival", "backups"), dataDir, "survival"); err != nil || rec.RolledBack != "" {
		t.Fatalf("rec = %+v, err = %v", rec, err)
	}
}

func TestRecoverRemovesStagingOnlyWithData(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	staging := dataDir + restoringInfix + t0.UTC().Format(tsLayout)
	mustWrite(t, filepath.Join(staging, "world", "level.dat"), "HALF DONE", 0o644)
	if _, err := RecoverInterrupted(backupsDir, dataDir, "survival"); err != nil {
		t.Fatal(err)
	}
	if exists(staging) {
		t.Fatal("with data in place the temporary is left over")
	}

	// First restore of a server without data, cut off before activating the backup: without
	// data or pre-restore, the temporary is not touched.
	root := t.TempDir()
	dataDir = filepath.Join(root, "survival", "data")
	staging = dataDir + restoringInfix + t0.UTC().Format(tsLayout)
	mustWrite(t, filepath.Join(staging, "world", "level.dat"), "BACKUP", 0o644)
	rec, err := RecoverInterrupted(filepath.Join(root, "survival", "backups"), dataDir, "survival")
	if err != nil || rec.RolledBack != "" || !exists(staging) || exists(dataDir) {
		t.Fatalf("rec = %+v, err = %v, staging=%v data=%v", rec, err, exists(staging), exists(dataDir))
	}
}

func TestRecoverRollbackFailureIsDataMissing(t *testing.T) {
	dataDir, backupsDir, pre, staging := crashedSwap(t, t0)
	stubRename(t, func(oldpath, newpath string) error { return errors.New("simulated failure") })
	_, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if !errors.Is(err, ErrDataMissing) || !strings.Contains(err.Error(), pre) || strings.Contains(err.Error(), "\n") {
		t.Fatalf("err = %q; it must wrap ErrDataMissing and say where the data is", err)
	}
	if mustRead(t, filepath.Join(pre, "world", "level.dat")) != "ORIGINAL" || !exists(staging) || exists(dataDir) {
		t.Fatal("without data nothing is deleted")
	}
}

// With several pre-restores without a .json (an old one whose .json could not be written) the choice
// is doubtful: none is returned and it is blocked (m9).
func TestRecoverAmbiguousPreRestoresBlock(t *testing.T) {
	dataDir, backupsDir, pre, _ := crashedSwap(t, t0.Add(time.Hour))
	old := filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, t0))
	mustWrite(t, filepath.Join(old, "world", "level.dat"), "OLD", 0o644)
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if !errors.Is(err, ErrDataMissing) || rec.RolledBack != "" || !strings.Contains(err.Error(), filepath.Base(old)) || !strings.Contains(err.Error(), filepath.Base(pre)) {
		t.Fatalf("rec = %+v, err = %v", rec, err)
	}
	if exists(dataDir) || !exists(pre) || !exists(old) {
		t.Fatal("nothing is moved")
	}
}

// Clock that goes backwards between two restores: the pre-restore without a .json (the one from the
// half-done swap) is not the most recent by name. Doubtful: it is blocked (m9).
func TestRecoverPreRestoreWithoutMetaNotNewestBlocks(t *testing.T) {
	dataDir, backupsDir, pre, _ := crashedSwap(t, t0)
	newer := filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, t0.Add(time.Hour)))
	mustWrite(t, filepath.Join(newer, "world", "level.dat"), "OTHER", 0o644)
	mustWrite(t, newer+MetaExt, "{}", 0o640)
	_, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if !errors.Is(err, ErrDataMissing) || exists(dataDir) || !exists(pre) {
		t.Fatalf("err = %v", err)
	}
}
