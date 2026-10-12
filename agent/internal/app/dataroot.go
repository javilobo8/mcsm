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

// sysProbe es lo que la comprobación de DATA_ROOT consulta del sistema (inyectable en tests).
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
	root       string // ruta dentro del sistema de ficheros de origen
	mountPoint string
	superOpts  string
}

// parseMountinfo lee /proc/self/mountinfo (proc(5)): campos 4 (root) y 5 (punto de
// montaje), y las opciones del superbloque tras el separador "-".
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

// unescapeMount deshace los escapes octales de mountinfo (\040 espacio, \011 tab…).
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

// within indica si p es dir o está dentro de dir.
func within(p, dir string) bool {
	return dir == "/" || p == dir || strings.HasPrefix(p, dir+"/")
}

// checkDataRoot comprueba el requisito de spec §6.1: dentro de un contenedor, DATA_ROOT
// debe ser un montaje del host con la misma ruta. Si no, el agente leería y escribiría
// <DATA_ROOT>/<slug> en su propio contenedor mientras los servidores usan el del host
// (copias vacías, árboles de archivos vacíos), sin ningún error. Falla si DATA_ROOT no
// existe, no se puede escribir o no está montado desde el host; avisa si el montaje
// parece venir de otra ruta del host (mountinfo no permite asegurarlo).
func checkDataRoot(dataRoot string, p sysProbe, log *slog.Logger) error {
	if !p.inContainer() {
		log.Info("el agente no corre en un contenedor: DATA_ROOT es una ruta del host", "data_root", dataRoot)
		return nil
	}
	mountHint := fmt.Sprintf("móntalo con la misma ruta dentro y fuera: -v %s:%s", dataRoot, dataRoot)
	st, err := os.Stat(dataRoot)
	if err != nil {
		return fmt.Errorf("DATA_ROOT %s no existe dentro del contenedor del agente: %s", dataRoot, mountHint)
	}
	if !st.IsDir() {
		return fmt.Errorf("DATA_ROOT %s no es un directorio", dataRoot)
	}
	f, err := os.CreateTemp(dataRoot, ".mcsm-write-check-*")
	if err != nil {
		return fmt.Errorf("no se puede escribir en DATA_ROOT %s: %w", dataRoot, err)
	}
	f.Close()
	_ = os.Remove(f.Name())

	raw, err := p.mountinfo()
	if err != nil {
		return fmt.Errorf("leer /proc/self/mountinfo para comprobar DATA_ROOT: %w", err)
	}
	var best *mountEntry
	for _, m := range parseMountinfo(raw) {
		if within(dataRoot, m.mountPoint) && (best == nil || len(m.mountPoint) > len(best.mountPoint)) {
			best = &m
		}
	}
	if best == nil || best.mountPoint == "/" {
		return fmt.Errorf("DATA_ROOT %s no está montado desde el host (está dentro del contenedor del agente): %s", dataRoot, mountHint)
	}

	// Ruta del directorio dentro del sistema de ficheros de origen. En btrfs, root lleva
	// delante el subvolumen montado (subvol=/@home → root /@home/...): se quita.
	root := best.root
	for _, opt := range strings.Split(best.superOpts, ",") {
		if sub, ok := strings.CutPrefix(opt, "subvol="); ok && sub != "/" && within(root, sub) {
			root = "/" + strings.TrimPrefix(strings.TrimPrefix(root, sub), "/")
		}
	}
	rel := path.Join(root, strings.TrimPrefix(dataRoot, best.mountPoint))
	// La ruta en el host es <donde está montado el origen>/<rel>: con un montaje espejo,
	// DATA_ROOT termina en rel. Si rel es "/" no se puede saber nada.
	if rel != "/" && dataRoot != rel && !strings.HasSuffix(dataRoot, rel) {
		log.Warn("DATA_ROOT parece montado desde otra ruta del host: los servidores verían otro directorio que el agente; usa la misma ruta dentro y fuera",
			"data_root", dataRoot, "origen", rel, "montaje", best.mountPoint)
	}
	return nil
}
