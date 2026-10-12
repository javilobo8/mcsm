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

// Sustituibles en tests: el espacio libre del sistema de ficheros, el volcado a disco y
// los renombrados del intercambio (para simular fallos y cancelaciones a mitad).
var (
	freeSpace = statfsFree
	syncFS    = syscall.Sync
	rename    = os.Rename
)

// Restore reemplaza DataDir por el contenido de una copia SIN borrar nunca los datos
// previos (spec §6.5): verifica el sha256 si lo hay, comprueba el espacio libre, extrae en
// <data>.restoring-<ts>, renombra DataDir a <data>.pre-restore-<ts> y el extraído a
// DataDir. Mientras no se haya completado el intercambio, un fallo o una cancelación dejan
// DataDir como estaba (si falla el segundo renombrado, el primero se deshace) y el
// directorio temporal se borra. Devuelve los metadatos del directorio pre-restore
// (Filename vacío si no había datos previos).
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
	if merr == nil && m.SHA256 != "" {
		req.Progress(2, "Verificando la copia (sha256)")
		sum, err := fileSHA256(ctx, src)
		if err != nil {
			return Meta{}, fmt.Errorf("verificar la copia: %w", err)
		}
		if sum != m.SHA256 {
			return Meta{}, fmt.Errorf("la copia está dañada: sha256 %s, esperado %s", sum, m.SHA256)
		}
		req.Log("sha256 verificado")
	} else {
		req.Log("aviso: la copia no tiene sha256 guardado; se restaura sin verificar")
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
		if !swapped {
			_ = os.RemoveAll(staging) // directorio propio recién creado: borrarlo es seguro
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
		return Meta{}, fmt.Errorf("extraer la copia: %w", err)
	}
	// Lo extraído, en disco antes de activarlo: un corte de luz tras el intercambio no debe
	// dejar en data ficheros a medio escribir (los previos ya estarán en el pre-restore).
	syncFS()
	if err := ctx.Err(); err != nil {
		return Meta{}, err
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
				return Meta{}, fmt.Errorf("activar la copia: %v; tampoco se pudieron devolver los datos originales (siguen en %s): %v", err, prePath, uerr)
			}
		}
		return Meta{}, fmt.Errorf("activar la copia: %w", err)
	}
	swapped = true
	_ = syncDir(parent)
	req.Log("copia restaurada en " + req.DataDir)
	if !hadData {
		return Meta{}, nil
	}
	pre := Meta{
		Filename: preName, ServerID: req.ServerID, Slug: req.Slug, Trigger: TriggerPreRestore,
		SizeBytes: dirSize(prePath), StartedAt: now.UTC(), FinishedAt: req.Now().UTC(),
	}
	if err := writeJSON(prePath+MetaExt, pre); err != nil {
		req.Log("aviso: no se pudo escribir el .json de " + preName + ": " + err.Error())
	}
	req.Log("datos anteriores conservados en " + preName + " (no se borran solos)")
	return pre, nil
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

// checkSpace falla si en dir no caben need bytes. Si no se puede consultar, avisa y deja
// seguir: si de verdad no cabe, la extracción fallará sin tocar los datos.
func checkSpace(dir string, need int64, log func(string)) error {
	free, err := freeSpace(dir)
	if err != nil {
		log("aviso: no se pudo comprobar el espacio libre en " + dir + ": " + err.Error())
		return nil
	}
	if need > 0 && free < uint64(need) {
		return fmt.Errorf("no hay espacio libre suficiente para restaurar: hacen falta %s y quedan %s libres en %s",
			humanBytes(uint64(need)), humanBytes(free), dir)
	}
	return nil
}

// statfsFree es el espacio disponible para usuarios sin privilegios (sin la reserva de
// root): el servidor, que no es root, también necesita sitio para escribir después.
func statfsFree(dir string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
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
