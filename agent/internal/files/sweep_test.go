package files

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Solo se borran ficheros normales con el nombre exacto de un temporal, viejos y dentro de la
// raíz; ni enlaces, ni carpetas, ni nada a lo que se llegue por un enlace.
func TestSweepTempsRemovesOnlyOldOrphansInside(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	now := time.Now().Add(2 * time.Hour) // todo lo creado ahora tiene 2 h para el barrido
	write := func(p string, age time.Duration) string {
		t.Helper()
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(full, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
		return full
	}
	oldTop := write(".mcsm-tmp-0123456789abcdef", 2*time.Hour)
	oldNested := write("world/region/.mcsm-tmp-00000000000000ff", 3*time.Hour)
	recent := write(".mcsm-tmp-fedcba9876543210", 10*time.Minute)
	notHex := write(".mcsm-tmp-zz", 2*time.Hour)
	shortName := write(".mcsm-tmp-0123", 2*time.Hour)
	normal := write("level.dat", 5*time.Hour)
	dirTmp := filepath.Join(root, "mods", ".mcsm-tmp-1111111111111111")
	if err := os.MkdirAll(dirTmp, 0o755); err != nil {
		t.Fatal(err)
	}
	// Un enlace con nombre de temporal hacia fuera y una carpeta enlazada hacia fuera con un
	// temporal dentro: ninguno se toca.
	victim := filepath.Join(outside, ".mcsm-tmp-2222222222222222")
	if err := os.WriteFile(victim, []byte("fuera"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(victim, now.Add(-5*time.Hour), now.Add(-5*time.Hour)); err != nil {
		t.Fatal(err)
	}
	linkTmp := filepath.Join(root, ".mcsm-tmp-3333333333333333")
	if err := os.Symlink(victim, linkTmp); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "fuera")); err != nil {
		t.Fatal(err)
	}

	n, err := New(root).SweepTemps(context.Background(), time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("borrados = %d; quiero 2", n)
	}
	for _, p := range []string{oldTop, oldNested} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Errorf("%s sigue ahí (err %v)", p, err)
		}
	}
	for _, p := range []string{recent, notHex, shortName, normal, dirTmp, linkTmp, victim} {
		if _, err := os.Lstat(p); err != nil {
			t.Errorf("%s no debería haberse borrado: %v", p, err)
		}
	}
}

func TestSweepTempsStopsWithContext(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".mcsm-tmp-0123456789abcdef"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	n, err := New(root).SweepTemps(ctx, time.Hour, time.Now().Add(2*time.Hour))
	if err == nil || n != 0 {
		t.Fatalf("n = %d, err = %v; quiero 0 y el error del contexto", n, err)
	}
}
