package files

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// layout crea <tmp>/srv/alpha/data (la raíz), un secreto fuera de ella y una carpeta hermana
// data2 cuyo nombre comparte prefijo con la raíz.
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
	write(t, filepath.Join(outside, "secret.txt"), "SECRETO")
	write(t, filepath.Join(base, "srv", "alpha", "data2", "secret.txt"), "SECRETO2")
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
	ok := map[string]string{"": ".", "/": ".", ".": ".", "mods": "mods", "/mods/a.jar": "mods/a.jar", "mods//a.jar/": "mods/a.jar", "./config/./a.yml": "config/a.yml", "con espacios/ñ.txt": "con espacios/ñ.txt"}
	for in, want := range ok {
		got, err := Clean(in)
		if err != nil || got != want {
			t.Errorf("Clean(%q) = %q, %v; quiero %q", in, got, err, want)
		}
	}
	for _, in := range []string{"../../etc/passwd", "/..", "mods/../../x", "a/../b", "a\x00b", "a\nb", "a\rb", string(make([]byte, 5000))} {
		if _, err := Clean(in); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Clean(%q) = %v; quiero ErrInvalidPath", in, err)
		}
	}
}

func TestRootValidatesSlug(t *testing.T) {
	if got, err := Root("/srv/minecraft/", "alpha"); err != nil || got != "/srv/minecraft/alpha/data" {
		t.Fatalf("Root = %q, %v", got, err)
	}
	for _, slug := range []string{"../etc", "", "A", "a/b"} {
		if _, err := Root("/srv/minecraft", slug); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Root(%q) debe fallar", slug)
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
	must(t, os.Symlink(outside, filepath.Join(root, "abs")))                       // absoluto fuera
	must(t, os.Symlink("../../../outside/secret.txt", filepath.Join(root, "rel"))) // relativo fuera
	must(t, os.Symlink("../data2", filepath.Join(root, "sibling")))                // hermano con prefijo común
	cases := []string{"abs/secret.txt", "rel", "sibling/secret.txt", "abs/no-existe"}
	for _, p := range cases {
		if _, _, err := fsys.Read(p, 0); !errors.Is(err, ErrOutside) {
			t.Errorf("Read(%q) = %v; quiero ErrOutside", p, err)
		}
		if _, err := fsys.Stat(p); !errors.Is(err, ErrOutside) {
			t.Errorf("Stat(%q) = %v; quiero ErrOutside", p, err)
		}
		if f, _, err := fsys.Open(p); !errors.Is(err, ErrOutside) {
			if f != nil {
				f.Close()
			}
			t.Errorf("Open(%q) = %v; quiero ErrOutside", p, err)
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
	must(t, os.Symlink(filepath.Dir(filepath.Dir(root)), link)) // DATA_ROOT es un enlace
	fsys := New(filepath.Join(link, "alpha", "data"))
	if data, _, err := fsys.Read("server.properties", 0); err != nil || string(data) != "motd=hola\n" {
		t.Fatalf("Read = %q, %v", data, err)
	}
}

func TestTOCTOUSwapToSymlinkIsRefused(t *testing.T) {
	fsys, root, outside := layout(t)
	must(t, os.MkdirAll(filepath.Join(root, "sub"), 0o755))
	write(t, filepath.Join(root, "sub", "secret.txt"), "dentro")
	// Entre la comprobación y el uso, "sub" pasa a ser un enlace a la carpeta de fuera.
	fsys.afterCheck = func() {
		must(t, os.RemoveAll(filepath.Join(root, "sub")))
		must(t, os.Symlink(outside, filepath.Join(root, "sub")))
	}
	data, _, err := fsys.Read("sub/secret.txt", 0)
	if !errors.Is(err, ErrOutside) || string(data) == "SECRETO" {
		t.Fatalf("Read tras el cambio = %q, %v; quiero ErrOutside", data, err)
	}
}

func TestList(t *testing.T) {
	fsys, root, outside := layout(t)
	write(t, filepath.Join(root, "B.txt"), "b")
	write(t, filepath.Join(root, tmpPrefix+"x"), "temporal")
	must(t, os.Symlink("config", filepath.Join(root, "cfg")))
	must(t, os.Symlink(outside, filepath.Join(root, "fuera")))
	entries, truncated, err := fsys.List("/")
	if err != nil || truncated {
		t.Fatalf("List = %v, %v", truncated, err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name)
	}
	want := []string{"cfg", "config", "mods", "B.txt", "fuera", "server.properties"}
	if fmt.Sprint(names) != fmt.Sprint(want) {
		t.Fatalf("names = %v; quiero %v", names, want)
	}
	if !entries[0].Dir || !entries[0].Symlink {
		t.Fatalf("cfg debe ser enlace a carpeta: %+v", entries[0])
	}
	if entries[4].Dir || !entries[4].Symlink {
		t.Fatalf("fuera debe verse como enlace sin seguir: %+v", entries[4])
	}
	if _, _, err := fsys.List("server.properties"); !errors.Is(err, ErrNotDir) {
		t.Fatalf("List(fichero) = %v", err)
	}
	if _, _, err := fsys.List("no-existe"); !errors.Is(err, ErrNotFound) || Code(err) != "not_found" {
		t.Fatalf("List(no-existe) = %v", err)
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
	fsys := New(filepath.Join(t.TempDir(), "nuevo", "data"))
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
		t.Fatalf("max_bytes menor que el fichero debe dar too_large: %v", err)
	}
	if _, _, err := fsys.Read("config", 0); !errors.Is(err, ErrIsDir) {
		t.Fatalf("Read(carpeta) = %v", err)
	}
	must(t, syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644))
	if _, _, err := fsys.Read("pipe", 0); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Read(fifo) = %v; no debe bloquearse ni leerse", err)
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
		t.Fatalf("Open(carpeta) = %v", err)
	}
}

func TestCodes(t *testing.T) {
	cases := map[error]string{
		ErrInvalidPath: "invalid_path", ErrOutside: "path_outside", ErrUnknownServer: "unknown_server",
		ErrNotFound: "not_found", ErrExists: "exists", ErrIsDir: "is_dir", ErrNotDir: "not_dir",
		ErrTooLarge: "too_large", ErrRoot: "root", ErrTransfer: "transfer_failed", errors.New("x"): "io_error",
	}
	for err, want := range cases {
		if got := Code(fmt.Errorf("envuelto: %w", err)); got != want {
			t.Errorf("Code(%v) = %s; quiero %s", err, got, want)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
