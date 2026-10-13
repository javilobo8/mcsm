package spec

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// Import (plan-6, spec §6.7): data folder of an imported server and adoption.

// MaxDataPath is the maximum length of dataPath in bytes (DATA_PATH_MAX_BYTES in the panel).
const MaxDataPath = 1024

// dataPathSegRe: each segment of dataPath, ASCII only (letters, digits, space and . _ @ + -). Without
// ":" (it would break the src:/data bind), "," or "\". Same rule in zod (fixture data-path-cases.json).
var dataPathSegRe = regexp.MustCompile(`^[A-Za-z0-9._@+ -]+$`)

// DeniedDataPaths are system areas that are never mounted at /data: the agent runs as root
// and itzg's entrypoint does chown -R on /data. They are compared by segments (/etcetera is fine).
var DeniedDataPaths = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run",
	"/sbin", "/sys", "/usr", "/var/lib/docker", "/var/run",
}

// adoptIDRe: full id of the container to adopt (64 hex, like DOCKER_ID_RE in the panel). A name or
// a prefix is not valid: Docker would resolve them, perhaps to another container.
var adoptIDRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Adopt is added by the panel to the spec it sends for an imported server; it is never stored in the
// panel's spec. ContainerID is the original container and Version the spec version it
// was adopted with: the agent does not recreate it until the spec exceeds it.
type Adopt struct {
	ContainerID string `json:"containerId"`
	Version     uint64 `json:"version"`
}

// pathWithin reports whether child is parent or hangs under it (clean absolute paths).
func pathWithin(child, parent string) bool {
	if parent == "/" {
		return strings.HasPrefix(child, "/")
	}
	return child == parent || strings.HasPrefix(child, parent+"/")
}

// ValidateDataPath validates dataPath without knowing DATA_ROOT ("" = no dataPath). The relation with
// DATA_ROOT is checked by BuildContainer.
func ValidateDataPath(p string) error {
	if p == "" {
		return nil
	}
	if len(p) > MaxDataPath {
		return fmt.Errorf("spec: dataPath too long (max. %d bytes)", MaxDataPath)
	}
	if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("spec: dataPath must be an absolute path: %q", p)
	}
	segs := strings.Split(p[1:], "/")
	if len(segs) < 2 {
		return fmt.Errorf("spec: dataPath %q is too general: give at least two levels", p)
	}
	for _, s := range segs {
		if s == "" || s == "." || s == ".." {
			return fmt.Errorf("spec: dataPath %q is not normalized (no //, \".\" or \"..\", no trailing /)", p)
		}
		if !dataPathSegRe.MatchString(s) {
			return fmt.Errorf("spec: dataPath %q has unsupported characters (ASCII letters and digits, space and . _ @ + -)", p)
		}
	}
	for _, d := range DeniedDataPaths {
		if pathWithin(p, d) {
			return fmt.Errorf("spec: dataPath %q is in a system area (%s): it is not mounted", p, d)
		}
	}
	return nil
}

// IsItzgImage reports whether ref is itzg/minecraft-server (with or without docker.io/, with a tag or digest).
func IsItzgImage(ref string) bool {
	rest, ok := strings.CutPrefix(strings.TrimPrefix(ref, "docker.io/"), Image)
	return ok && (rest == "" || rest[0] == ':' || rest[0] == '@')
}

// validateImport validates dataPath and adopt. With dataPath there are no scheduled backups: the agent does not see
// that folder (it only mounts DATA_ROOT). Same criterion as dataPathCheck in the panel.
func (s Spec) validateImport() error {
	if err := ValidateDataPath(s.DataPath); err != nil {
		return err
	}
	if s.DataPath != "" && s.Backups != nil && s.Backups.Enabled {
		return fmt.Errorf("spec: scheduled backups are not available with dataPath: the agent does not see that folder (it only mounts DATA_ROOT)")
	}
	if a := s.Adopt; a != nil {
		if !adoptIDRe.MatchString(a.ContainerID) {
			return fmt.Errorf("spec: invalid adopt.containerId %q", a.ContainerID)
		}
		if a.Version == 0 {
			return fmt.Errorf("spec: adopt.version must be at least 1")
		}
	}
	return nil
}

// dataDir is the host folder mounted at /data: dataPath if there is one (outside DATA_ROOT and not
// containing it: it never overlaps the managed servers' data) or <dataRoot>/<slug>/data.
func (s Spec) dataDir(slug, dataRoot string) (string, error) {
	if s.DataPath == "" {
		return filepath.Join(dataRoot, slug, "data"), nil
	}
	root := filepath.Clean(dataRoot)
	if pathWithin(s.DataPath, root) || pathWithin(root, s.DataPath) {
		return "", fmt.Errorf("spec: dataPath %q cannot be inside DATA_ROOT (%s) or contain it", s.DataPath, root)
	}
	return s.DataPath, nil
}
