package app

import (
	"bufio"
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"path"
	"strconv"
	"strings"
)

// sysProbe is what the DATA_ROOT check queries from the system (injectable in tests).
type sysProbe struct {
	inContainer func() bool
	mountinfo   func() ([]byte, error)
}

var hostProbe = sysProbe{
	inContainer: func() bool {
		for _, f := range []string{"/.dockerenv", "/run/.containerenv"} {
			if _, err := os.Stat(f); err == nil {
				return true
			}
		}
		return false
	},
	mountinfo: func() ([]byte, error) { return os.ReadFile("/proc/self/mountinfo") },
}

type mountEntry struct {
	root       string // path inside the source filesystem
	mountPoint string
	superOpts  string
}

// parseMountinfo reads /proc/self/mountinfo (proc(5)): fields 4 (root) and 5 (mount
// point), and the superblock options after the "-" separator.
func parseMountinfo(b []byte) []mountEntry {
	var out []mountEntry
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 5 {
			continue
		}
		m := mountEntry{root: unescapeMount(f[3]), mountPoint: unescapeMount(f[4])}
		for i := 5; i < len(f); i++ {
			if f[i] == "-" && i+3 < len(f) {
				m.superOpts = f[i+3]
				break
			}
		}
		out = append(out, m)
	}
	return out
}

// unescapeMount undoes mountinfo's octal escapes (\040 space, \011 tab…).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// within reports whether p is dir or is inside dir.
func within(p, dir string) bool {
	return dir == "/" || p == dir || strings.HasPrefix(p, dir+"/")
}

// checkDataRoot checks the spec §6.1 requirement: inside a container, DATA_ROOT
// must be a host mount with the same path. Otherwise, the agent would read and write
// <DATA_ROOT>/<slug> in its own container while the servers use the host's
// (empty backups, empty file trees), without any error. It fails if DATA_ROOT does not
// exist, cannot be written or is not mounted from the host; it warns if the mount
// seems to come from another host path (mountinfo cannot guarantee it).
func checkDataRoot(dataRoot string, p sysProbe, log *slog.Logger) error {
	if !p.inContainer() {
		log.Info("the agent is not running in a container: DATA_ROOT is a host path", "data_root", dataRoot)
		return nil
	}
	mountHint := fmt.Sprintf("mount it at the same path inside and outside: -v %s:%s", dataRoot, dataRoot)
	st, err := os.Stat(dataRoot)
	if err != nil {
		return fmt.Errorf("DATA_ROOT %s does not exist inside the agent's container: %s", dataRoot, mountHint)
	}
	if !st.IsDir() {
		return fmt.Errorf("DATA_ROOT %s is not a directory", dataRoot)
	}
	f, err := os.CreateTemp(dataRoot, ".mcsm-write-check-*")
	if err != nil {
		return fmt.Errorf("cannot write to DATA_ROOT %s: %w", dataRoot, err)
	}
	f.Close()
	_ = os.Remove(f.Name())

	raw, err := p.mountinfo()
	if err != nil {
		return fmt.Errorf("read /proc/self/mountinfo to check DATA_ROOT: %w", err)
	}
	var best *mountEntry
	for _, m := range parseMountinfo(raw) {
		if within(dataRoot, m.mountPoint) && (best == nil || len(m.mountPoint) > len(best.mountPoint)) {
			best = &m
		}
	}
	if best == nil || best.mountPoint == "/" {
		return fmt.Errorf("DATA_ROOT %s is not mounted from the host (it is inside the agent's container): %s", dataRoot, mountHint)
	}

	// Path of the directory inside the source filesystem. On btrfs, root carries the mounted
	// subvolume in front (subvol=/@home → root /@home/...): it is removed.
	root := best.root
	for _, opt := range strings.Split(best.superOpts, ",") {
		if sub, ok := strings.CutPrefix(opt, "subvol="); ok && sub != "/" && within(root, sub) {
			root = "/" + strings.TrimPrefix(strings.TrimPrefix(root, sub), "/")
		}
	}
	rel := path.Join(root, strings.TrimPrefix(dataRoot, best.mountPoint))
	// The path on the host is <where the source is mounted>/<rel>: with a mirror mount,
	// DATA_ROOT ends in rel. If rel is "/" nothing can be known.
	if rel != "/" && dataRoot != rel && !strings.HasSuffix(dataRoot, rel) {
		log.Warn("DATA_ROOT seems to be mounted from another host path: the servers would see a different directory than the agent; use the same path inside and outside",
			"data_root", dataRoot, "source", rel, "mount", best.mountPoint)
	}
	return nil
}
