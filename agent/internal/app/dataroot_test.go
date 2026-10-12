package app

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// probe construye un sysProbe de test con un mountinfo fijo.
func probe(inContainer bool, mountinfo string) sysProbe {
	return sysProbe{
		inContainer: func() bool { return inContainer },
		mountinfo:   func() ([]byte, error) { return []byte(mountinfo), nil },
	}
}

const overlayRoot = "927 889 0:91 / / rw,relatime - overlay overlay rw,lowerdir=/x\n" +
	"929 927 0:102 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n"

func bindLine(root, mountPoint, superOpts string) string {
	return "936 927 0:30 " + root + " " + mountPoint + " rw,relatime - btrfs /dev/mapper/root " + superOpts + "\n"
}

func checkWithLog(t *testing.T, dataRoot string, p sysProbe) (error, string) {
	t.Helper()
	var buf bytes.Buffer
	err := checkDataRoot(dataRoot, p, slog.New(slog.NewTextHandler(&buf, nil)))
	return err, buf.String()
}

func TestCheckDataRootOutsideContainerSkips(t *testing.T) {
	p := probe(false, "")
	p.mountinfo = func() ([]byte, error) { return nil, errors.New("no debe leerse") }
	if err, _ := checkWithLog(t, "/no/existe", p); err != nil {
		t.Fatalf("fuera de un contenedor DATA_ROOT ya es una ruta del host: %v", err)
	}
}

func TestCheckDataRootMirrorMountOK(t *testing.T) {
	dir := t.TempDir()
	err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine(dir, dir, "rw")))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(log, "WARN") {
		t.Fatalf("sin avisos con un montaje espejo: %s", log)
	}
}

func TestCheckDataRootParentMountOK(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "minecraft")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine(parent, parent, "rw"))); err != nil || strings.Contains(log, "WARN") {
		t.Fatalf("un montaje espejo de un directorio padre también vale: %v %s", err, log)
	}
}

func TestCheckDataRootBtrfsSubvolumeOK(t *testing.T) {
	dir := t.TempDir()
	// En el host, /home es el subvolumen @home: root lleva el prefijo del subvolumen.
	err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine("/@home"+dir, dir, "rw,subvol=/@home")))
	if err != nil || strings.Contains(log, "WARN") {
		t.Fatalf("err=%v log=%s", err, log)
	}
}

func TestCheckDataRootNotMountedFails(t *testing.T) {
	dir := t.TempDir()
	err, _ := checkWithLog(t, dir, probe(true, overlayRoot))
	if err == nil || !strings.Contains(err.Error(), "no está montado desde el host") || !strings.Contains(err.Error(), "-v "+dir+":"+dir) {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckDataRootMissingFails(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "no-existe")
	err, _ := checkWithLog(t, dir, probe(true, overlayRoot))
	if err == nil || !strings.Contains(err.Error(), "no existe") {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckDataRootNotWritableFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root escribe en cualquier directorio")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	err, _ := checkWithLog(t, dir, probe(true, overlayRoot+bindLine(dir, dir, "rw")))
	if err == nil || !strings.Contains(err.Error(), "no se puede escribir") {
		t.Fatalf("err = %v", err)
	}
}

// Montado, pero desde otra ruta del host (-v /data/mc:/srv/minecraft): los contenedores
// de los servidores verían otro directorio. mountinfo no da la ruta del host con certeza,
// así que solo se avisa.
func TestCheckDataRootDifferentHostPathWarns(t *testing.T) {
	dir := t.TempDir()
	err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine("/datos/otra-ruta", dir, "rw")))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(log, "WARN") || !strings.Contains(log, "misma ruta") {
		t.Fatalf("debe avisar: %s", log)
	}
}

func TestParseMountinfoUnescapes(t *testing.T) {
	ms := parseMountinfo([]byte(overlayRoot + bindLine(`/srv/mine\040craft`, `/srv/mine\040craft`, "rw")))
	if len(ms) != 3 || ms[2].mountPoint != "/srv/mine craft" || ms[2].root != "/srv/mine craft" || ms[0].mountPoint != "/" {
		t.Fatalf("mounts = %+v", ms)
	}
}
