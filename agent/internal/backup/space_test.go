package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Without space for the backup, Create fails BEFORE save-off (the server does not even notice) and
// says how much is missing. First backup: the estimate is what the uncompressed data takes.
func TestCreateRefusesWithoutSpaceBeforeSaveOff(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	data := int64(len("motd=hola\n") + len("LEVEL-1")) // logs is excluded
	need := requiredSpace(data)
	stubFreeSpace(t, func(string) (uint64, error) { return need - 1, nil })
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "1 B short") {
		t.Fatalf("err = %v", err)
	}
	if len(rc.cmds) != 0 {
		t.Fatalf("without space the server is not touched: %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)

	stubFreeSpace(t, func(string) (uint64, error) { return need, nil })
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatalf("with just enough space: %v", err)
	}
}

// With previous backups, the estimate is the last backup ×1.2 (not the uncompressed data).
func TestCreateEstimatesFromLastBackup(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	last := makeBackup(t, dataDir, backupsDir)
	need := requiredSpace(last.SizeBytes + last.SizeBytes/5)
	req := baseReq(dataDir, backupsDir)
	req.Now = func() time.Time { return t0.Add(time.Minute) }
	stubFreeSpace(t, func(string) (uint64, error) { return need - 1, nil })
	if _, err := Create(context.Background(), req); !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "the last backup") {
		t.Fatalf("err = %v", err)
	}
	stubFreeSpace(t, func(string) (uint64, error) { return need, nil })
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatal(err)
	}
}

// If during the tar the free space drops below the margin (another backup or another server fills the
// disk), the backup is cancelled leaving no .partial and save-on goes out anyway.
func TestCreateAbortsWhenSpaceRunsOut(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	var mu sync.Mutex
	calls := 0
	stubFreeSpace(t, func(string) (uint64, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			return 1 << 40, nil // the prior check passes
		}
		return 0, nil
	})
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "during the backup") {
		t.Fatalf("err = %v", err)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("RCON = %s", got)
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateUnknownFreeSpaceStillCopies(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	stubFreeSpace(t, func(string) (uint64, error) { return 0, errors.New("statfs unavailable") })
	req := baseReq(dataDir, backupsDir)
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "could not check the free space") {
		t.Fatalf("log = %v", logs)
	}
}

// S2: the extraction is bounded to the free space minus the margin, not just to 256 GiB. A highly compressible
// backup without a .json (need = compressed size) would pass checkSpace and fill the disk.
func TestRestoreExtractionLimitedByFreeSpace(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	mustWrite(t, filepath.Join(dataDir, "world", "region.mca"), strings.Repeat("\x00", 1<<20), 0o644)
	m := makeBackup(t, dataDir, backupsDir)
	if err := os.Remove(filepath.Join(backupsDir, m.Filename+MetaExt)); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	compressed := m.SizeBytes
	free := requiredSpace(compressed) + 10<<10 // passes checkSpace; ~10 KiB more than the compressed backup fits
	stubFreeSpace(t, func(string) (uint64, error) { return free, nil })
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if !errors.Is(err, ErrNoSpace) {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)

	stubFreeSpace(t, func(string) (uint64, error) { return 1 << 40, nil })
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(2*time.Hour))); err != nil {
		t.Fatalf("with space: %v", err)
	}
}
