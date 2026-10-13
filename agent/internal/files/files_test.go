package files

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// layout creates <tmp>/srv/alpha/data (the root), a secret outside it and a sibling folder
// data2 whose name shares a prefix with the root.
func layout(t *testing.T) (fsys *FS, root, outside string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "srv", "alpha", "data")
	outside = filepath.Join(base, "outside")
	for _, d := range []string{root, outside, filepath.Join(root, "mods"), filepath.Join(root, "config"), filepath.Join(base, "srv", "alpha", "data2")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(outside, "secret.txt"), "SECRET")
	write(t, filepath.Join(base, "srv", "alpha", "data2", "secret.txt"), "SECRET2")
	write(t, filepath.Join(root, "server.properties"), "motd=hola\n")
	write(t, filepath.Join(root, "config", "a.yml"), "a: 1\n")
	return New(root), root, outside
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestClean(t *testing.T) {
	ok := map[string]string{"": ".", "/": ".", ".": ".", "mods": "mods", "/mods/a.jar": "mods/a.jar", "mods//a.jar/": "mods/a.jar", "./config/./a.yml": "config/a.yml", "with spaces/ñ.txt": "with spaces/ñ.txt"}
	for in, want := range ok {
		got, err := Clean(in)
		if err != nil || got != want {
			t.Errorf("Clean(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"../../etc/passwd", "/..", "mods/../../x", "a/../b", "a\x00b", "a\nb", "a\rb", string(make([]byte, 5000))} {
		if _, err := Clean(in); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Clean(%q) = %v; want ErrInvalidPath", in, err)
		}
	}
}

func TestRootValidatesSlug(t *testing.T) {
	if got, err := Root("/srv/minecraft/", "alpha"); err != nil || got != "/srv/minecraft/alpha/data" {
		t.Fatalf("Root = %q, %v", got, err)
	}
	for _, slug := range []string{"../etc", "", "A", "a/b"} {
		if _, err := Root("/srv/minecraft", slug); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Root(%q) must fail", slug)
		}
	}
}

func TestTraversalRejected(t *testing.T) {
	fsys, _, _ := layout(t)
	if _, _, err := fsys.Read("../../etc/passwd", 0); !errors.Is(err, ErrInvalidPath) || Code(err) != "invalid_path" {
		t.Fatalf("err = %v", err)
	}
	if _, _, err := fsys.List("../"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("err = %v", err)
	}
}

func TestSymlinksOutsideAreRejected(t *testing.T) {
	fsys, root, outside := layout(t)
	must(t, os.Symlink(outside, filepath.Join(root, "abs")))                       // absolute, outside
	must(t, os.Symlink("../../../outside/secret.txt", filepath.Join(root, "rel"))) // relative, outside
	must(t, os.Symlink("../data2", filepath.Join(root, "sibling")))                // sibling with a common prefix
	cases := []string{"abs/secret.txt", "rel", "sibling/secret.txt", "abs/nonexistent"}
	for _, p := range cases {
		if _, _, err := fsys.Read(p, 0); !errors.Is(err, ErrOutside) {
			t.Errorf("Read(%q) = %v; want ErrOutside", p, err)
		}
		if _, err := fsys.Stat(p); !errors.Is(err, ErrOutside) {
			t.Errorf("Stat(%q) = %v; want ErrOutside", p, err)
		}
		if f, _, err := fsys.Open(p); !errors.Is(err, ErrOutside) {
			if f != nil {
				f.Close()
			}
			t.Errorf("Open(%q) = %v; want ErrOutside", p, err)
		}
	}
	if _, _, err := fsys.List("abs"); !errors.Is(err, ErrOutside) {
		t.Errorf("List(abs) = %v", err)
	}
}

func TestSymlinkInsideIsFollowed(t *testing.T) {
	fsys, root, _ := layout(t)
	must(t, os.Symlink("config", filepath.Join(root, "cfg")))
	data, _, err := fsys.Read("cfg/a.yml", 0)
	if err != nil || string(data) != "a: 1\n" {
		t.Fatalf("Read = %q, %v", data, err)
	}
}

func TestRootBehindSymlink(t *testing.T) {
	_, root, _ := layout(t)
	link := filepath.Join(t.TempDir(), "mc")
	must(t, os.Symlink(filepath.Dir(filepath.Dir(root)), link)) // DATA_ROOT is a link
	fsys := New(filepath.Join(link, "alpha", "data"))
	if data, _, err := fsys.Read("server.properties", 0); err != nil || string(data) != "motd=hola\n" {
		t.Fatalf("Read = %q, %v", data, err)
	}
}

func TestTOCTOUSwapToSymlinkIsRefused(t *testing.T) {
	fsys, root, outside := layout(t)
	must(t, os.MkdirAll(filepath.Join(root, "sub"), 0o755))
	write(t, filepath.Join(root, "sub", "secret.txt"), "inside")
	// Between the check and the use, "sub" becomes a link to the outside folder.
	fsys.afterCheck = func() {
		must(t, os.RemoveAll(filepath.Join(root, "sub")))
		must(t, os.Symlink(outside, filepath.Join(root, "sub")))
	}
	data, _, err := fsys.Read("sub/secret.txt", 0)
	if !errors.Is(err, ErrOutside) || string(data) == "SECRET" {
		t.Fatalf("Read after the change = %q, %v; want ErrOutside", data, err)
	}
}

func TestList(t *testing.T) {
	fsys, root, outside := layout(t)
	write(t, filepath.Join(root, "B.txt"), "b")
	write(t, filepath.Join(root, tmpPrefix+"0123456789abcdef"), "temporal")
	write(t, filepath.Join(root, tmpPrefix+"x"), "user's: not a temporary") // shown
	must(t, os.Symlink("config", filepath.Join(root, "cfg")))
	must(t, os.Symlink(outside, filepath.Join(root, "out")))
	entries, truncated, err := fsys.List("/")
	if err != nil || truncated {
		t.Fatalf("List = %v, %v", truncated, err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name)
	}
	want := []string{"cfg", "config", "mods", tmpPrefix + "x", "B.txt", "out", "server.properties"}
	if fmt.Sprint(names) != fmt.Sprint(want) {
		t.Fatalf("names = %v; want %v", names, want)
	}
	if !entries[0].Dir || !entries[0].Symlink {
		t.Fatalf("cfg must be a link to a folder: %+v", entries[0])
	}
	if entries[5].Dir || !entries[5].Symlink {
		t.Fatalf("out must be shown as a link without following it: %+v", entries[4])
	}
	if _, _, err := fsys.List("server.properties"); !errors.Is(err, ErrNotDir) {
		t.Fatalf("List(file) = %v", err)
	}
	if _, _, err := fsys.List("nonexistent"); !errors.Is(err, ErrNotFound) || Code(err) != "not_found" {
		t.Fatalf("List(nonexistent) = %v", err)
	}
}

func TestListTruncated(t *testing.T) {
	fsys, root, _ := layout(t)
	old := maxEntries
	maxEntries = 3
	t.Cleanup(func() { maxEntries = old })
	for i := range 5 {
		write(t, filepath.Join(root, "mods", fmt.Sprintf("m%d.jar", i)), "x")
	}
	entries, truncated, err := fsys.List("mods")
	if err != nil || !truncated || len(entries) != 3 {
		t.Fatalf("len=%d truncated=%v err=%v", len(entries), truncated, err)
	}
}

func TestListMissingDataDir(t *testing.T) {
	fsys := New(filepath.Join(t.TempDir(), "new", "data"))
	if _, _, err := fsys.List("/"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestReadLimits(t *testing.T) {
	fsys, root, _ := layout(t)
	big := filepath.Join(root, "big.log")
	f, err := os.Create(big)
	must(t, err)
	must(t, f.Truncate(InlineMax+1))
	f.Close()
	if _, size, err := fsys.Read("big.log", 0); !errors.Is(err, ErrTooLarge) || size != InlineMax+1 || Code(err) != "too_large" {
		t.Fatalf("Read(big) = %d, %v", size, err)
	}
	if _, _, err := fsys.Read("server.properties", 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("max_bytes smaller than the file must give too_large: %v", err)
	}
	if _, _, err := fsys.Read("config", 0); !errors.Is(err, ErrIsDir) {
		t.Fatalf("Read(folder) = %v", err)
	}
	must(t, syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644))
	if _, _, err := fsys.Read("pipe", 0); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Read(fifo) = %v; it must neither block nor be read", err)
	}
}

func TestOpenForDownload(t *testing.T) {
	fsys, _, _ := layout(t)
	f, e, err := fsys.Open("/server.properties")
	must(t, err)
	defer f.Close()
	data, _ := io.ReadAll(f)
	if string(data) != "motd=hola\n" || e.Size != int64(len(data)) || e.Name != "server.properties" {
		t.Fatalf("data=%q entry=%+v", data, e)
	}
	if _, _, err := fsys.Open("config"); !errors.Is(err, ErrIsDir) || Code(err) != "is_dir" {
		t.Fatalf("Open(folder) = %v", err)
	}
}

func TestCodes(t *testing.T) {
	cases := map[error]string{
		ErrInvalidPath: "invalid_path", ErrOutside: "path_outside", ErrUnknownServer: "unknown_server",
		ErrNotFound: "not_found", ErrExists: "exists", ErrIsDir: "is_dir", ErrNotDir: "not_dir",
		ErrTooLarge: "too_large", ErrRoot: "root", ErrTransfer: "transfer_failed", errors.New("x"): "io_error",
	}
	for err, want := range cases {
		if got := Code(fmt.Errorf("wrapped: %w", err)); got != want {
			t.Errorf("Code(%v) = %s; want %s", err, got, want)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestDanglingSymlinkOutside(t *testing.T) {
	fsys, root, outside := layout(t)
	target := filepath.Join(outside, "nonexistent")
	must(t, os.Symlink(target, filepath.Join(root, "colgante")))
	_, _, err := fsys.Read("colgante", 0)
	if !errors.Is(err, ErrOutside) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("Read = %v; want path_outside or not_found", err)
	}
	if strings.Contains(err.Error(), outside) {
		t.Fatalf("the error reveals the host path: %v", err)
	}
}

func TestSocketIsRejected(t *testing.T) {
	fsys, root, _ := layout(t)
	l, err := net.Listen("unix", filepath.Join(root, "s.sock"))
	must(t, err)
	defer l.Close()
	if _, _, err := fsys.Read("s.sock", 0); err == nil {
		t.Fatal("a socket must not be read")
	}
}

func TestPermissionDeniedIsIOError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores permissions")
	}
	fsys, root, _ := layout(t)
	locked := filepath.Join(root, "locked")
	must(t, os.MkdirAll(filepath.Join(locked, "d"), 0o755))
	must(t, os.Chmod(locked, 0))
	t.Cleanup(func() { os.Chmod(locked, 0o755) })
	_, _, err := fsys.Read("locked/d/x", 0)
	if Code(err) != "io_error" {
		t.Fatalf("Read = %v (%s); want io_error", err, Code(err))
	}
}

// TempGlob is exactly the name of the temporaries WriteFrom creates and SweepTemps sweeps
// (tmpPrefix + 16 lowercase hexadecimal characters): a user file that merely starts the same way
// is not hidden, not excluded from backups and not swept.
func TestTempGlobMatchesExactlyTheTemps(t *testing.T) {
	if TempGlob != tmpPrefix+strings.Repeat("[0-9a-f]", 16) {
		t.Fatalf("TempGlob = %q", TempGlob)
	}
	for range 50 {
		if name := tmpPrefix + randHex(); !IsTempName(name) {
			t.Fatalf("a WriteFrom temporary (%q) does not match TempGlob", name)
		}
	}
	for name, want := range map[string]bool{
		tmpPrefix + "0123456789abcdef":       true,
		tmpPrefix + "x":                      false,
		tmpPrefix + "notes.txt":              false,
		tmpPrefix + "0123456789ABCDEF":       false,
		tmpPrefix + "0123456789abcdef0":      false,
		tmpPrefix + "0123456789abcde":        false,
		"a" + tmpPrefix + "0123456789abcdef": false,
	} {
		if got := IsTempName(name); got != want {
			t.Errorf("IsTempName(%q) = %v; want %v", name, got, want)
		}
	}
}
