package files

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// noTemps fails if any write temporary was left in dir.
func noTemps(t *testing.T, dir string) {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, de := range des {
		if strings.HasPrefix(de.Name(), tmpPrefix) {
			t.Fatalf("temporary not deleted: %s", de.Name())
		}
	}
}

type failingReader struct{ n int }

func (f *failingReader) Read(p []byte) (int, error) {
	if f.n <= 0 {
		return 0, errors.New("connection cut")
	}
	f.n -= len(p)
	return len(p), nil
}

func TestWriteReplacesAtomicallyKeepingMode(t *testing.T) {
	fsys, root, _ := layout(t)
	p := filepath.Join(root, "server.properties")
	must(t, os.Chmod(p, 0o600))
	must(t, fsys.Write("/server.properties", []byte("motd=adiós\n")))
	if got := readFile(t, p); got != "motd=adiós\n" {
		t.Fatalf("content = %q", got)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Fatalf("permissions = %v; they must be kept", st.Mode().Perm())
	}
	noTemps(t, root)
}

func TestWriteNewFileGets0644(t *testing.T) {
	fsys, root, _ := layout(t)
	must(t, fsys.Write("config/new.toml", []byte("x = 1\n")))
	st, err := os.Stat(filepath.Join(root, "config", "new.toml"))
	if err != nil || st.Mode().Perm() != 0o644 {
		t.Fatalf("stat = %v, %v", st, err)
	}
}

func TestWriteFailureKeepsOriginal(t *testing.T) {
	fsys, root, _ := layout(t)
	_, err := fsys.WriteFrom("server.properties", &failingReader{n: 64 << 10}, -1)
	if !errors.Is(err, ErrTransfer) || Code(err) != "transfer_failed" {
		t.Fatalf("err = %v", err)
	}
	if got := readFile(t, filepath.Join(root, "server.properties")); got != "motd=hola\n" {
		t.Fatalf("the original changed: %q", got)
	}
	noTemps(t, root)
}

func TestWriteTruncatedTransferKeepsOriginal(t *testing.T) {
	fsys, root, _ := layout(t)
	_, err := fsys.WriteFrom("server.properties", strings.NewReader("short"), 100)
	if !errors.Is(err, ErrTransfer) {
		t.Fatalf("err = %v", err)
	}
	if got := readFile(t, filepath.Join(root, "server.properties")); got != "motd=hola\n" {
		t.Fatalf("the original changed: %q", got)
	}
	noTemps(t, root)
}

// countingReader counts the bytes read from the source.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func TestWriteFromStopsReadingPastExpected(t *testing.T) {
	fsys, root, _ := layout(t)
	// a source that sends too much (1 MiB when 10 bytes were expected) cannot fill the disk
	src := &countingReader{r: io.LimitReader(&pattern{}, 1<<20)}
	_, err := fsys.WriteFrom("server.properties", src, 10)
	if !errors.Is(err, ErrTransfer) || Code(err) != "transfer_failed" {
		t.Fatalf("err = %v", err)
	}
	if src.n > 11 {
		t.Fatalf("%d bytes were read from a source that should have carried 10: it must be cut at expected+1", src.n)
	}
	if got := readFile(t, filepath.Join(root, "server.properties")); got != "motd=hola\n" {
		t.Fatalf("the original changed: %q", got)
	}
	noTemps(t, root)
}

func TestWriteErrors(t *testing.T) {
	fsys, root, outside := layout(t)
	must(t, os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "evil.txt")))
	must(t, os.Symlink(outside, filepath.Join(root, "evildir")))
	cases := []struct {
		path string
		want error
	}{
		{"../../etc/passwd", ErrInvalidPath},
		{"/", ErrRoot},
		{"config", ErrIsDir},
		{"nonexistent/a.txt", ErrNotFound},
		{"server.properties/a.txt", ErrNotDir},
		{"evil.txt", ErrOutside},
		{"evildir/new.txt", ErrOutside},
	}
	for _, c := range cases {
		if err := fsys.Write(c.path, []byte("x")); !errors.Is(err, c.want) {
			t.Errorf("Write(%q) = %v; want %v", c.path, err, c.want)
		}
		if err := fsys.CheckWrite(c.path); !errors.Is(err, c.want) {
			t.Errorf("CheckWrite(%q) = %v; want %v", c.path, err, c.want)
		}
	}
	if got := readFile(t, filepath.Join(outside, "secret.txt")); got != "SECRET" {
		t.Fatalf("written outside: %q", got)
	}
	if err := fsys.Write("a.txt", bytes.Repeat([]byte("x"), InlineMax+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Write(>2 MiB) = %v", err)
	}
}

func TestWriteThroughInsideSymlinkWritesTarget(t *testing.T) {
	fsys, root, _ := layout(t)
	must(t, os.Symlink("config/a.yml", filepath.Join(root, "alias.yml")))
	must(t, fsys.Write("alias.yml", []byte("a: 2\n")))
	if got := readFile(t, filepath.Join(root, "config", "a.yml")); got != "a: 2\n" {
		t.Fatalf("target = %q", got)
	}
	if li, _ := os.Lstat(filepath.Join(root, "alias.yml")); li.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link must remain a link")
	}
}

// patternBlock is a repeated 251-byte cycle; pattern copies it without reserving memory.
var patternBlock = func() []byte {
	b := make([]byte, 64<<10+251)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}()

// pattern generates deterministic bytes (up to 64 KiB per read) without reserving memory.
type pattern struct{ off int }

func (p *pattern) Read(b []byte) (int, error) {
	n := copy(b, patternBlock[p.off%251:])
	p.off += n
	return n, nil
}

func TestWriteFromStreamsWithoutBuffering(t *testing.T) {
	fsys, root, _ := layout(t)
	const size = 50 << 20
	h := sha256.New()
	src := io.TeeReader(io.LimitReader(&pattern{}, size), h)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	n, err := fsys.WriteFrom("mods/big.jar", src, size)
	runtime.ReadMemStats(&after)
	if err != nil || n != size {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 8<<20 {
		t.Fatalf("%d bytes were reserved to write 50 MiB: it is not streaming", alloc)
	}
	f, _ := os.Open(filepath.Join(root, "mods", "big.jar"))
	defer f.Close()
	h2 := sha256.New()
	_, _ = io.Copy(h2, f)
	if !bytes.Equal(h.Sum(nil), h2.Sum(nil)) {
		t.Fatal("the content written does not match")
	}
}

func TestMkdir(t *testing.T) {
	fsys, root, outside := layout(t)
	must(t, fsys.Mkdir("plugins"))
	if st, err := os.Stat(filepath.Join(root, "plugins")); err != nil || !st.IsDir() {
		t.Fatalf("stat = %v, %v", st, err)
	}
	if err := fsys.Mkdir("plugins"); !errors.Is(err, ErrExists) || Code(err) != "exists" {
		t.Fatalf("repeated Mkdir = %v", err)
	}
	if err := fsys.Mkdir("a/b"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Mkdir without parent = %v", err)
	}
	must(t, os.Symlink(outside, filepath.Join(root, "evildir")))
	if err := fsys.Mkdir("evildir/x"); !errors.Is(err, ErrOutside) {
		t.Fatalf("Mkdir outside = %v", err)
	}
	if err := fsys.Mkdir("/"); !errors.Is(err, ErrRoot) {
		t.Fatalf("Mkdir root = %v", err)
	}
}

func TestRename(t *testing.T) {
	fsys, root, outside := layout(t)
	must(t, fsys.Rename("config/a.yml", "config/b.yml"))
	if got := readFile(t, filepath.Join(root, "config", "b.yml")); got != "a: 1\n" {
		t.Fatalf("b.yml = %q", got)
	}
	if err := fsys.Rename("config/b.yml", "server.properties"); !errors.Is(err, ErrExists) {
		t.Fatalf("Rename over existing = %v", err)
	}
	if err := fsys.Rename("/", "x"); !errors.Is(err, ErrRoot) {
		t.Fatalf("Rename root = %v", err)
	}
	if err := fsys.Rename("nonexistent", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Rename nonexistent = %v", err)
	}
	if err := fsys.Rename("config", "config/inside"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Rename into itself = %v", err)
	}
	must(t, os.Symlink(outside, filepath.Join(root, "evildir")))
	if err := fsys.Rename("server.properties", "evildir/robado"); !errors.Is(err, ErrOutside) {
		t.Fatalf("Rename outwards = %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "robado")); !os.IsNotExist(err) {
		t.Fatal("nothing must appear outside")
	}
}

func TestDelete(t *testing.T) {
	fsys, root, outside := layout(t)
	must(t, os.Symlink(outside, filepath.Join(root, "config", "link")))
	must(t, fsys.Delete("config")) // folder with a link to the outside inside
	if _, err := os.Stat(filepath.Join(root, "config")); !os.IsNotExist(err) {
		t.Fatal("config must disappear")
	}
	if got := readFile(t, filepath.Join(outside, "secret.txt")); got != "SECRET" {
		t.Fatal("deleting the link must not touch its target")
	}
	must(t, fsys.Delete("/server.properties"))
	if err := fsys.Delete("server.properties"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("repeated Delete = %v", err)
	}
	if err := fsys.Delete("/"); !errors.Is(err, ErrRoot) || Code(err) != "root" {
		t.Fatalf("Delete root = %v", err)
	}
}
