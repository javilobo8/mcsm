package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const rxName = "mig-20261012T040000.000Z-7.tar.zst"

func rxBody() ([]byte, string) {
	b := bytes.Repeat([]byte("world-"), 20000)
	sum := sha256.Sum256(b)
	return b, hex.EncodeToString(sum[:])
}

func rxReq(dir string, body []byte, sum string) ReceiveRequest {
	return ReceiveRequest{
		BackupsDir: dir, ServerID: "s1", Slug: "mig", Filename: rxName,
		Body: bytes.NewReader(body), Size: int64(len(body)), SHA256: sum, ExtractBytes: 123456,
		Now:       func() time.Time { return time.Date(2026, 10, 12, 5, 0, 0, 0, time.UTC) },
		FreeSpace: func(string) (uint64, error) { return 1 << 40, nil },
	}
}

// emptyDir fails if anything is left in dir (neither the backup, nor the .json, nor the .partial).
func emptyDir(t *testing.T, dir string) {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if len(ents) != 0 {
		t.Fatalf("leftovers remain: %v", ents)
	}
}

func TestReceiveWritesArchiveAndMeta(t *testing.T) {
	dir := t.TempDir()
	body, sum := rxBody()
	var last int64
	req := rxReq(dir, body, sum)
	req.Progress = func(done, total int64) { last = done }
	m, err := Receive(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, rxName))
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("different backup written: %v", err)
	}
	meta, err := ReadMeta(dir, rxName)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	if meta.SHA256 != sum || meta.Trigger != TriggerPreMigration || meta.SpecVersion != 7 || meta.DataBytes != 123456 ||
		meta.ServerID != "s1" || meta.SizeBytes != int64(len(body)) || !meta.StartedAt.Equal(want) || m.Filename != rxName {
		t.Fatalf("meta = %+v", meta)
	}
	if _, err := os.Stat(filepath.Join(dir, rxName+partialExt)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the .partial must disappear")
	}
	if last != int64(len(body)) {
		t.Fatalf("final progress = %d", last)
	}
}

func TestReceiveRejectsAndLeavesNothing(t *testing.T) {
	body, sum := rxBody()
	cases := []struct {
		name string
		mod  func(r *ReceiveRequest)
		want string
	}{
		{"different sha256", func(r *ReceiveRequest) { r.SHA256 = strings.Repeat("0", 64) }, "corrupted"},
		{"too few bytes", func(r *ReceiveRequest) { r.Size = int64(len(body)) + 10 }, "incomplete"},
		{"too many bytes", func(r *ReceiveRequest) { r.Size = int64(len(body)) - 10 }, "extra bytes"},
		{"another slug's name", func(r *ReceiveRequest) { r.Filename = "other-20261012T040000.000Z-7.tar.zst" }, "invalid"},
		{"malformed sha256", func(r *ReceiveRequest) { r.SHA256 = "xyz" }, "invalid"},
		{"cancelled", func(r *ReceiveRequest) {}, "cancelled"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "backups")
			req := rxReq(dir, body, sum)
			c.mod(&req)
			ctx := context.Background()
			if c.name == "cancelled" {
				cctx, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cctx
			}
			if _, err := Receive(ctx, req); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, wanted %q", err, c.want)
			}
			emptyDir(t, dir)
		})
	}
}

func TestReceiveStopsWhenSpaceRunsOut(t *testing.T) {
	dir := t.TempDir()
	body, sum := rxBody()
	req := rxReq(dir, body, sum)
	req.FreeSpace = func(string) (uint64, error) { return 10 << 20, nil } // less than the 256 MiB margin
	if _, err := Receive(context.Background(), req); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("err = %v", err)
	}
	emptyDir(t, dir)
}

// zeros is a reader of zeros (without reserving the whole body in memory).
type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// Space is also watched while the backup arrives, not just at the start: if another server fills
// the disk midway, the receive is cut off and leaves nothing.
func TestReceiveStopsWhenSpaceDropsMidway(t *testing.T) {
	dir := t.TempDir()
	size := int64(spaceCheckEvery + 1<<20)
	req := rxReq(dir, nil, strings.Repeat("0", 64))
	req.Body, req.Size = io.LimitReader(zeros{}, size), size
	calls := 0
	req.FreeSpace = func(string) (uint64, error) {
		calls++
		if calls == 1 {
			return 1 << 40, nil
		}
		return 10 << 20, nil
	}
	if _, err := Receive(context.Background(), req); !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "dropped") {
		t.Fatalf("err = %v", err)
	}
	if calls != 2 {
		t.Fatalf("space checks = %d", calls)
	}
	emptyDir(t, dir)
}

func TestReceiveNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, rxName), []byte("previous"), 0o640); err != nil {
		t.Fatal(err)
	}
	body, sum := rxBody()
	if _, err := Receive(context.Background(), rxReq(dir, body, sum)); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, rxName)); string(b) != "previous" {
		t.Fatal("an existing backup is not overwritten")
	}
}

func TestCheckSpace(t *testing.T) {
	small := func(string) (uint64, error) { return 100 << 20, nil }
	if err := CheckSpace("/x", 1, "receive", small); !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "receive") {
		t.Fatalf("err = %v", err)
	}
	big := func(string) (uint64, error) { return 1 << 40, nil }
	if err := CheckSpace("/x", 1<<30, "receive", big); err != nil {
		t.Fatal(err)
	}
	broken := func(string) (uint64, error) { return 0, errors.New("statfs") }
	if err := CheckSpace("/x", 1<<30, "receive", broken); err != nil {
		t.Fatalf("if it cannot be queried it does not block: %v", err)
	}
}

func TestMigratedName(t *testing.T) {
	got := MigratedName("/srv/minecraft/uno", time.Date(2026, 10, 12, 4, 0, 0, 0, time.FixedZone("x", 3600)))
	if got != "uno.migrated-20261012T030000.000Z" {
		t.Fatalf("got %q", got)
	}
}
