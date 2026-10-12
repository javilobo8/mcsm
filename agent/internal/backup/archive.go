// Package backup crea, lista, poda y restaura copias de los datos de un servidor (spec §6.5).
package backup

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/klauspost/compress/zstd"
)

// Excluder decide qué rutas no entran en la copia. Las rutas son relativas a la raíz de
// datos y usan `/`. Un patrón sin `/` se compara con el nombre a cualquier profundidad
// ("logs", "*.tmp"); uno con `/`, con la ruta relativa completa ("world/session.lock").
// Un directorio excluido se salta entero.
type Excluder struct{ base, full []string }

// NewExcluder valida los patrones (sintaxis de path.Match).
func NewExcluder(patterns []string) (*Excluder, error) {
	e := &Excluder{}
	for _, p := range patterns {
		p = strings.Trim(p, "/")
		if p == "" {
			continue
		}
		if _, err := path.Match(p, ""); err != nil {
			return nil, fmt.Errorf("patrón de exclusión inválido %q: %w", p, err)
		}
		if strings.Contains(p, "/") {
			e.full = append(e.full, p)
		} else {
			e.base = append(e.base, p)
		}
	}
	return e, nil
}

// Excluded indica si la ruta relativa rel queda fuera de la copia.
func (e *Excluder) Excluded(rel string) bool {
	if e == nil {
		return false
	}
	name := path.Base(rel)
	for _, p := range e.base {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	for _, p := range e.full {
		if ok, _ := path.Match(p, rel); ok {
			return true
		}
	}
	return false
}

// ArchiveStats resume una copia.
type ArchiveStats struct {
	Files    int
	Bytes    int64    // contenido sin comprimir
	Warnings []string // entradas omitidas o que cambiaron durante la copia
}

// ProgressFunc recibe los bytes de contenido copiados y el total previsto.
type ProgressFunc func(done, total int64)

// entry es una entrada del escaneo. info (Lstat) fija el tipo, tamaño, permisos y
// propietario de la cabecera aunque el fichero cambie después.
type entry struct {
	rel  string // relativa a la raíz, con `/`
	info fs.FileInfo
	link string // destino, si es un enlace simbólico
}

// copyBufSize es el búfer de copia de contenido (lectura y extracción).
const copyBufSize = 1 << 20

// WriteArchive escribe el contenido de src (sin el propio directorio) como tar comprimido
// con zstd. No sigue enlaces simbólicos: los guarda como enlace. Todo se lee a través de
// un os.Root abierto en src: aunque un proceso del contenedor cambie un directorio por un
// enlace a mitad de copia, el agente (root) nunca lee nada de fuera de los datos. Un
// fichero que crece durante la copia se trunca a su tamaño inicial, uno que encoge se
// rellena con ceros y uno que desaparece se omite (quedan en Warnings): la copia no se
// aborta porque un log se escriba a la vez. El sha256 lo calcula el llamante en vuelo
// envolviendo w (io.MultiWriter). Si falla o se cancela, NO cierra el tar ni la trama
// zstd: lo escrito queda truncado e ilegible para ExtractArchive en vez de pasar por una
// copia completa.
func WriteArchive(ctx context.Context, src string, w io.Writer, excl *Excluder, progress ProgressFunc) (ArchiveStats, error) {
	var st ArchiveStats
	if err := ctx.Err(); err != nil {
		return st, err
	}
	root, err := os.OpenRoot(src)
	if err != nil {
		return st, err
	}
	defer root.Close()
	entries, total, err := scan(ctx, root, excl, &st)
	if err != nil {
		return st, err
	}
	// Compresión síncrona en un solo hilo: ninguna goroutine sigue escribiendo en w si
	// esto falla, y no roba CPU a los servidores que corren en el nodo.
	enc, err := zstd.NewWriter(w, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(1))
	if err != nil {
		return st, err
	}
	tw := tar.NewWriter(enc)
	buf := make([]byte, copyBufSize)
	var done int64
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return st, err
		}
		n, skipped, warn, err := writeEntry(ctx, tw, root, e, buf)
		if err != nil {
			return st, fmt.Errorf("%s: %w", e.rel, err)
		}
		if warn != "" {
			st.Warnings = append(st.Warnings, warn)
		}
		if e.info.Mode().IsRegular() && !skipped {
			st.Files++
		}
		done += n
		if progress != nil {
			progress(done, total)
		}
	}
	if err := tw.Close(); err != nil {
		return st, err
	}
	if err := enc.Close(); err != nil {
		return st, err
	}
	st.Bytes = done
	return st, nil
}

// scan recorre la raíz en orden léxico (cada directorio antes que su contenido) aplicando
// las exclusiones; devuelve las entradas y el tamaño total de los ficheros regulares.
func scan(ctx context.Context, root *os.Root, excl *Excluder, st *ArchiveStats) ([]entry, int64, error) {
	var out []entry
	var total int64
	var walk func(dir string, want fs.FileInfo) error
	walk = func(dir string, want fs.FileInfo) error {
		des, changed, err := readDirIn(root, dir, want)
		if err != nil {
			return err
		}
		if changed {
			st.Warnings = append(st.Warnings, "omitido el contenido de "+dir+" (dejó de ser el mismo directorio durante la copia)")
			return nil
		}
		for _, d := range des {
			if err := ctx.Err(); err != nil {
				return err
			}
			rel := d.Name()
			if dir != "." {
				rel = dir + "/" + rel
			}
			if excl.Excluded(rel) {
				continue
			}
			info, err := d.Info()
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			e := entry{rel: rel, info: info}
			switch {
			case info.Mode()&fs.ModeSymlink != 0:
				if e.link, err = root.Readlink(rel); err != nil {
					if errors.Is(err, fs.ErrNotExist) {
						continue
					}
					return err
				}
				out = append(out, e)
			case info.Mode().IsRegular():
				total += info.Size()
				out = append(out, e)
			case info.IsDir():
				out = append(out, e)
				if err := walk(rel, info); err != nil {
					return err
				}
			default:
				st.Warnings = append(st.Warnings, "omitido (no es fichero ni directorio): "+rel)
			}
		}
		return nil
	}
	err := walk(".", nil)
	return out, total, err
}

// readDirIn lista un directorio de la raíz, ordenado por nombre. want es lo que vio el
// escaneo (nil para la propia raíz). Si entretanto lo cambiaron por un fichero, una FIFO o
// un enlace (fuera o a otro directorio de dentro), devuelve changed sin listarlo; si
// desapareció, nada. O_DIRECTORY hace que abrir una FIFO colada falle en vez de bloquearse.
func readDirIn(root *os.Root, dir string, want fs.FileInfo) (des []fs.DirEntry, changed bool, err error) {
	f, err := root.OpenFile(dir, os.O_RDONLY|syscall.O_DIRECTORY, 0)
	if err != nil {
		if want == nil {
			return nil, false, err
		}
		// Se decide por lo que hay ahora, no por el error (os.Root no exporta el de «escapa»).
		now, lerr := root.Lstat(dir)
		switch {
		case errors.Is(lerr, fs.ErrNotExist):
			return nil, false, nil // desapareció durante el recorrido
		case lerr == nil && !now.IsDir():
			return nil, true, nil
		}
		return nil, false, err
	}
	defer f.Close()
	if want != nil {
		now, err := f.Stat()
		if err != nil {
			return nil, false, err
		}
		if !os.SameFile(want, now) { // p. ej. un enlace a otro directorio de dentro, ya seguido
			return nil, true, nil
		}
	}
	des, err = f.ReadDir(-1)
	slices.SortFunc(des, func(a, b fs.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	return des, false, err
}

func writeEntry(ctx context.Context, tw *tar.Writer, root *os.Root, e entry, buf []byte) (n int64, skipped bool, warn string, err error) {
	hdr, err := tar.FileInfoHeader(e.info, e.link)
	if err != nil {
		return 0, false, "", err
	}
	hdr.Name = e.rel
	if e.info.IsDir() {
		hdr.Name += "/"
	}
	hdr.Format = tar.FormatPAX
	hdr.Uname, hdr.Gname = "", "" // solo uid/gid numéricos: la imagen itzg usa 1000
	hdr.AccessTime, hdr.ChangeTime = time.Time{}, time.Time{}
	if !e.info.Mode().IsRegular() {
		return 0, false, "", tw.WriteHeader(hdr)
	}
	// O_NONBLOCK: si el fichero se cambió por una FIFO tras el escaneo, abrirla no se
	// bloquea (y se descarta abajo); en ficheros regulares no tiene efecto.
	f, err := root.OpenFile(e.rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, true, "omitido (se borró durante la copia): " + e.rel, nil
		}
		return 0, false, "", err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil {
		return 0, false, "", err
	} else if !fi.Mode().IsRegular() {
		return 0, true, "omitido (dejó de ser un fichero durante la copia): " + e.rel, nil
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return 0, false, "", err
	}
	n, err = io.CopyBuffer(tw, io.LimitReader(cancelReader{ctx, f}, hdr.Size), buf)
	if err != nil {
		return n, false, "", err
	}
	if n < hdr.Size {
		if _, err := io.CopyN(tw, zeroReader{}, hdr.Size-n); err != nil {
			return n, false, "", err
		}
		warn = "cambió durante la copia (rellenado con ceros): " + e.rel
		n = hdr.Size
	}
	return n, false, warn, nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// cancelReader corta una copia larga (un fichero de varios GiB) al cancelar ctx.
type cancelReader struct {
	ctx context.Context
	r   io.Reader
}

func (c cancelReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// Límites por defecto de una extracción (ExtractLimits con ceros).
const (
	DefaultMaxExtractBytes   int64 = 256 << 30 // 256 GiB sin comprimir
	DefaultMaxExtractEntries       = 2_000_000

	maxEntryName  = 4096      // PATH_MAX
	maxZstdWindow = 128 << 20 // como `zstd --long`; acota la memoria del descompresor
	maxTrailing   = 1 << 20   // relleno admitido tras el final del tar (GNU tar rellena a 10 KiB)
	tarBlock      = 512
)

// ExtractLimits acota lo que puede crear una extracción (bombas de descompresión). Un
// campo a cero toma el valor por defecto.
type ExtractLimits struct {
	MaxBytes   int64 // suma de los tamaños declarados de los ficheros regulares
	MaxEntries int   // entradas del tar, de cualquier tipo
}

func (l ExtractLimits) withDefaults() ExtractLimits {
	if l.MaxBytes <= 0 {
		l.MaxBytes = DefaultMaxExtractBytes
	}
	if l.MaxEntries <= 0 {
		l.MaxEntries = DefaultMaxExtractEntries
	}
	return l
}

// geteuid es sustituible en tests (restaurar el propietario solo se intenta como root).
var geteuid = os.Geteuid

// ExtractArchive extrae con los límites por defecto (ver ExtractArchiveLimits).
func ExtractArchive(ctx context.Context, r io.Reader, dst string, warn func(string)) error {
	return ExtractArchiveLimits(ctx, r, dst, warn, ExtractLimits{})
}

// ExtractArchiveLimits descomprime en dst, que debe existir y estar vacío. Todo se crea a
// través de un os.Root abierto en dst: ninguna escritura sale de él, ni siquiera tras
// resolver enlaces. Rechaza la copia entera ante una ruta absoluta, con `..` o inválida, o
// si supera los límites; no crea enlaces simbólicos, enlaces duros ni ficheros especiales
// (los omite avisando por warn). Restaura permisos (sin setuid, setgid ni sticky), fechas
// y, si el agente corre como root, el propietario del tar (la imagen itzg usa uid 1000).
// Si falla, borra lo extraído: dst queda vacío como estaba.
func ExtractArchiveLimits(ctx context.Context, r io.Reader, dst string, warn func(string), lim ExtractLimits) error {
	if warn == nil {
		warn = func(string) {}
	}
	fi, err := os.Lstat(dst)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("el destino %s no es un directorio", dst)
	}
	root, err := os.OpenRoot(dst)
	if err != nil {
		return err
	}
	defer root.Close()
	names, err := dirNames(root, 1)
	if err != nil {
		return err
	}
	if len(names) > 0 {
		return fmt.Errorf("el destino %s no está vacío", dst)
	}
	dec, err := zstd.NewReader(r, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxWindow(maxZstdWindow))
	if err != nil {
		return err
	}
	defer dec.Close()
	x := &extractor{ctx: ctx, root: root, warn: warn, lim: lim.withDefaults(), buf: make([]byte, copyBufSize)}
	if err := x.run(dec); err != nil {
		if names, lerr := dirNames(root, -1); lerr == nil {
			for _, n := range names {
				_ = root.RemoveAll(n)
			}
		}
		return err
	}
	return nil
}

// dirNames lista hasta n nombres (n < 0: todos) de la raíz.
func dirNames(root *os.Root, n int) ([]string, error) {
	d, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer d.Close()
	names, err := d.Readdirnames(n)
	if errors.Is(err, io.EOF) {
		err = nil
	}
	return names, err
}

type extractor struct {
	ctx         context.Context
	root        *os.Root
	warn        func(string)
	lim         ExtractLimits
	buf         []byte
	entries     int
	bytes       int64
	ownerWarned bool
}

type dirMeta struct {
	name  string
	mode  fs.FileMode
	mtime time.Time
}

func (x *extractor) run(dec io.Reader) error {
	tail := &tailReader{r: cancelReader{x.ctx, dec}} // ctx también dentro de Next()
	tr := tar.NewReader(tail)
	var dirs []dirMeta
	for {
		if err := x.ctx.Err(); err != nil {
			return err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if errors.Is(err, tar.ErrInsecurePath) && hdr != nil {
			return fmt.Errorf("entrada con ruta insegura %q: copia rechazada", hdr.Name)
		}
		if err != nil {
			return fmt.Errorf("copia ilegible o dañada: %w", err)
		}
		if x.entries++; x.entries > x.lim.MaxEntries {
			return fmt.Errorf("la copia supera el límite de %d entradas: rechazada", x.lim.MaxEntries)
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			continue // metadatos PAX globales (git archive); archive/tar ya los leyó, acotados
		}
		name, err := entryName(hdr.Name)
		if err != nil {
			return err
		}
		// archive/tar solo ignora el Size de los tipos «solo cabecera»; en los demás, lo que no
		// se lea lo descarta Next() descomprimiéndolo entero. Todo cuenta para el límite.
		if !headerOnly(hdr.Typeflag) {
			if hdr.Size > x.lim.MaxBytes-x.bytes {
				return fmt.Errorf("la copia supera el límite de %d bytes descomprimidos: rechazada", x.lim.MaxBytes)
			}
			x.bytes += hdr.Size
		}
		mode := fs.FileMode(hdr.Mode).Perm() // sin setuid, setgid ni sticky
		switch hdr.Typeflag {
		case tar.TypeDir:
			if name == "." {
				continue // el propio destino: sus permisos los decide el llamante
			}
			if err := x.root.MkdirAll(name, 0o755); err != nil {
				return err
			}
			if geteuid() == 0 {
				x.ownerErr(name, x.root.Lchown(name, hdr.Uid, hdr.Gid))
			}
			dirs = append(dirs, dirMeta{name, mode, hdr.ModTime})
		case tar.TypeReg:
			if name == "." {
				return fmt.Errorf("entrada con nombre inválido %q: copia rechazada", hdr.Name)
			}
			if dir := path.Dir(name); dir != "." {
				if err := x.root.MkdirAll(dir, 0o755); err != nil {
					return err
				}
			}
			if err := x.file(name, tr, hdr, mode); err != nil {
				return err
			}
		default:
			// GNU sparse, contiguos, tipos desconocidos…: no se restauran, y si traen contenido
			// la copia no es nuestra ni de un tar corriente de un directorio de datos.
			if hdr.Size > 0 {
				return fmt.Errorf("entrada %q de tipo no admitido (%q) con contenido: copia rechazada", hdr.Name, hdr.Typeflag)
			}
			x.warn(fmt.Sprintf("omitido %s: los enlaces y ficheros especiales no se restauran", hdr.Name))
		}
	}
	// archive/tar da io.EOF también si el flujo acaba en el límite de una entrada: sin los
	// dos bloques de ceros finales la copia está cortada (o vacía) y no se da por buena.
	if tail.zeros < 2*tarBlock {
		return errors.New("copia incompleta (falta el final del tar): rechazada")
	}
	// Leer lo que quede de la trama obliga a zstd a comprobar su suma de verificación: así
	// se detecta un dato corrupto aunque se hubiera descomprimido sin error.
	n, err := io.Copy(io.Discard, io.LimitReader(dec, maxTrailing+1))
	if err != nil {
		return fmt.Errorf("copia ilegible o dañada: %w", err)
	}
	if n > maxTrailing {
		return errors.New("copia con datos de sobra tras el final del tar: rechazada")
	}
	// Permisos y fechas de los directorios al final (escribir dentro cambia su mtime), de
	// los más profundos a los de arriba.
	for i := len(dirs) - 1; i >= 0; i-- {
		_ = x.root.Chmod(dirs[i].name, dirs[i].mode)
		_ = x.root.Chtimes(dirs[i].name, dirs[i].mtime, dirs[i].mtime)
	}
	return nil
}

// file crea name (O_EXCL: nunca pisa ni sigue nada existente) con el contenido de r. Si
// algo falla, borra el fichero a medias.
func (x *extractor) file(name string, r io.Reader, hdr *tar.Header, mode fs.FileMode) (err error) {
	f, err := x.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if err != nil {
			if !closed {
				_ = f.Close()
			}
			_ = x.root.Remove(name)
		}
	}()
	// struct{io.Writer} oculta File.ReadFrom para que la copia use buf.
	if _, err = io.CopyBuffer(struct{ io.Writer }{f}, cancelReader{x.ctx, r}, x.buf); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			err = fmt.Errorf("copia ilegible o dañada: %w", err)
		}
		return err
	}
	// Sobre el descriptor (fchown/fchmod): sin carreras con la ruta. chown antes que chmod,
	// porque chown puede limpiar bits del modo.
	if geteuid() == 0 {
		x.ownerErr(name, f.Chown(hdr.Uid, hdr.Gid))
	}
	if err = f.Chmod(mode); err != nil {
		return err
	}
	closed = true
	if err = f.Close(); err != nil {
		return err
	}
	_ = x.root.Chtimes(name, hdr.ModTime, hdr.ModTime)
	return nil
}

// ownerErr avisa (una sola vez por extracción) de que no se pudo restaurar un propietario:
// la copia sigue siendo válida, pero el servidor podría no poder escribir esos ficheros.
func (x *extractor) ownerErr(name string, err error) {
	if err == nil || x.ownerWarned {
		return
	}
	x.ownerWarned = true
	x.warn(fmt.Sprintf("aviso: no se pudo restaurar el propietario de %s (%v); puede haber más casos", name, err))
}

// headerOnly son los tipos cuyo Size ignora archive/tar (no tienen contenido).
func headerOnly(flag byte) bool {
	switch flag {
	case tar.TypeLink, tar.TypeSymlink, tar.TypeChar, tar.TypeBlock, tar.TypeDir, tar.TypeFifo:
		return true
	}
	return false
}

// tailReader cuenta la racha de bytes a cero con la que termina lo leído hasta ahora.
type tailReader struct {
	r     io.Reader
	zeros int64
}

func (t *tailReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	i := n - 1
	for i >= 0 && p[i] == 0 {
		i--
	}
	if i < 0 {
		t.zeros += int64(n)
	} else {
		t.zeros = int64(n - 1 - i)
	}
	return n, err
}

// entryName valida el nombre de una entrada del tar y lo devuelve normalizado (relativo,
// con `/`, sin componentes vacíos ni `.`; "." para el propio destino). Rechaza rutas
// absolutas, cualquier componente `..` (aunque no llegue a salir del destino), NUL y
// nombres desmesurados: una entrada así hace hostil la copia entera.
func entryName(raw string) (string, error) {
	if raw == "" || len(raw) > maxEntryName || strings.ContainsRune(raw, 0) {
		return "", fmt.Errorf("entrada con nombre inválido %q: copia rechazada", raw)
	}
	if strings.HasPrefix(raw, "/") {
		return "", fmt.Errorf("entrada con ruta absoluta %q: copia rechazada", raw)
	}
	parts := make([]string, 0, strings.Count(raw, "/")+1)
	for p := range strings.SplitSeq(raw, "/") {
		switch p {
		case "", ".":
		case "..":
			return "", fmt.Errorf("entrada que sale del destino %q: copia rechazada", raw)
		default:
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return ".", nil
	}
	return strings.Join(parts, "/"), nil
}
