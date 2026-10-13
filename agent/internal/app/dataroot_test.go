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

// probe builds a test sysProbe with a fixed mountinfo.
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
	p.mountinfo = func() ([]byte, error) { return nil, errors.New("must not be read") }
	if err, _ := checkWithLog(t, "/no/such", p); err != nil {
		t.Fatalf("outside a container DATA_ROOT is already a host path: %v", err)
	}
}

func TestCheckDataRootMirrorMountOK(t *testing.T) {
	dir := t.TempDir()
	err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine(dir, dir, "rw")))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(log, "WARN") {
		t.Fatalf("no warnings with a mirror mount: %s", log)
	}
}

func TestCheckDataRootParentMountOK(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "minecraft")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine(parent, parent, "rw"))); err != nil || strings.Contains(log, "WARN") {
		t.Fatalf("a mirror mount of a parent directory is also valid: %v %s", err, log)
	}
}

func TestCheckDataRootBtrfsSubvolumeOK(t *testing.T) {
	dir := t.TempDir()
	// On the host, /home is the @home subvolume: root carries the subvolume prefix.
	err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine("/@home"+dir, dir, "rw,subvol=/@home")))
	if err != nil || strings.Contains(log, "WARN") {
		t.Fatalf("err=%v log=%s", err, log)
	}
}

func TestCheckDataRootNotMountedFails(t *testing.T) {
	dir := t.TempDir()
	err, _ := checkWithLog(t, dir, probe(true, overlayRoot))
	if err == nil || !strings.Contains(err.Error(), "is not mounted from the host") || !strings.Contains(err.Error(), "-v "+dir+":"+dir) {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckDataRootMissingFails(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nonexistent")
	err, _ := checkWithLog(t, dir, probe(true, overlayRoot))
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckDataRootNotWritableFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes to any directory")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	err, _ := checkWithLog(t, dir, probe(true, overlayRoot+bindLine(dir, dir, "rw")))
	if err == nil || !strings.Contains(err.Error(), "cannot write") {
		t.Fatalf("err = %v", err)
	}
}

// Mounted, but from another host path (-v /data/mc:/srv/minecraft): the servers'
// containers would see a different directory. mountinfo does not give the host path with certainty,
// so it only warns.
func TestCheckDataRootDifferentHostPathWarns(t *testing.T) {
	dir := t.TempDir()
	err, log := checkWithLog(t, dir, probe(true, overlayRoot+bindLine("/data/other-path", dir, "rw")))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(log, "WARN") || !strings.Contains(log, "same path") {
		t.Fatalf("it must warn: %s", log)
	}
}

func TestParseMountinfoUnescapes(t *testing.T) {
	ms := parseMountinfo([]byte(overlayRoot + bindLine(`/srv/mine\040craft`, `/srv/mine\040craft`, "rw")))
	if len(ms) != 3 || ms[2].mountPoint != "/srv/mine craft" || ms[2].root != "/srv/mine craft" || ms[0].mountPoint != "/" {
		t.Fatalf("mounts = %+v", ms)
	}
}
