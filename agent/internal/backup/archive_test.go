package backup

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// mustWrite creates p (and its directories) with body and mode permissions.
func mustWrite(t *testing.T, p, body string, mode fs.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil { // without umask
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

type tarEntry struct {
	hdr  tar.Header
	body string
}

// makeArchive builds a tar.zst by hand (to test malicious entries).
func makeArchive(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	for _, e := range entries {
		h := e.hdr
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(e.body))
		}
		if h.Mode == 0 && h.Typeflag != tar.TypeXGlobalHeader { // the global one only supports PAXRecords
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if e.body != "" {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// assertEmpty checks that dir exists and contains nothing (a failed extraction leaves no leftovers).
func assertEmpty(t *testing.T, dir string) {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(des) != 0 {
		names := make([]string, 0, len(des))
		for _, d := range des {
			names = append(names, d.Name())
		}
		t.Fatalf("%s should have been left empty; it contains %v", dir, names)
	}
}

func TestExcluder(t *testing.T) {
	e, err := NewExcluder([]string{"logs", "*.tmp", "world/session.lock", "cache/"})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]bool{
		"logs": true, "plugins/foo/logs": true, "a/b.tmp": true, "x.tmp": true,
		"world/session.lock": true, "other/session.lock": false, "cache": true,
		"cache2": false, "world/level.dat": false, "logs.txt": false,
	}
	for rel, want := range cases {
		if got := e.Excluded(rel); got != want {
			t.Errorf("Excluded(%q) = %v, want %v", rel, got, want)
		}
	}
	if _, err := NewExcluder([]string{"[abc"}); err == nil {
		t.Fatal("a malformed pattern must be rejected")
	}
	if (*Excluder)(nil).Excluded("x") {
		t.Fatal("without exclusions nothing is excluded")
	}
	// m-l: a nil Excluder still excludes upload temporaries (WriteArchive(…, nil, …)).
	if !(*Excluder)(nil).Excluded("mods/.mcsm-tmp-0123456789abcdef") {
		t.Fatal("a nil Excluder must exclude the temporaries of atomic writes")
	}
}

// The temporaries of atomic file writes (Plan 5) never go into a backup,
// without the user having to exclude them: a backup during an upload would include the half-written
// temporary (up to 4 GiB) and, when restored, it would be hidden and impossible to delete from the web.
func TestExcluderAlwaysSkipsUploadTemps(t *testing.T) {
	for _, patterns := range [][]string{nil, {"logs"}} {
		e, err := NewExcluder(patterns)
		if err != nil {
			t.Fatal(err)
		}
		for _, rel := range []string{".mcsm-tmp-0123456789abcdef", "plugins/foo/.mcsm-tmp-0123456789abcdef"} {
			if !e.Excluded(rel) {
				t.Errorf("%v: Excluded(%q) = false", patterns, rel)
			}
		}
		// A user file that merely starts like a temporary does go in (m-k).
		if e.Excluded("world/level.dat") || e.Excluded("mcsm-tmp-notes.txt") || e.Excluded(".mcsm-tmp-x") || e.Excluded("plugins/.mcsm-tmp-notes.txt") {
			t.Errorf("%v: excludes too much", patterns)
		}
	}
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "server.properties"), "motd=hola\n", 0o644)
	mustWrite(t, filepath.Join(src, "mods", ".mcsm-tmp-0123456789abcdef"), "half-written", 0o600)
	excl, err := NewExcluder(nil)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	st, err := WriteArchive(context.Background(), src, &buf, excl, nil)
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 1 {
		t.Fatalf("files = %d; the temporary must not be copied", st.Files)
	}
	// Without an Excluder (nil), the same: no future caller (migration) can include temporaries.
	buf.Reset()
	if st, err = WriteArchive(context.Background(), src, &buf, nil, nil); err != nil || st.Files != 1 {
		t.Fatalf("WriteArchive without Excluder: files = %d, err = %v; the temporary must not be copied", st.Files, err)
	}
}

func TestArchiveRoundTrip(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "server.properties"), "motd=hola\n", 0o644)
	mustWrite(t, filepath.Join(src, "world", "level.dat"), "LEVEL", 0o640)
	mustWrite(t, filepath.Join(src, "world", "region", "r.0.0.mca"), strings.Repeat("x", 200_000), 0o644)
	mustWrite(t, filepath.Join(src, "world", "session.lock"), "lock", 0o644)
	mustWrite(t, filepath.Join(src, "logs", "latest.log"), "log", 0o644)
	mustWrite(t, filepath.Join(src, "plugins", "foo", "logs", "a.log"), "nested log", 0o644)
	mustWrite(t, filepath.Join(src, "tmp", "file.tmp"), "tmp", 0o644)
	mustWrite(t, filepath.Join(src, "empty.txt"), "", 0o644)
	if err := os.Mkdir(filepath.Join(src, "emptydir"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(src, "emptydir"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("server.properties", filepath.Join(src, "link.properties")); err != nil {
		t.Fatal(err)
	}
	mtime := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(src, "world", "level.dat"), mtime, mtime); err != nil {
		t.Fatal(err)
	}

	excl, err := NewExcluder([]string{"logs", "*.tmp", "world/session.lock"})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	var lastDone, lastTotal int64
	st, err := WriteArchive(context.Background(), src, &buf, excl, func(d, tot int64) { lastDone, lastTotal = d, tot })
	if err != nil {
		t.Fatal(err)
	}
	wantBytes := int64(len("motd=hola\n") + len("LEVEL") + 200_000)
	if lastTotal != wantBytes || lastDone != wantBytes || st.Bytes != wantBytes {
		t.Fatalf("progress %d/%d, bytes %d; expected %d", lastDone, lastTotal, st.Bytes, wantBytes)
	}
	if st.Files != 4 { // server.properties, level.dat, r.0.0.mca, empty.txt
		t.Fatalf("files = %d", st.Files)
	}

	dst := filepath.Join(t.TempDir(), "out")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	var warns []string
	if err := ExtractArchive(context.Background(), &buf, dst, func(w string) { warns = append(warns, w) }); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dst, "world", "level.dat")) != "LEVEL" || len(mustRead(t, filepath.Join(dst, "world", "region", "r.0.0.mca"))) != 200_000 {
		t.Fatal("different content after extracting")
	}
	for _, gone := range []string{"logs", "plugins/foo/logs", "tmp/file.tmp", "world/session.lock", "link.properties"} {
		if exists(filepath.Join(dst, gone)) {
			t.Errorf("%s should not have been restored", gone)
		}
	}
	if !exists(filepath.Join(dst, "tmp")) || !exists(filepath.Join(dst, "empty.txt")) {
		t.Fatal("the (empty) tmp directory and empty.txt must exist")
	}
	if fi, _ := os.Stat(filepath.Join(dst, "world", "level.dat")); fi.Mode().Perm() != 0o640 || !fi.ModTime().Equal(mtime) {
		t.Fatalf("level.dat: mode %v, mtime %v", fi.Mode().Perm(), fi.ModTime())
	}
	if fi, _ := os.Stat(filepath.Join(dst, "emptydir")); fi.Mode().Perm() != 0o750 {
		t.Fatalf("emptydir: mode %v", fi.Mode().Perm())
	}
	if len(warns) != 1 || !strings.Contains(warns[0], "link.properties") {
		t.Fatalf("warnings = %v", warns)
	}
}

func TestWriteArchiveHeaders(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "world", "level.dat"), "L", 0o640)
	if err := os.Symlink("world/level.dat", filepath.Join(src, "lnk")); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := WriteArchive(context.Background(), src, &buf, nil, nil); err != nil {
		t.Fatal(err)
	}
	dec, err := zstd.NewReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	defer dec.Close()
	tr := tar.NewReader(dec)
	got := map[string]*tar.Header{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got[h.Name] = h
	}
	if len(got) != 3 {
		t.Fatalf("entries = %v", got)
	}
	if h := got["world/"]; h == nil || h.Typeflag != tar.TypeDir {
		t.Fatalf("world/: %+v", h)
	}
	h := got["world/level.dat"]
	if h == nil || h.Typeflag != tar.TypeReg || h.Uid != os.Getuid() || h.Gid != os.Getgid() || h.Uname != "" || h.Mode&0o777 != 0o640 {
		t.Fatalf("world/level.dat: %+v", h)
	}
	if h := got["lnk"]; h == nil || h.Typeflag != tar.TypeSymlink || h.Linkname != "world/level.dat" {
		t.Fatalf("lnk: %+v", h)
	}
}

func TestExtractRejectsPathsOutsideDestination(t *testing.T) {
	for _, name := range []string{"../evil.txt", "a/../../evil.txt", "ABS", "a/../evil.txt"} {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			dst := filepath.Join(base, "dst")
			if err := os.Mkdir(dst, 0o755); err != nil {
				t.Fatal(err)
			}
			n := name
			if n == "ABS" {
				n = filepath.Join(base, "evil.txt") // absolute path
			}
			data := makeArchive(t, []tarEntry{
				{hdr: tar.Header{Name: "ok.txt", Typeflag: tar.TypeReg}, body: "ok"},
				{hdr: tar.Header{Name: n, Typeflag: tar.TypeReg}, body: "pwned"},
			})
			err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil)
			if err == nil {
				t.Fatal("it must reject the backup")
			}
			if exists(filepath.Join(base, "evil.txt")) {
				t.Fatal("something was written outside the destination")
			}
			assertEmpty(t, dst) // ok.txt, already extracted, is deleted when the backup is rejected
		})
	}
}

func TestExtractNeverFollowsLinks(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	dst := filepath.Join(base, "dst")
	for _, d := range []string{outside, dst} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: outside}},
		{hdr: tar.Header{Name: "link/pwned.txt", Typeflag: tar.TypeReg}, body: "pwned"},
		{hdr: tar.Header{Name: "hard", Typeflag: tar.TypeLink, Linkname: "/etc/passwd"}},
	})
	var warns []string
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, func(w string) { warns = append(warns, w) }); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(outside, "pwned.txt")) {
		t.Fatal("something was written through a symbolic link")
	}
	if fi, err := os.Lstat(filepath.Join(dst, "link")); err != nil || fi.Mode()&fs.ModeSymlink != 0 || !fi.IsDir() {
		t.Fatalf("link must be a real directory inside the destination: %v %v", fi, err)
	}
	if mustRead(t, filepath.Join(dst, "link", "pwned.txt")) != "pwned" || exists(filepath.Join(dst, "hard")) {
		t.Fatal("unexpected content")
	}
	if len(warns) != 2 {
		t.Fatalf("warnings = %v", warns)
	}
}

func TestExtractSkipsSpecialFiles(t *testing.T) {
	dst := t.TempDir()
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "pax_global_header", Typeflag: tar.TypeXGlobalHeader, PAXRecords: map[string]string{"comment": "git archive"}}}, // metadata: ignored without warning
		{hdr: tar.Header{Name: "fifo", Typeflag: tar.TypeFifo}},
		{hdr: tar.Header{Name: "null", Typeflag: tar.TypeChar, Devmajor: 1, Devminor: 3}},
		{hdr: tar.Header{Name: "sda", Typeflag: tar.TypeBlock, Devmajor: 8}},
		{hdr: tar.Header{Name: "ok.txt", Typeflag: tar.TypeReg}, body: "ok"},
	})
	var warns []string
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, func(w string) { warns = append(warns, w) }); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"fifo", "null", "sda"} {
		if exists(filepath.Join(dst, n)) {
			t.Errorf("%s should not have been created", n)
		}
	}
	if mustRead(t, filepath.Join(dst, "ok.txt")) != "ok" || len(warns) != 3 {
		t.Fatalf("warnings = %v", warns)
	}
}

// A type that archive/tar does not treat as header-only (GNU sparse, unknown…) keeps
// its Size and Next() would discard that content by decompressing it in full, without a limit or ctx.
func TestExtractRejectsUnsupportedTypeWithContent(t *testing.T) {
	const unknown = 'Z'
	cases := map[string]struct {
		body string
		lim  ExtractLimits
		want string
	}{
		"zero bomb":      {strings.Repeat("\x00", 16<<20), ExtractLimits{MaxBytes: 1 << 20}, "limit"}, // 16 MiB that compress to nothing
		"type with data": {"x", ExtractLimits{}, "unsupported"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			enc, err := zstd.NewWriter(&buf)
			if err != nil {
				t.Fatal(err)
			}
			tw := tar.NewWriter(enc)
			if err := tw.WriteHeader(&tar.Header{Name: "raro", Typeflag: unknown, Mode: 0o644, Size: int64(len(c.body))}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte(c.body)); err != nil {
				t.Fatal(err)
			}
			if err := tw.WriteHeader(&tar.Header{Name: "ok.txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: 2}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte("ok")); err != nil {
				t.Fatal(err)
			}
			if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			if err := enc.Close(); err != nil {
				t.Fatal(err)
			}
			dst := t.TempDir()
			if err := ExtractArchiveLimits(context.Background(), &buf, dst, nil, c.lim); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v; expected %q", err, c.want)
			}
			assertEmpty(t, dst)
		})
	}
}

func TestExtractDropsSetuidSetgidSticky(t *testing.T) {
	dst := t.TempDir()
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o7755}},
		{hdr: tar.Header{Name: "bin/su", Typeflag: tar.TypeReg, Mode: 0o6755}, body: "#!/bin/sh\n"},
	})
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err != nil {
		t.Fatal(err)
	}
	const special = fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky
	for _, p := range []string{"bin", "bin/su"} {
		fi, err := os.Stat(filepath.Join(dst, p))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode()&special != 0 || fi.Mode().Perm() != 0o755 {
			t.Errorf("%s: mode %v", p, fi.Mode())
		}
	}
}

func TestExtractAcceptsDotSlashNames(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "dst")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	data := makeArchive(t, []tarEntry{ // like `tar -C data -c .`
		{hdr: tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0o700}},
		{hdr: tar.Header{Name: "./world/", Typeflag: tar.TypeDir, Mode: 0o755}},
		{hdr: tar.Header{Name: "./world//level.dat", Typeflag: tar.TypeReg}, body: "L"},
	})
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dst, "world", "level.dat")) != "L" {
		t.Fatal("unexpected content")
	}
	if fi, _ := os.Stat(dst); fi.Mode().Perm() != 0o755 {
		t.Fatalf("the ./ entry must not touch the destination itself: %v", fi.Mode())
	}
}

func TestExtractLimits(t *testing.T) {
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "d/", Typeflag: tar.TypeDir, Mode: 0o755}},
		{hdr: tar.Header{Name: "d/a.txt", Typeflag: tar.TypeReg}, body: "123456"},
		{hdr: tar.Header{Name: "d/b.txt", Typeflag: tar.TypeReg}, body: "123456"},
	})
	for name, lim := range map[string]ExtractLimits{"bytes": {MaxBytes: 11}, "entries": {MaxEntries: 2}} {
		t.Run(name, func(t *testing.T) {
			dst := t.TempDir()
			if err := ExtractArchiveLimits(context.Background(), bytes.NewReader(data), dst, nil, lim); err == nil {
				t.Fatal("it must exceed the limit")
			}
			assertEmpty(t, dst)
		})
	}
	if err := ExtractArchiveLimits(context.Background(), bytes.NewReader(data), t.TempDir(), nil, ExtractLimits{MaxBytes: 12, MaxEntries: 3}); err != nil {
		t.Fatalf("right at the limit it is accepted: %v", err)
	}
}

func TestExtractRejectsHugeDeclaredSizeBeforeWriting(t *testing.T) {
	// A header announcing 1 TiB without the content behind it: the limit trips when reading the
	// header, without decompressing or writing anything.
	var buf bytes.Buffer
	enc, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	if err := tw.WriteHeader(&tar.Header{Name: "bomb.bin", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1 << 40}); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	err = ExtractArchive(context.Background(), &buf, dst, nil)
	if err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatalf("err = %v", err)
	}
	assertEmpty(t, dst)
}

func TestExtractRequiresEmptyExistingDir(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "new"}})
	dst := t.TempDir()
	mustWrite(t, filepath.Join(dst, "a.txt"), "previous", 0o644)
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
		t.Fatal("a destination with content must be rejected")
	}
	if mustRead(t, filepath.Join(dst, "a.txt")) != "previous" {
		t.Fatal("it must not touch what was already there")
	}
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), filepath.Join(dst, "nonexistent"), nil); err == nil {
		t.Fatal("a nonexistent destination must be rejected")
	}
}

func TestExtractCorruptArchive(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: strings.Repeat("a", 100_000)}})
	dst := t.TempDir()
	err := ExtractArchive(context.Background(), bytes.NewReader(data[:len(data)/2]), dst, nil)
	if err == nil {
		t.Fatal("a truncated backup must give an error")
	}
	assertEmpty(t, dst) // the half-written file is deleted
}

func TestExtractRejectsEmptyOrUnterminated(t *testing.T) {
	// Complete zstd frame with a tar without its final blocks (cut at an entry boundary,
	// as if tar had died midway): archive/tar would consider it finished.
	var cut bytes.Buffer
	enc, err := zstd.NewWriter(&cut)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	if err := tw.WriteHeader(&tar.Header{Name: "a.txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"empty": nil, "without end": cut.Bytes()} {
		dst := t.TempDir()
		if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
			t.Errorf("%s: must be rejected", name)
		}
		assertEmpty(t, dst)
	}
}

func TestExtractVerifiesZstdChecksum(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "content"}})
	data[len(data)-1] ^= 0xff // the frame's checksum takes up the last 4 bytes
	dst := t.TempDir()
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
		t.Fatal("an incorrect checksum must give an error")
	}
	assertEmpty(t, dst)
}

func TestExtractReadsTheWholeStream(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "a"}})
	data = append(data, "garbage after the frame"...)
	dst := t.TempDir()
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
		t.Fatal("the data after the end must be read and rejected")
	}
	assertEmpty(t, dst)
}

func TestExtractCancelled(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "a"}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dst := t.TempDir()
	if err := ExtractArchive(ctx, bytes.NewReader(data), dst, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	assertEmpty(t, dst)
}

func TestExtractRestoresOwnerAsRoot(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	if uid != 0 { // without root it is simulated: chown to the user itself works, to another fails
		old := geteuid
		geteuid = func() int { return 0 }
		t.Cleanup(func() { geteuid = old })
	}
	owner := uid
	if uid == 0 {
		owner = 1000 // uid of the itzg image
	}
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "world/", Typeflag: tar.TypeDir, Mode: 0o755, Uid: owner, Gid: gid}},
		{hdr: tar.Header{Name: "world/level.dat", Typeflag: tar.TypeReg, Uid: owner, Gid: gid}, body: "L"},
	})
	dst := t.TempDir()
	var warns []string
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, func(w string) { warns = append(warns, w) }); err != nil || len(warns) != 0 {
		t.Fatalf("err = %v, warnings = %v", err, warns)
	}
	for _, p := range []string{"world", "world/level.dat"} {
		fi, err := os.Lstat(filepath.Join(dst, p))
		if err != nil {
			t.Fatal(err)
		}
		if st := fi.Sys().(*syscall.Stat_t); int(st.Uid) != owner {
			t.Errorf("%s: uid %d, expected %d", p, st.Uid, owner)
		}
	}
	if uid == 0 {
		return
	}
	// Without privileges, the chown to root (uid 0) fails: it proves that it is attempted on files and on
	// directories, that a warning is given only once and that the extraction continues.
	for name, entries := range map[string][]tarEntry{
		"files": {
			{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "a"},
			{hdr: tar.Header{Name: "b.txt", Typeflag: tar.TypeReg}, body: "b"},
		},
		"directory": {{hdr: tar.Header{Name: "d/", Typeflag: tar.TypeDir, Mode: 0o755}}},
	} {
		dst := t.TempDir()
		var warns []string
		if err := ExtractArchive(context.Background(), bytes.NewReader(makeArchive(t, entries)), dst, func(w string) { warns = append(warns, w) }); err != nil {
			t.Fatal(err)
		}
		if len(warns) != 1 || !strings.Contains(warns[0], "owner") || !exists(filepath.Join(dst, strings.TrimSuffix(entries[0].hdr.Name, "/"))) {
			t.Fatalf("%s: warnings = %v", name, warns)
		}
	}
}

// failingReader delivers body and then fails, like a tar cut off midway through a file.
type failingReader struct{ body *strings.Reader }

func (f failingReader) Read(p []byte) (int, error) {
	if f.body.Len() == 0 {
		return 0, io.ErrUnexpectedEOF
	}
	return f.body.Read(p)
}

func TestExtractFileRemovesPartialOnError(t *testing.T) {
	dst := t.TempDir()
	root, err := os.OpenRoot(dst)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	x := &extractor{ctx: context.Background(), root: root, warn: func(string) {}, buf: make([]byte, 4)}
	hdr := &tar.Header{Name: "a.txt", Typeflag: tar.TypeReg, Size: 100}
	if err := x.file("a.txt", failingReader{strings.NewReader("half")}, hdr, 0o644); err == nil {
		t.Fatal("it must fail")
	}
	assertEmpty(t, dst)
}

func TestWriteArchiveCancelled(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "a.txt"), "a", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := WriteArchive(ctx, src, io.Discard, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

// A backup cancelled midway must not be left as a valid tar.zst with only a part.
func TestWriteArchiveCancelledMidwayIsUnreadable(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "a.txt"), "a", 0o644)
	mustWrite(t, filepath.Join(src, "b.txt"), "b", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var buf bytes.Buffer
	if _, err := WriteArchive(ctx, src, &buf, nil, func(done, _ int64) {
		if done > 0 {
			cancel() // after the first file
		}
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if err := ExtractArchive(context.Background(), &buf, t.TempDir(), nil); err == nil {
		t.Fatal("the output of a cancelled backup must be unreadable")
	}
}

// failingWriter accepts n bytes and then fails (disk full, panel disconnected…).
type failingWriter struct{ n int }

func (f *failingWriter) Write(p []byte) (int, error) {
	if len(p) > f.n {
		k := f.n
		f.n = 0
		return k, errors.New("no space left")
	}
	f.n -= len(p)
	return len(p), nil
}

func TestWriteArchiveWriterError(t *testing.T) {
	src := t.TempDir()
	noise := make([]byte, 1<<20) // incompressible: the compressor writes before the end
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range noise {
		noise[i] = byte(rng.Uint32())
	}
	mustWrite(t, filepath.Join(src, "a.bin"), string(noise), 0o644)
	mustWrite(t, filepath.Join(src, "b.bin"), string(noise), 0o644)
	if _, err := WriteArchive(context.Background(), src, &failingWriter{n: 4096}, nil, nil); err == nil {
		t.Fatal("the destination's error must propagate")
	}
}

// A file that changed between the scan and its read (e.g. playerdata that Minecraft
// rewrites when a player leaves, even with save-off) is copied as it is when opened: the
// header comes from that moment, without padding or trimming and without a warning.
func TestWriteEntryCopiesFileAsOpened(t *testing.T) {
	dir := t.TempDir()
	shrunk, grown := filepath.Join(dir, "shrunk.log"), filepath.Join(dir, "grown.log")
	mustWrite(t, shrunk, "0123456789", 0o644)
	mustWrite(t, grown, "0123456789", 0o644)
	si, _ := os.Lstat(shrunk)
	gi, _ := os.Lstat(grown)
	mustWrite(t, shrunk, "0123", 0o644)                // shrinks after the scan
	mustWrite(t, grown, "0123456789ABCDEFGHIJ", 0o644) // grows after the scan
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ctx := context.Background()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	n, skipped, warn, err := writeEntry(ctx, tw, root, entry{rel: "shrunk.log", info: si}, make([]byte, 64))
	if err != nil || skipped || n != 4 || warn != "" {
		t.Fatalf("shrunk: n=%d skipped=%v warn=%q err=%v", n, skipped, warn, err)
	}
	n, _, warn, err = writeEntry(ctx, tw, root, entry{rel: "grown.log", info: gi}, make([]byte, 64))
	if err != nil || n != 20 || warn != "" {
		t.Fatalf("grown: n=%d warn=%q err=%v", n, warn, err)
	}
	if _, _, warn, _ = writeEntry(ctx, tw, root, entry{rel: "gone.log", info: si}, make([]byte, 64)); !strings.Contains(warn, "deleted") {
		t.Fatalf("gone: warn=%q", warn)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(&buf)
	for _, w := range []string{"0123", "0123456789ABCDEFGHIJ"} {
		if _, err := tr.Next(); err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		if string(body) != w {
			t.Fatalf("content %q, expected %q", body, w)
		}
	}
}

// hookWriter calls fire the first time what is written contains marker: this way a test changes
// a file right while its content is being copied.
type hookWriter struct {
	w      io.Writer
	marker []byte
	fire   func()
	fired  bool
}

func (h *hookWriter) Write(p []byte) (int, error) {
	if !h.fired && bytes.Contains(p, h.marker) {
		h.fired = true
		h.fire()
	}
	return h.w.Write(p)
}

// A file that changes WHILE it is being read (Minecraft saving when stopping during a hot
// backup) is neither truncated nor padded: the entry fails with ErrSourceChanged.
func TestWriteEntryFailsWhenFileChangesWhileRead(t *testing.T) {
	body := strings.Repeat("x", 200)
	old := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC) // old mtime: any write changes it
	cases := map[string]func(t *testing.T, p string){
		"grows": func(t *testing.T, p string) {
			f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if _, err := f.WriteString("MAS"); err != nil {
				t.Fatal(err)
			}
		},
		"shrinks": func(t *testing.T, p string) {
			if err := os.Truncate(p, 10); err != nil {
				t.Fatal(err)
			}
		},
		"rewritten with the same size": func(t *testing.T, p string) {
			f, err := os.OpenFile(p, os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if _, err := f.WriteAt([]byte(strings.Repeat("y", 200)), 0); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "level.dat")
			mustWrite(t, p, body, 0o644)
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
			info, err := os.Lstat(p)
			if err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			hw := &hookWriter{w: io.Discard, marker: []byte("xxxxxxxx"), fire: func() { change(t, p) }}
			_, _, _, err = writeEntry(context.Background(), tar.NewWriter(hw), root, entry{rel: "level.dat", info: info}, make([]byte, 64))
			if !hw.fired {
				t.Fatal("the change should have happened during the read")
			}
			if !errors.Is(err, ErrSourceChanged) {
				t.Fatalf("err = %v; expected ErrSourceChanged", err)
			}
		})
	}
}

// The same through WriteArchive: the error names the file and what was written is not a readable backup.
func TestWriteArchiveFailsWhenFileGrowsWhileRead(t *testing.T) {
	src := t.TempDir()
	noise := make([]byte, 4<<20) // incompressible: the compressor writes before finishing the file
	rng := rand.New(rand.NewPCG(3, 4))
	for i := range noise {
		noise[i] = byte(rng.Uint32())
	}
	big := filepath.Join(src, "world", "region", "r.0.0.mca")
	mustWrite(t, big, string(noise), 0o644)
	mustWrite(t, filepath.Join(src, "world", "zz.dat"), "fin", 0o644)
	var out bytes.Buffer
	grow := func() {
		f, err := os.OpenFile(big, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.Write([]byte("chunk saved when stopping")); err != nil {
			t.Fatal(err)
		}
	}
	hw := &hookWriter{w: &out, marker: nil, fire: grow} // the compressor's first write
	_, err := WriteArchive(context.Background(), src, hw, nil, nil)
	if !hw.fired {
		t.Fatal("the compressor wrote nothing before the end")
	}
	if !errors.Is(err, ErrSourceChanged) || !strings.Contains(err.Error(), "world/region/r.0.0.mca") {
		t.Fatalf("err = %v; expected ErrSourceChanged with the file name", err)
	}
	if err := ExtractArchive(context.Background(), &out, t.TempDir(), nil); err == nil {
		t.Fatal("what a failed backup wrote must be unreadable")
	}
}

// A container process swaps a directory for a link to the outside between the scan and
// the read: the agent (root) must never read host files through it.
func TestWriteEntryNeverReadsOutsideSource(t *testing.T) {
	for _, target := range []string{"ABS", "../outside"} {
		t.Run(target, func(t *testing.T) {
			base := t.TempDir()
			src, outside := filepath.Join(base, "src"), filepath.Join(base, "outside")
			mustWrite(t, filepath.Join(outside, "secret"), "SECRET", 0o644)
			mustWrite(t, filepath.Join(src, "world", "secret"), "publico", 0o644)
			info, err := os.Lstat(filepath.Join(src, "world", "secret"))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.RemoveAll(filepath.Join(src, "world")); err != nil {
				t.Fatal(err)
			}
			link := target
			if link == "ABS" {
				link = outside
			}
			if err := os.Symlink(link, filepath.Join(src, "world")); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(src)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			var buf bytes.Buffer
			tw := tar.NewWriter(&buf)
			if _, _, _, err := writeEntry(context.Background(), tw, root, entry{rel: "world/secret", info: info}, make([]byte, 64)); err == nil {
				t.Fatal("it must fail instead of following the link")
			}
			if strings.Contains(buf.String(), "SECRET") {
				t.Fatal("a file from outside the data was read")
			}
		})
	}
}

// A FIFO sneaked in instead of a file cannot block the backup (with save-off active).
func TestWriteEntrySkipsFifoSwappedIn(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x.dat")
	mustWrite(t, p, "data", 0o644)
	info, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(p, 0o644); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	type result struct {
		skipped bool
		warn    string
		err     error
	}
	done := make(chan result, 1)
	go func() {
		_, skipped, warn, err := writeEntry(context.Background(), tar.NewWriter(io.Discard), root, entry{rel: "x.dat", info: info}, make([]byte, 64))
		done <- result{skipped, warn, err}
	}()
	select {
	case r := <-done:
		if r.err != nil || !r.skipped || !strings.Contains(r.warn, "x.dat") {
			t.Fatalf("result = %+v", r)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("writeEntry blocked opening a FIFO")
	}
}

// If a directory stops being one between its parent's listing and its opening (file, FIFO,
// link to the outside or to another directory inside), its content is skipped with a warning instead of
// aborting the backup or listing something else under its name.
func TestReadDirInDetectsDirectoryThatChanged(t *testing.T) {
	for _, swap := range []string{"file", "fifo", "link outside", "link inside", "deleted", "same"} {
		t.Run(swap, func(t *testing.T) {
			base := t.TempDir()
			src := filepath.Join(base, "src")
			mustWrite(t, filepath.Join(src, "d", "x.txt"), "x", 0o644)
			mustWrite(t, filepath.Join(src, "other", "y.txt"), "y", 0o644)
			mustWrite(t, filepath.Join(base, "outside", "z.txt"), "z", 0o644)
			d := filepath.Join(src, "d")
			want, err := os.Lstat(d)
			if err != nil {
				t.Fatal(err)
			}
			if swap != "same" {
				if err := os.RemoveAll(d); err != nil {
					t.Fatal(err)
				}
			}
			switch swap {
			case "file":
				mustWrite(t, d, "no longer a directory", 0o644)
			case "fifo":
				err = syscall.Mkfifo(d, 0o644)
			case "link outside":
				err = os.Symlink("../outside", d)
			case "link inside":
				err = os.Symlink("other", d)
			}
			if err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(src)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			des, changed, err := readDirIn(root, "d", want)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			switch swap {
			case "same":
				if changed || len(des) != 1 || des[0].Name() != "x.txt" {
					t.Fatalf("des = %v, changed = %v", des, changed)
				}
			case "deleted":
				if changed || len(des) != 0 {
					t.Fatalf("des = %v, changed = %v", des, changed)
				}
			default:
				if !changed || len(des) != 0 {
					t.Fatalf("des = %v, changed = %v", des, changed)
				}
			}
		})
	}
}
