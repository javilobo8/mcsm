package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func makeBackup(t *testing.T, dataDir, backupsDir string) Meta {
	t.Helper()
	m, err := Create(context.Background(), baseReq(dataDir, backupsDir))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func restoreReq(dataDir, backupsDir, name string, at time.Time) RestoreRequest {
	return RestoreRequest{ServerID: "srv-1", Slug: "survival", Filename: name, DataDir: dataDir, BackupsDir: backupsDir, Now: func() time.Time { return at }}
}

// leftovers lists the .restoring-* temporary directories that remain.
func leftovers(t *testing.T, dataDir string) []string {
	t.Helper()
	ents, _ := os.ReadDir(filepath.Dir(dataDir))
	var out []string
	for _, e := range ents {
		if strings.Contains(e.Name(), restoringInfix) {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestRestoreSwapsAndKeepsPrevious(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	mustWrite(t, filepath.Join(dataDir, "new.txt"), "x", 0o644)
	pre, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" || exists(filepath.Join(dataDir, "new.txt")) {
		t.Fatal("the data is not the backup's")
	}
	if pre.Filename != "data.pre-restore-20261012T050000.000Z" || pre.Trigger != TriggerPreRestore || pre.SizeBytes == 0 {
		t.Fatalf("pre = %+v", pre)
	}
	prePath := filepath.Join(filepath.Dir(dataDir), pre.Filename)
	if mustRead(t, filepath.Join(prePath, "world", "level.dat")) != "LEVEL-2" || !exists(filepath.Join(prePath, "new.txt")) {
		t.Fatal("the previous data must be kept intact")
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 1 || list[0].SizeBytes != pre.SizeBytes {
		t.Fatalf("ListPreRestore = %+v", list)
	}
	if l := leftovers(t, dataDir); len(l) != 0 {
		t.Fatalf("leftovers: %v", l)
	}
}

func TestRestoreTwiceKeepsBothPrevious(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	for i, at := range []time.Time{t0.Add(time.Hour), t0.Add(2 * time.Hour)} {
		if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); err != nil {
			t.Fatalf("restore %d: %v", i, err)
		}
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 2 {
		t.Fatalf("a previous pre-restore is never deleted: %+v", list)
	}
}

func TestRestoreCorruptBackupLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	p := filepath.Join(backupsDir, m.Filename)
	data := []byte(mustRead(t, p))
	data[len(data)/2] ^= 0xff
	if err := os.WriteFile(p, data, 0o640); err != nil {
		t.Fatal(err)
	}
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "corrupted") {
		t.Fatalf("err = %v", err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" {
		t.Fatal("the current data must not be touched")
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 0 || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("no pre-restore directories or temporaries must remain")
	}
}

func TestRestoreUnreadableArchiveLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	if err := os.Remove(filepath.Join(backupsDir, m.Filename+MetaExt)); err != nil { // without a sha256 to verify
		t.Fatal(err)
	}
	p := filepath.Join(backupsDir, m.Filename)
	data := mustRead(t, p)
	if err := os.WriteFile(p, []byte(data[:len(data)/2]), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err == nil {
		t.Fatal("a truncated backup must fail")
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("the current data must not be touched nor temporaries remain")
	}
}

func TestRestoreRejectsBadNames(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	for _, name := range []string{"../../etc/passwd", "other-20261012T040000.000Z-3.tar.zst", "data.pre-restore-20261012T040000.000Z"} {
		if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, name, t0)); err == nil {
			t.Errorf("%q must be rejected", name)
		}
	}
}

func TestRestoreWithoutPreviousData(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	if err := os.RemoveAll(dataDir); err != nil {
		t.Fatal(err)
	}
	pre, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err != nil || pre.Filename != "" {
		t.Fatalf("pre = %+v, %v", pre, err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" {
		t.Fatal("data not restored")
	}
}

// ── Beyond the brief: free space, atomic swap on failures, cancellation ──

// TestMain leaves the flush to disk replaced by default: real syncfs only in
// TestRestoreWithRealSyncfs. The injection points are package variables, so
// this package's tests do not use t.Parallel.
func TestMain(m *testing.M) {
	syncFS = func(string) error { return nil }
	os.Exit(m.Run())
}

func stubFreeSpace(t *testing.T, fn func(dir string) (uint64, error)) {
	t.Helper()
	old := freeSpace
	freeSpace = fn
	t.Cleanup(func() { freeSpace = old })
}

func stubRename(t *testing.T, fn func(oldpath, newpath string) error) {
	t.Helper()
	old := rename
	rename = fn
	t.Cleanup(func() { rename = old })
}

func stubSync(t *testing.T, fn func(dir string) error) {
	t.Helper()
	old := syncFS
	syncFS = fn
	t.Cleanup(func() { syncFS = old })
}

// assertUntouched checks that a failed restore changed nothing: data with LEVEL-2,
// no pre-restore and no temporaries.
func assertUntouched(t *testing.T, dataDir string) {
	t.Helper()
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" {
		t.Fatal("the current data must not be touched")
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 0 {
		t.Fatalf("no pre-restore must remain: %+v", list)
	}
	if l := leftovers(t, dataDir); len(l) != 0 {
		t.Fatalf("leftovers: %v", l)
	}
}

// changedWorld makes a backup and then changes level.dat to LEVEL-2 (the "current" data).
func changedWorld(t *testing.T) (dataDir, backupsDir string, m Meta) {
	t.Helper()
	dataDir, backupsDir = newWorld(t)
	m = makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	return dataDir, backupsDir, m
}

func TestRequiredSpaceMargin(t *testing.T) {
	const gib = int64(1) << 30
	for _, tc := range []struct {
		need int64
		want uint64
	}{
		{0, 256 << 20},
		{17, 17 + 256<<20},
		{gib, uint64(gib) + 256<<20},           // 5 % < 256 MiB
		{10 * gib, uint64(10*gib) + 512<<20},   // 5 % = 512 MiB
		{100 * gib, uint64(100*gib) + 5*1<<30}, // 5 % = 5 GiB
	} {
		if got := requiredSpace(tc.need); got != tc.want {
			t.Errorf("requiredSpace(%d) = %d, want %d", tc.need, got, tc.want)
		}
	}
}

func TestFreeBytesUsesFragmentSize(t *testing.T) {
	if got := freeBytes(10, 4096, 1<<20); got != 40960 {
		t.Fatalf("with f_frsize = %d; f_bavail is in units of f_frsize", got)
	}
	if got := freeBytes(10, 0, 4096); got != 40960 {
		t.Fatalf("without f_frsize = %d; f_bsize is used", got)
	}
	if free, err := statfsFree(t.TempDir()); err != nil || free == 0 {
		t.Fatalf("statfs real = %d, %v", free, err)
	}
}

func TestRestoreNotEnoughSpaceLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	var asked string
	stubFreeSpace(t, func(dir string) (uint64, error) { asked = dir; return requiredSpace(m.DataBytes) - 1, nil })
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "space") || !strings.Contains(err.Error(), "margin") {
		t.Fatalf("err = %v; it must explain the missing space and the margin", err)
	}
	if asked != filepath.Dir(dataDir) {
		t.Fatalf("space queried at %q; it must be where it is extracted (%q)", asked, filepath.Dir(dataDir))
	}
	assertUntouched(t, dataDir)
}

func TestRestoreSpaceCheckUsesUncompressedSize(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	stubFreeSpace(t, func(string) (uint64, error) { return requiredSpace(m.DataBytes), nil })
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err != nil {
		t.Fatalf("with just enough space it must restore: %v", err)
	}
}

func TestRestoreSpaceCheckWithoutMetaUsesArchiveSize(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	if err := os.Remove(filepath.Join(backupsDir, m.Filename+MetaExt)); err != nil {
		t.Fatal(err)
	}
	stubFreeSpace(t, func(string) (uint64, error) { return requiredSpace(m.SizeBytes) - 1, nil })
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err == nil || !strings.Contains(err.Error(), "space") {
		t.Fatalf("without a .json the minimum is the backup's size: err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreSpaceUnknownStillRestores(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	stubFreeSpace(t, func(string) (uint64, error) { return 0, errors.New("statfs: not supported") })
	var logs []string
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Restore(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "free space") {
		t.Fatalf("it must warn that it could not check the space: %v", logs)
	}
}

func TestRestoreUnreadableMetaIsNotMissingSHA(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	if err := os.WriteFile(filepath.Join(backupsDir, m.Filename+MetaExt), []byte("{broken"), 0o640); err != nil {
		t.Fatal(err)
	}
	var logs []string
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Restore(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(logs, "\n")
	if !strings.Contains(all, "unreadable") || strings.Contains(all, "has no sha256") {
		t.Fatalf("an unreadable .json is not a backup without a sha256: %v", logs)
	}
}

func TestRestoreSwapFailureRestoresOriginalData(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	stubRename(t, func(oldpath, newpath string) error {
		if newpath == dataDir && strings.Contains(oldpath, restoringInfix) {
			return errors.New("simulated failure")
		}
		return os.Rename(oldpath, newpath)
	})
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "activate the backup") || errors.Is(err, ErrDataMissing) {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreRollbackFailureKeepsOriginalInPreRestore(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	stubRename(t, func(oldpath, newpath string) error {
		if newpath == dataDir {
			return errors.New("simulated failure")
		}
		return os.Rename(oldpath, newpath)
	})
	at := t0.Add(time.Hour)
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at))
	preName := PreRestoreName(dataDir, at)
	if err == nil || !strings.Contains(err.Error(), preName) {
		t.Fatalf("the error must say where the original data was left: %v", err)
	}
	if !errors.Is(err, ErrDataMissing) || strings.Contains(err.Error(), "\n") {
		t.Fatalf("err = %q; it must wrap ErrDataMissing (on a single line)", err)
	}
	if mustRead(t, filepath.Join(filepath.Dir(dataDir), preName, "world", "level.dat")) != "LEVEL-2" {
		t.Fatal("the original data must remain intact in the pre-restore")
	}
}

func TestRestoreRefusesToReplaceExistingPreRestore(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	at := t0.Add(time.Hour)
	// rename(2) silently replaces an empty directory: it must not even be attempted.
	existing := filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, at))
	if err := os.Mkdir(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); err == nil {
		t.Fatal("it must fail if the pre-restore already exists")
	}
	if !exists(existing) {
		t.Fatal("an existing pre-restore is never touched")
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("the current data must not be touched nor temporaries remain")
	}
}

func TestRestoreRejectsSymlinkedData(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	target := filepath.Join(filepath.Dir(dataDir), "real-data")
	if err := os.Rename(dataDir, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err == nil {
		t.Fatal("data as a symbolic link must be rejected (renaming the link would not set the data aside)")
	}
	if fi, err := os.Lstat(dataDir); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link must not be touched")
	}
	if mustRead(t, filepath.Join(target, "world", "level.dat")) != "LEVEL-2" || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("the data must not be touched nor temporaries remain")
	}
}

func TestRestoreRejectsNonRegularBackup(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	asDir := Filename("survival", t0.Add(time.Minute), 3)
	if err := os.Mkdir(filepath.Join(backupsDir, asDir), 0o755); err != nil {
		t.Fatal(err)
	}
	asLink := Filename("survival", t0.Add(2*time.Minute), 3)
	if err := os.Symlink(filepath.Join(backupsDir, m.Filename), filepath.Join(backupsDir, asLink)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{asDir, asLink} {
		_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, name, t0.Add(time.Hour)))
		if err == nil || !strings.Contains(err.Error(), "is not a regular file") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	assertUntouched(t, dataDir)
}

func TestRestoreLogsStagingCleanupFailure(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	p := filepath.Join(backupsDir, m.Filename)
	if err := os.Remove(p + MetaExt); err != nil {
		t.Fatal(err)
	}
	data := mustRead(t, p)
	if err := os.WriteFile(p, []byte(data[:len(data)/2]), 0o640); err != nil { // the extraction will fail
		t.Fatal(err)
	}
	old := removeAll
	removeAll = func(p string) error { _ = os.RemoveAll(p); return errors.New("simulated failure") }
	t.Cleanup(func() { removeAll = old })
	var logs []string
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Restore(context.Background(), req); err == nil {
		t.Fatal("a truncated backup must fail")
	}
	if all := strings.Join(logs, "\n"); !strings.Contains(all, restoringInfix) || !strings.Contains(all, "simulated failure") {
		t.Fatalf("it must be logged that the temporary could not be deleted: %v", logs)
	}
}

func TestRestoreCancelledLeavesDataUntouched(t *testing.T) {
	for _, at := range []uint32{10, 90} { // when starting to extract and when finishing reading the backup
		t.Run(fmt.Sprint(at), func(t *testing.T) {
			dataDir, backupsDir, m := changedWorld(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
			req.Progress = func(p uint32, _ string) {
				if p >= at {
					cancel()
				}
			}
			_, err := Restore(ctx, req)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("err = %v", err)
			}
			if strings.Contains(err.Error(), "corrupted") {
				t.Fatalf("a cancellation is not a corrupted backup: %v", err)
			}
			assertUntouched(t, dataDir)
		})
	}
}

// A cancellation with the backup already extracted (e.g. the agent is shutting down) does not
// get to swap anything either.
func TestRestoreCancelledAfterExtractionLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var synced string
	stubSync(t, func(dir string) error { synced = dir; cancel(); return nil }) // flushed to disk right after extracting
	if _, err := Restore(ctx, restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(synced, restoringInfix) {
		t.Fatalf("syncfs on %q; it must be the extracted temporary", synced)
	}
	assertUntouched(t, dataDir)
}

// A syncfs that does not return (hung FS) does not block the restore forever: on
// cancel it stops waiting and nothing is swapped.
func TestRestoreHungSyncIsAbandonedOnCancel(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	finished := make(chan struct{})
	stubSync(t, func(string) error {
		defer close(finished)
		cancel()
		<-release // hung until the test releases it
		return nil
	})
	if _, err := Restore(ctx, restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
	close(release)
	<-finished // the abandoned goroutine ends as soon as the sync returns
}

func TestRestoreSyncFailureDoesNotSwap(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	stubSync(t, func(string) error { return errors.New("EIO simulado") })
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "EIO simulado") {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreWithRealSyncfs(t *testing.T) {
	stubSync(t, syncFilesystem)
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" {
		t.Fatal("data not restored")
	}
}

func TestRestoreProgress(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	var pcts []uint32
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Progress = func(p uint32, _ string) { pcts = append(pcts, p) }
	if _, err := Restore(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if len(pcts) < 3 || pcts[0] != 2 || pcts[1] != 10 || pcts[len(pcts)-1] != 92 {
		t.Fatalf("progress = %v; expected 2 (verify), 10–90 (extract), 92 (set aside)", pcts)
	}
	for i := 1; i < len(pcts); i++ {
		if pcts[i] < pcts[i-1] || pcts[i] > 92 {
			t.Fatalf("progress out of order or range: %v", pcts)
		}
	}
}
