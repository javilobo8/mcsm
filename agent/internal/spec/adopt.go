package spec

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// Importación (plan-6, spec §6.7): carpeta de datos de un servidor importado y adopción.

// MaxDataPath es la longitud máxima de dataPath en bytes (DATA_PATH_MAX_BYTES en el panel).
const MaxDataPath = 1024

// dataPathSegRe: cada tramo de dataPath, solo ASCII (letras, números, espacio y . _ @ + -). Sin
// ":" (rompería el bind src:/data), "," ni "\". Misma regla en zod (fixture data-path-cases.json).
var dataPathSegRe = regexp.MustCompile(`^[A-Za-z0-9._@+ -]+$`)

// DeniedDataPaths son zonas del sistema que nunca se montan en /data: el agente corre como root
// y el entrypoint de itzg hace chown -R de /data. Se comparan por tramos (/etcetera sí vale).
var DeniedDataPaths = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run",
	"/sbin", "/sys", "/usr", "/var/lib/docker", "/var/run",
}

// adoptIDRe: id del contenedor a adoptar. El panel envía ids completos (64 hex); se admite
// cualquier id alfanumérico corto para los del fake de Docker en los tests.
var adoptIDRe = regexp.MustCompile(`^[0-9A-Za-z]{1,64}$`)

// Adopt lo añade el panel a la spec que envía de un servidor importado; nunca se guarda en la
// spec del panel. ContainerID es el contenedor original y Version la versión de la spec con la
// que se adoptó: el agente no lo recrea mientras la spec no la supere.
type Adopt struct {
	ContainerID string `json:"containerId"`
	Version     uint64 `json:"version"`
}

// pathWithin indica si child es parent o cuelga de él (rutas absolutas limpias).
func pathWithin(child, parent string) bool {
	if parent == "/" {
		return strings.HasPrefix(child, "/")
	}
	return child == parent || strings.HasPrefix(child, parent+"/")
}

// ValidateDataPath valida dataPath sin conocer DATA_ROOT ("" = sin dataPath). La relación con
// DATA_ROOT la comprueba BuildContainer.
func ValidateDataPath(p string) error {
	if p == "" {
		return nil
	}
	if len(p) > MaxDataPath {
		return fmt.Errorf("spec: dataPath demasiado largo (máx. %d bytes)", MaxDataPath)
	}
	if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("spec: dataPath debe ser una ruta absoluta: %q", p)
	}
	segs := strings.Split(p[1:], "/")
	if len(segs) < 2 {
		return fmt.Errorf("spec: dataPath %q es demasiado general: indica al menos dos niveles", p)
	}
	for _, s := range segs {
		if s == "" || s == "." || s == ".." {
			return fmt.Errorf("spec: dataPath %q no está normalizada (sin //, «.» ni «..», sin / al final)", p)
		}
		if !dataPathSegRe.MatchString(s) {
			return fmt.Errorf("spec: dataPath %q tiene caracteres no admitidos (letras y números ASCII, espacio y . _ @ + -)", p)
		}
	}
	for _, d := range DeniedDataPaths {
		if pathWithin(p, d) {
			return fmt.Errorf("spec: dataPath %q está en una zona del sistema (%s): no se monta", p, d)
		}
	}
	return nil
}

// IsItzgImage indica si ref es itzg/minecraft-server (con o sin docker.io/, con etiqueta o digest).
func IsItzgImage(ref string) bool {
	rest, ok := strings.CutPrefix(strings.TrimPrefix(ref, "docker.io/"), Image)
	return ok && (rest == "" || rest[0] == ':' || rest[0] == '@')
}

// validateImport valida dataPath y adopt. Con dataPath no hay copias programadas: el agente no ve
// esa carpeta (solo monta DATA_ROOT). Mismo criterio que dataPathCheck en el panel.
func (s Spec) validateImport() error {
	if err := ValidateDataPath(s.DataPath); err != nil {
		return err
	}
	if s.DataPath != "" && s.Backups != nil && s.Backups.Enabled {
		return fmt.Errorf("spec: las copias programadas no están disponibles con dataPath: el agente no ve esa carpeta (solo monta DATA_ROOT)")
	}
	if a := s.Adopt; a != nil {
		if !adoptIDRe.MatchString(a.ContainerID) {
			return fmt.Errorf("spec: adopt.containerId inválido %q", a.ContainerID)
		}
		if a.Version == 0 {
			return fmt.Errorf("spec: adopt.version debe ser al menos 1")
		}
	}
	return nil
}

// dataDir es la carpeta del host montada en /data: dataPath si lo hay (fuera de DATA_ROOT y sin
// contenerlo: nunca solapa los datos de los servidores gestionados) o <dataRoot>/<slug>/data.
func (s Spec) dataDir(slug, dataRoot string) (string, error) {
	if s.DataPath == "" {
		return filepath.Join(dataRoot, slug, "data"), nil
	}
	root := filepath.Clean(dataRoot)
	if pathWithin(s.DataPath, root) || pathWithin(root, s.DataPath) {
		return "", fmt.Errorf("spec: dataPath %q no puede estar dentro de DATA_ROOT (%s) ni contenerlo", s.DataPath, root)
	}
	return s.DataPath, nil
}
