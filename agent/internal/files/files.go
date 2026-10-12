// Package files implementa las operaciones de archivos de un servidor confinadas a
// su directorio de datos (spec §6.6).
//
// Cada ruta pasa por tres barreras:
//  1. Clean: validación léxica; ".." y caracteres de control se rechazan, nunca se "arreglan".
//  2. resolve: filepath.EvalSymlinks + comprobación de prefijo con separador sobre la raíz real.
//  3. La E/S se hace con os.Root (openat sin seguir enlaces que salgan de la raíz): si un enlace
//     se cambia entre la comprobación y el uso (TOCTOU), la operación falla en vez de escapar.
package files

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/spec"
)

// InlineMax es el máximo de lectura/escritura inline por el WebSocket (spec §6.6).
const InlineMax = 2 << 20

// maxEntries limita un listado; el resto se marca como truncado. Variable para los tests.
var maxEntries = 5000

// tmpPrefix empieza el nombre de los temporales de las escrituras atómicas (ver TempGlob).
const tmpPrefix = ".mcsm-tmp-"

// TempGlob casa (path.Match) exactamente con el nombre de un temporal de una escritura
// atómica: tmpPrefix y 16 hexadecimales en minúscula (randHex). Esos se ocultan en los
// listados, las copias de seguridad los excluyen siempre (backup.Excluder) y SweepTemps barre
// los huérfanos. Un fichero del usuario que solo empiece igual («.mcsm-tmp-notas») es un
// fichero más: se ve, se copia y no se barre.
const TempGlob = tmpPrefix + "[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]" +
	"[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"

// IsTempName indica si name (un nombre, sin carpetas) es el de un temporal de una escritura
// atómica (TempGlob).
func IsTempName(name string) bool {
	ok, _ := path.Match(TempGlob, name)
	return ok
}

var (
	ErrInvalidPath   = errors.New("ruta inválida")
	ErrOutside       = errors.New("la ruta sale del directorio del servidor")
	ErrUnknownServer = errors.New("servidor desconocido en este nodo")
	ErrNotFound      = errors.New("no existe")
	ErrExists        = errors.New("ya existe")
	ErrIsDir         = errors.New("es una carpeta")
	ErrNotDir        = errors.New("no es una carpeta")
	ErrTooLarge      = errors.New("demasiado grande para abrirlo en línea (máx. 2 MiB): descárgalo")
	ErrRoot          = errors.New("no se puede modificar la carpeta raíz del servidor")
	ErrTransfer      = errors.New("transferencia fallida")
)

// Code traduce un error a su código de protocolo (Error.code).
func Code(err error) string {
	switch {
	case errors.Is(err, ErrInvalidPath):
		return errcode.InvalidPath
	case errors.Is(err, ErrOutside):
		return errcode.PathOutside
	case errors.Is(err, ErrUnknownServer):
		return errcode.UnknownServer
	case errors.Is(err, ErrNotFound):
		return errcode.NotFound
	case errors.Is(err, ErrExists):
		return errcode.Exists
	case errors.Is(err, ErrIsDir):
		return errcode.IsDir
	case errors.Is(err, ErrNotDir):
		return errcode.NotDir
	case errors.Is(err, ErrTooLarge):
		return errcode.TooLarge
	case errors.Is(err, ErrRoot):
		return errcode.Root
	case errors.Is(err, ErrTransfer):
		return errcode.TransferFailed
	default:
		return errcode.IOError
	}
}

// Entry describe un fichero o carpeta.
type Entry struct {
	Name    string
	Dir     bool
	Symlink bool
	Size    int64
	ModTime time.Time
	Mode    fs.FileMode // solo bits de permisos
}

// Root devuelve el directorio de datos de un servidor: <dataRoot>/<slug>/data.
func Root(dataRoot, slug string) (string, error) {
	if !spec.ValidSlug(slug) {
		return "", fmt.Errorf("%w: slug %q", ErrInvalidPath, slug)
	}
	return filepath.Join(filepath.Clean(dataRoot), slug, "data"), nil
}

// FS opera dentro de una raíz.
type FS struct {
	root string
	// afterCheck se invoca entre la comprobación de una ruta y su uso. Solo para tests (TOCTOU).
	afterCheck func()
}

// New crea un FS confinado a root (normalmente el resultado de Root).
func New(root string) *FS { return &FS{root: filepath.Clean(root)} }

// Clean valida una ruta del panel ("/", "mods/a.jar", "/config/x.yml") y la devuelve relativa
// a la raíz, con "/" como separador ("." es la raíz).
func Clean(p string) (string, error) {
	if len(p) > 4096 {
		return "", fmt.Errorf("%w: demasiado larga", ErrInvalidPath)
	}
	parts := make([]string, 0, 8)
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".":
			continue
		case "..":
			return "", fmt.Errorf("%w: no se permite «..»", ErrInvalidPath)
		}
		for _, r := range seg {
			if r < 0x20 || r == 0x7f {
				return "", fmt.Errorf("%w: contiene caracteres de control", ErrInvalidPath)
			}
		}
		parts = append(parts, seg)
	}
	if len(parts) == 0 {
		return ".", nil
	}
	return strings.Join(parts, "/"), nil
}

// display es la ruta tal y como la ve el usuario ("/" + relativa).
func display(rel string) string {
	if rel == "." {
		return "/"
	}
	return "/" + rel
}

// within comprueba que p es root o cuelga de root. El separador evita que /x/data2
// pase por estar "dentro" de /x/data.
func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// realRoot resuelve los enlaces de la propia raíz (DATA_ROOT puede ser un enlace).
func (f *FS) realRoot() (string, error) {
	r, err := filepath.EvalSymlinks(f.root)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("%w: la carpeta de datos del servidor aún no existe (arráncalo una vez)", ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("error de E/S en la carpeta de datos: %v", errors.Unwrap(err))
	}
	return r, nil
}

// resolve aplica la spec §6.6 a una ruta limpia: EvalSymlinks y prefijo. Devuelve la ruta real
// relativa a la raíz real (siguiendo los enlaces que quedan dentro).
func (f *FS) resolve(rel string) (string, error) {
	root, err := f.realRoot()
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
			// Si un componente intermedio sale de la raíz se informa como tal, no como
			// "no existe": no se revela qué hay fuera.
			if rel != "." {
				if _, perr := f.resolve(path.Dir(rel)); errors.Is(perr, ErrOutside) {
					return "", perr
				}
			}
			return "", fmt.Errorf("%w: %s", ErrNotFound, display(rel))
		}
		if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENAMETOOLONG) {
			return "", fmt.Errorf("%w: %s", ErrInvalidPath, display(rel))
		}
		// EACCES y demás: fallo de E/S del host, no una ruta mala del usuario.
		return "", mapErr(err, rel)
	}
	if !within(root, real) {
		return "", fmt.Errorf("%w: %s", ErrOutside, display(rel))
	}
	out, err := filepath.Rel(root, real)
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrOutside, display(rel))
	}
	return filepath.ToSlash(out), nil
}

// resolveEntry resuelve la carpeta padre (siguiendo enlaces) y conserva el último componente
// sin seguirlo: borrar o renombrar un enlace actúa sobre el enlace, nunca sobre su destino.
func (f *FS) resolveEntry(rel string) (string, error) {
	if rel == "." {
		return "", ErrRoot
	}
	parent, err := f.resolve(path.Dir(rel))
	if err != nil {
		return "", err
	}
	return path.Join(parent, path.Base(rel)), nil
}

// open abre la raíz real como os.Root. Se abre en cada operación: una restauración de backup
// renombra la carpeta y un descriptor guardado apuntaría a la antigua.
func (f *FS) open() (*os.Root, error) {
	if f.afterCheck != nil {
		f.afterCheck()
	}
	root, err := f.realRoot()
	if err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("error de E/S en la carpeta de datos: %v", errors.Unwrap(err))
	}
	return r, nil
}

// La stdlib no exporta errPathEscapes (os/file.go): no hay forma tipada de reconocerlo y se compara
// el texto; TestTOCTOUSwapToSymlinkIsRefused falla si cambia.
// isEscape detecta el error de os.Root cuando una ruta sale de la raíz.
func isEscape(err error) bool {
	var pe *fs.PathError
	if errors.As(err, &pe) && pe.Err != nil && pe.Err.Error() == "path escapes from parent" {
		return true
	}
	var le *os.LinkError
	return errors.As(err, &le) && le.Err != nil && le.Err.Error() == "path escapes from parent"
}

// mapErr traduce errores de os.Root a los errores del paquete, sin rutas absolutas del host.
func mapErr(err error, rel string) error {
	if err == nil {
		return nil
	}
	d := display(rel)
	switch {
	case isEscape(err):
		return fmt.Errorf("%w: %s", ErrOutside, d)
	case errors.Is(err, fs.ErrNotExist):
		return fmt.Errorf("%w: %s", ErrNotFound, d)
	case errors.Is(err, fs.ErrExist):
		return fmt.Errorf("%w: %s", ErrExists, d)
	case errors.Is(err, syscall.ENOTDIR):
		return fmt.Errorf("%w: %s", ErrNotDir, d)
	case errors.Is(err, syscall.EISDIR):
		return fmt.Errorf("%w: %s", ErrIsDir, d)
	case errors.Is(err, syscall.EINVAL):
		return fmt.Errorf("%w: %s", ErrInvalidPath, d)
	}
	cause := err
	var pe *fs.PathError
	var le *os.LinkError
	if errors.As(err, &pe) {
		cause = pe.Err
	} else if errors.As(err, &le) {
		cause = le.Err
	}
	return fmt.Errorf("error de E/S en %s: %v", d, cause)
}

func entryOf(name string, info fs.FileInfo) Entry {
	return Entry{
		Name: name, Dir: info.IsDir(), Symlink: info.Mode()&fs.ModeSymlink != 0,
		Size: info.Size(), ModTime: info.ModTime(), Mode: info.Mode().Perm(),
	}
}

// List devuelve el contenido de una carpeta: carpetas primero y luego por nombre. Los enlaces
// que apuntan dentro de la raíz se describen por su destino; los que salen, como enlaces.
func (f *FS) List(p string) ([]Entry, bool, error) {
	rel, err := Clean(p)
	if err != nil {
		return nil, false, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return nil, false, err
	}
	r, err := f.open()
	if err != nil {
		return nil, false, err
	}
	defer r.Close()
	d, err := r.Open(real)
	if err != nil {
		return nil, false, mapErr(err, rel)
	}
	defer d.Close()
	st, err := d.Stat()
	if err != nil {
		return nil, false, mapErr(err, rel)
	}
	if !st.IsDir() {
		return nil, false, fmt.Errorf("%w: %s", ErrNotDir, display(rel))
	}
	des, err := d.ReadDir(maxEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, false, mapErr(err, rel)
	}
	truncated := len(des) > maxEntries
	if truncated {
		des = des[:maxEntries]
	}
	out := make([]Entry, 0, len(des))
	for _, de := range des {
		if IsTempName(de.Name()) {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue // borrado entre ReadDir e Info
		}
		e := entryOf(de.Name(), info)
		if e.Symlink {
			if target, err := r.Stat(path.Join(real, de.Name())); err == nil {
				e.Dir, e.Size, e.ModTime = target.IsDir(), target.Size(), target.ModTime()
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, truncated, nil
}

// Stat describe una ruta siguiendo los enlaces que quedan dentro de la raíz.
func (f *FS) Stat(p string) (Entry, error) {
	rel, err := Clean(p)
	if err != nil {
		return Entry{}, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return Entry{}, err
	}
	r, err := f.open()
	if err != nil {
		return Entry{}, err
	}
	defer r.Close()
	info, err := r.Stat(real)
	if err != nil {
		return Entry{}, mapErr(err, rel)
	}
	return entryOf(path.Base(display(rel)), info), nil
}

// openRegular abre solo ficheros regulares. O_NONBLOCK evita quedarse bloqueado al abrir una
// FIFO que alguien haya creado dentro de /data; en un fichero regular no tiene efecto.
func openRegular(r *os.Root, real, rel string) (*os.File, fs.FileInfo, error) {
	fh, err := r.OpenFile(real, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, mapErr(err, rel)
	}
	info, err := fh.Stat()
	if err != nil {
		fh.Close()
		return nil, nil, mapErr(err, rel)
	}
	if info.IsDir() {
		fh.Close()
		return nil, nil, fmt.Errorf("%w: %s", ErrIsDir, display(rel))
	}
	if !info.Mode().IsRegular() {
		fh.Close()
		return nil, nil, fmt.Errorf("%w: %s no es un fichero normal", ErrInvalidPath, display(rel))
	}
	return fh, info, nil
}

// Read lee un fichero entero si no supera max (o InlineMax si max <= 0 o es mayor).
func (f *FS) Read(p string, max int64) ([]byte, int64, error) {
	if max <= 0 || max > InlineMax {
		max = InlineMax
	}
	rel, err := Clean(p)
	if err != nil {
		return nil, 0, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return nil, 0, err
	}
	r, err := f.open()
	if err != nil {
		return nil, 0, err
	}
	defer r.Close()
	fh, info, err := openRegular(r, real, rel)
	if err != nil {
		return nil, 0, err
	}
	defer fh.Close()
	if info.Size() > max {
		return nil, info.Size(), fmt.Errorf("%w: %s ocupa %d bytes", ErrTooLarge, display(rel), info.Size())
	}
	data, err := io.ReadAll(io.LimitReader(fh, max+1))
	if err != nil {
		return nil, 0, mapErr(err, rel)
	}
	if int64(len(data)) > max { // creció mientras se leía
		return nil, int64(len(data)), fmt.Errorf("%w: %s", ErrTooLarge, display(rel))
	}
	return data, info.Size(), nil
}

// Open abre un fichero regular para descargarlo en streaming. El llamante lo cierra.
func (f *FS) Open(p string) (*os.File, Entry, error) {
	rel, err := Clean(p)
	if err != nil {
		return nil, Entry{}, err
	}
	real, err := f.resolve(rel)
	if err != nil {
		return nil, Entry{}, err
	}
	r, err := f.open()
	if err != nil {
		return nil, Entry{}, err
	}
	defer r.Close() // el fichero abierto sigue siendo válido tras cerrar la raíz
	fh, info, err := openRegular(r, real, rel)
	if err != nil {
		return nil, Entry{}, err
	}
	return fh, entryOf(path.Base(rel), info), nil
}
