package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// ErrDataMissing indica que la restauración apartó los datos y no pudo devolverlos: el
// directorio de datos NO existe (los originales siguen enteros en el pre-restore que
// nombra el error). El llamante no debe arrancar el servidor: Docker crearía un data vacío
// y el servidor generaría un mundo nuevo encima.
var ErrDataMissing = errors.New("el servidor se ha quedado sin directorio de datos; no lo arranques hasta devolverlos a su sitio")

// Margen de la comprobación de espacio: el mayor entre el 5 % de lo que se va a extraer y
// 256 MiB (redondeo a bloques, directorios, y sitio para que los servidores del nodo sigan
// guardando mientras tanto).
const (
	spaceMarginPct = 5
	spaceMarginMin = 256 << 20
)

// RestoreRequest describe una restauración. El servidor debe estar parado: lo para el
// llamante, que además lo tiene reservado en el reconciliador.
type RestoreRequest struct {
	ServerID   string
	Slug       string
	Filename   string // nombre de la copia .tar.zst en BackupsDir
	DataDir    string
	BackupsDir string
	Now        func() time.Time
	Progress   func(pct uint32, msg string)
	Log        func(line string)
}

func (r *RestoreRequest) defaults() {
	if r.Now == nil {
		r.Now = time.Now
	}
	if r.Progress == nil {
		r.Progress = func(uint32, string) {}
	}
	if r.Log == nil {
		r.Log = func(string) {}
	}
}

// Puntos de inyección para tests: el espacio libre, el volcado a disco, los renombrados
// del intercambio y el borrado del temporal (para simular fallos y cancelaciones a mitad).
// Son variables de paquete, así que los tests de este paquete no usan t.Parallel.
var (
	freeSpace = statfsFree
	syncFS    = syncFilesystem
	rename    = os.Rename
	removeAll = os.RemoveAll
)

// Restore reemplaza DataDir por el contenido de una copia SIN borrar nunca los datos
// previos (spec §6.5): verifica el sha256 si lo hay, comprueba el espacio libre, extrae en
// <data>.restoring-<ts>, lo vuelca a disco, renombra DataDir a <data>.pre-restore-<ts> y
// el extraído a DataDir. Mientras no se haya completado el intercambio, un fallo o una
// cancelación dejan DataDir como estaba (si falla el segundo renombrado, el primero se
// deshace; si eso también falla, el error envuelve ErrDataMissing) y el directorio
// temporal se borra. Devuelve los metadatos del directorio pre-restore (Filename vacío si
// no había datos previos).
func Restore(ctx context.Context, req RestoreRequest) (Meta, error) {
	req.defaults()
	if !ValidName(req.Slug, req.Filename) {
		return Meta{}, fmt.Errorf("nombre de copia inválido %q", req.Filename)
	}
	src := filepath.Join(req.BackupsDir, req.Filename)
	fi, err := os.Lstat(src)
	if err != nil {
		return Meta{}, fmt.Errorf("la copia %s no está en el nodo: %w", req.Filename, err)
	}
	if !fi.Mode().IsRegular() {
		return Meta{}, fmt.Errorf("la copia %s no es un fichero normal", req.Filename)
	}
	// Lo que ocupará: el contenido sin comprimir si la copia lo anotó; si no, al menos
	// lo que ocupa comprimida.
	need := fi.Size()
	m, merr := ReadMeta(req.BackupsDir, req.Filename)
	if merr == nil && m.DataBytes > 0 {
		need = m.DataBytes
	}
	switch {
	case merr == nil && m.SHA256 != "":
		req.Progress(2, "Verificando la copia (sha256)")
		sum, err := fileSHA256(ctx, src)
		if err != nil {
			return Meta{}, fmt.Errorf("verificar la copia: %w", err)
		}
		if sum != m.SHA256 {
			return Meta{}, fmt.Errorf("la copia está dañada: sha256 %s, esperado %s", sum, m.SHA256)
		}
		req.Log("sha256 verificado")
	case merr == nil:
		req.Log("aviso: los metadatos de la copia no traen sha256; se restaura sin verificar")
	case errors.Is(merr, fs.ErrNotExist):
		req.Log("aviso: la copia no tiene sha256 guardado (falta su .json); se restaura sin verificar")
	default:
		req.Log("aviso: no se pudo leer el .json de la copia (" + merr.Error() + "); se restaura sin verificar el sha256")
	}

	// Todo lo que pueda fallar sin escribir nada, antes de extraer.
	now := req.Now()
	parent := filepath.Dir(req.DataDir)
	preName := PreRestoreName(req.DataDir, now)
	prePath := filepath.Join(parent, preName)
	if _, err := currentData(req.DataDir); err != nil {
		return Meta{}, err
	}
	// rename(2) sustituiría en silencio un directorio vacío con ese nombre.
	if _, err := os.Lstat(prePath); err == nil {
		return Meta{}, fmt.Errorf("%s ya existe: no se sobrescribe; vuelve a intentarlo", preName)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Meta{}, err
	}
	if err := checkSpace(parent, need, req.Log); err != nil {
		return Meta{}, err
	}

	staging := req.DataDir + restoringInfix + now.UTC().Format(tsLayout)
	if err := os.Mkdir(staging, 0o755); err != nil {
		return Meta{}, fmt.Errorf("preparar la restauración: %w", err)
	}
	swapped := false
	defer func() {
		if swapped {
			return
		}
		// Directorio propio recién creado (Mkdir falla si ya existía): borrarlo es seguro.
		if err := removeAll(staging); err != nil {
			req.Log("aviso: no se pudo borrar el directorio temporal " + staging + " (bórralo a mano): " + err.Error())
		}
	}()
	f, err := os.Open(src)
	if err != nil {
		return Meta{}, err
	}
	defer f.Close()
	req.Progress(10, "Extrayendo la copia")
	pr := &progressReader{r: ctxReader{ctx: ctx, r: f}, total: max(fi.Size(), 1), fn: func(done, total int64) {
		req.Progress(10+uint32(done*80/total), "Extrayendo la copia")
	}}
	if err := ExtractArchive(ctx, pr, staging, req.Log); err != nil {
		if cerr := ctx.Err(); cerr != nil { // no es una copia dañada: se canceló
			return Meta{}, fmt.Errorf("restauración cancelada: %w", cerr)
		}
		return Meta{}, fmt.Errorf("extraer la copia: %w", err)
	}
	// Lo extraído, en disco antes de activarlo: un corte de luz tras el intercambio no debe
	// dejar en data ficheros a medio escribir (los previos ya estarán en el pre-restore).
	if err := syncCtx(ctx, staging); err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return Meta{}, fmt.Errorf("restauración cancelada: %w", cerr)
		}
		return Meta{}, fmt.Errorf("volcar a disco la copia extraída: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return Meta{}, fmt.Errorf("restauración cancelada: %w", err)
	}

	cur, err := currentData(req.DataDir)
	if err != nil {
		return Meta{}, err
	}
	hadData := cur != nil
	if hadData {
		matchOwner(staging, cur)
		req.Progress(92, "Conservando los datos actuales en "+preName)
		if err := rename(req.DataDir, prePath); err != nil {
			return Meta{}, fmt.Errorf("apartar los datos actuales: %w", err)
		}
	}
	if err := rename(staging, req.DataDir); err != nil {
		if hadData {
			if uerr := rename(prePath, req.DataDir); uerr != nil {
				return Meta{}, fmt.Errorf("%w: activar la copia: %v; tampoco se pudieron devolver los datos originales, que siguen en %s: %v",
					ErrDataMissing, err, prePath, uerr)
			}
		}
		return Meta{}, fmt.Errorf("activar la copia: %w", err)
	}
	swapped = true
	req.Log("copia restaurada en " + req.DataDir)
	if !hadData {
		_ = syncDir(parent)
		return Meta{}, nil
	}
	pre := Meta{
		Filename: preName, ServerID: req.ServerID, Slug: req.Slug, Trigger: TriggerPreRestore,
		SizeBytes: dirSize(prePath), StartedAt: now.UTC(), FinishedAt: req.Now().UTC(),
	}
	if err := writeJSON(prePath+MetaExt, pre); err != nil {
		req.Log("aviso: no se pudo escribir el .json de " + preName + ": " + err.Error())
	}
	_ = syncDir(parent) // los dos renombrados y el .json del pre-restore
	req.Log("datos anteriores conservados en " + preName + " (no se borran solos)")
	return pre, nil
}

// syncCtx vuelca a disco el sistema de ficheros de dir sin dejar de atender a ctx.
// syncfs(2) no se puede interrumpir. Si se cancela mientras tanto (p. ej. el agente se
// está cerrando), se deja de esperar y la restauración falla sin intercambiar nada; la
// goroutine sigue en el kernel hasta que el volcado vuelva y entonces termina sola.
// Compromiso: una goroutine y un descriptor retenidos a cambio de no bloquear la
// restauración (con el servidor parado y reservado) en un volcado lento. Un sistema de
// ficheros de datos muerto del todo bloquearía ya la extracción y la limpieza del
// temporal; solo se vuelca el FS de los datos, nunca los demás montajes del host.
func syncCtx(ctx context.Context, dir string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	done := make(chan error, 1) // con hueco: la goroutine abandonada no se queda colgada al enviar
	go func() { done <- syncFS(dir) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// syncFilesystem hace syncfs(2) del sistema de ficheros que contiene dir: solo ese FS,
// no sync(2), que recorre todos los montajes del host (y se cuelga con un NFS caído).
func syncFilesystem(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return unix.Syncfs(int(d.Fd()))
}

// currentData devuelve el directorio de datos actual, nil si no existe, o un error si es
// otra cosa (un enlace simbólico tampoco se aparta: renombrarlo no movería los datos).
func currentData(dataDir string) (fs.FileInfo, error) {
	fi, err := os.Lstat(dataDir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, nil
	case err != nil:
		return nil, err
	case !fi.IsDir():
		return nil, fmt.Errorf("%s existe y no es un directorio: no se restaura", dataDir)
	}
	return fi, nil
}

// requiredSpace es lo que debe quedar libre para extraer need bytes: need más el margen.
func requiredSpace(need int64) uint64 {
	n := uint64(max(need, 0))
	return n + max(n*spaceMarginPct/100, spaceMarginMin)
}

// checkSpace falla si en dir no cabe la extracción con su margen. Si no se puede
// consultar, avisa y deja seguir: si de verdad no cabe, la extracción fallará sin tocar
// los datos.
func checkSpace(dir string, need int64, log func(string)) error {
	free, err := freeSpace(dir)
	if err != nil {
		log("aviso: no se pudo comprobar el espacio libre en " + dir + ": " + err.Error())
		return nil
	}
	if req := requiredSpace(need); free < req {
		return fmt.Errorf("no hay espacio libre suficiente para restaurar: hacen falta %s (%s de datos más un margen de %s para el redondeo a bloques y para que los servidores del nodo sigan pudiendo guardar) y quedan %s libres en %s",
			humanBytes(req), humanBytes(uint64(max(need, 0))), humanBytes(req-uint64(max(need, 0))), humanBytes(free), dir)
	}
	return nil
}

// statfsFree es el espacio disponible para usuarios sin privilegios (sin la reserva de
// root): el servidor, que no es root, también necesita sitio para escribir después.
func statfsFree(dir string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return freeBytes(uint64(st.Bavail), int64(st.Frsize), int64(st.Bsize)), nil
}

// freeBytes: f_bavail va en unidades de f_frsize (en FUSE puede no coincidir con
// f_bsize); si el FS no informa f_frsize, se usa f_bsize.
func freeBytes(bavail uint64, frsize, bsize int64) uint64 {
	unit := frsize
	if unit <= 0 {
		unit = bsize
	}
	return bavail * uint64(max(unit, 0))
}

func humanBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

type progressReader struct {
	r     io.Reader
	done  int64
	total int64
	fn    func(done, total int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.done += int64(n)
	p.fn(min(p.done, p.total), p.total)
	return n, err
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

func fileSHA256(ctx context.Context, p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, ctxReader{ctx: ctx, r: f}); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// matchOwner copia permisos y (si el agente es root) propietario del directorio de datos
// original al restaurado: la imagen itzg espera /data del uid 1000.
func matchOwner(p string, like fs.FileInfo) {
	_ = os.Chmod(p, like.Mode().Perm())
	if st, ok := like.Sys().(*syscall.Stat_t); ok && geteuid() == 0 {
		_ = os.Lchown(p, int(st.Uid), int(st.Gid))
	}
}

func dirSize(root string) int64 {
	var n int64
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, ierr := d.Info(); ierr == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}
