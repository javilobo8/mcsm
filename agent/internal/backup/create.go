package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"mcsm/agent/internal/spec"
)

const (
	// FlushWait es la espera tras save-all flush (spec §6.5).
	FlushWait = 3 * time.Second
	// resumeTimeout acota el save-on, que se envía aunque el job esté cancelado.
	resumeTimeout = 15 * time.Second
)

// ErrResume indica que no se pudo reactivar el guardado automático tras una copia en
// caliente: el mundo sigue con save-off hasta que alguien ejecute save-on.
var ErrResume = errors.New("no se pudo reactivar el guardado automático (save-on); ejecuta save-on en la consola")

// RconFunc ejecuta un comando de consola en el servidor. El plazo de cada comando es el
// del contexto que recibe (save-all flush en un mundo grande tarda más de 5 s).
type RconFunc func(ctx context.Context, command string) (string, error)

// CreateRequest describe una copia.
type CreateRequest struct {
	ServerID    string
	Slug        string
	SpecVersion uint64
	Trigger     string
	DataDir     string // <DATA_ROOT>/<slug>/data
	BackupsDir  string // <DATA_ROOT>/<slug>/backups
	Excludes    []string
	// Rcon es nil si el servidor está parado: entonces se copia sin save-off.
	Rcon     RconFunc
	Now      func() time.Time
	Sleep    func(ctx context.Context, d time.Duration) error
	Progress func(pct uint32, msg string)
	Log      func(line string)
}

func (r *CreateRequest) defaults() {
	if r.Now == nil {
		r.Now = time.Now
	}
	if r.Sleep == nil {
		r.Sleep = Sleep
	}
	if r.Progress == nil {
		r.Progress = func(uint32, string) {}
	}
	if r.Log == nil {
		r.Log = func(string) {}
	}
}

// Sleep espera d o hasta que ctx termine.
func Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Create hace una copia consistente (spec §6.5). Con el servidor en marcha: save-off,
// save-all flush, espera de 3 s, copia y SIEMPRE save-on (en defer, registrado antes del
// save-off y con un contexto propio: ni un fallo ni una cancelación dejan el mundo sin
// autoguardado). El fichero se escribe como .partial y se renombra al final; si algo falla
// el parcial se borra (spec §10). Si la copia se escribió pero save-on falla, devuelve los
// metadatos de la copia Y un error que envuelve ErrResume; si fallan las dos cosas, el
// error envuelve ambas.
func Create(ctx context.Context, req CreateRequest) (meta Meta, err error) {
	req.defaults()
	if !spec.ValidSlug(req.Slug) {
		return Meta{}, fmt.Errorf("slug inválido %q", req.Slug)
	}
	excl, err := NewExcluder(req.Excludes)
	if err != nil {
		return Meta{}, err
	}
	if fi, serr := os.Stat(req.DataDir); serr != nil || !fi.IsDir() {
		return Meta{}, fmt.Errorf("el servidor aún no tiene datos que copiar (%s)", req.DataDir)
	}
	if err := os.MkdirAll(req.BackupsDir, 0o750); err != nil {
		return Meta{}, fmt.Errorf("crear el directorio de copias: %w", err)
	}
	started := req.Now()
	name := Filename(req.Slug, started, req.SpecVersion)
	final := filepath.Join(req.BackupsDir, name)
	if _, serr := os.Lstat(final); serr == nil {
		return Meta{}, fmt.Errorf("la copia %s ya existe", name)
	}

	if req.Rcon != nil {
		// Registrado ANTES de save-off: aunque save-off falle (quizá sí llegó al servidor),
		// la copia falle o el job se cancele, save-on se envía con su propio contexto.
		defer func() {
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), resumeTimeout)
			defer cancel()
			if _, rerr := req.Rcon(rctx, "save-on"); rerr != nil {
				req.Log("ATENCIÓN: save-on falló, el guardado automático sigue desactivado: " + rerr.Error())
				rerr = fmt.Errorf("%w: %v", ErrResume, rerr)
				if err == nil {
					err = rerr
				} else {
					err = errors.Join(err, rerr)
				}
				return
			}
			req.Log("save-on: guardado automático reactivado")
		}()
		req.Progress(1, "Desactivando el guardado automático")
		if _, err := req.Rcon(ctx, "save-off"); err != nil {
			return Meta{}, fmt.Errorf("RCON save-off: %w", err)
		}
		req.Log("save-off: guardado automático desactivado")
		if _, err := req.Rcon(ctx, "save-all flush"); err != nil {
			return Meta{}, fmt.Errorf("RCON save-all flush: %w", err)
		}
		req.Log("save-all flush: mundo escrito en disco")
		if err := req.Sleep(ctx, FlushWait); err != nil {
			return Meta{}, err
		}
	}

	size, sum, stats, err := writeTo(ctx, req, excl, final)
	if err != nil {
		return Meta{}, err
	}
	for _, w := range stats.Warnings {
		req.Log(w)
	}
	meta = Meta{
		Filename: name, ServerID: req.ServerID, Slug: req.Slug, SpecVersion: req.SpecVersion, Trigger: req.Trigger,
		SizeBytes: size, DataBytes: stats.Bytes, SHA256: sum, StartedAt: started.UTC(), FinishedAt: req.Now().UTC(),
		Excludes: req.Excludes, Files: stats.Files,
	}
	if err := WriteMeta(req.BackupsDir, meta); err != nil {
		req.Log("aviso: no se pudo escribir el .json de metadatos (la copia es válida): " + err.Error())
	}
	_ = syncDir(req.BackupsDir)
	req.Progress(99, "Copia escrita")
	req.Log(fmt.Sprintf("copia escrita: %s (%d ficheros, %d bytes comprimidos)", name, stats.Files, size))
	return meta, nil
}

// writeTo escribe la copia en <final>.partial calculando su sha256, la sincroniza y la
// renombra a final. Si algo falla, borra el parcial.
func writeTo(ctx context.Context, req CreateRequest, excl *Excluder, final string) (size int64, sum string, st ArchiveStats, err error) {
	partial := final + partialExt
	f, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return 0, "", st, fmt.Errorf("crear la copia: %w", err)
	}
	closed := false
	defer func() {
		if err != nil {
			if !closed {
				_ = f.Close()
			}
			_ = os.Remove(partial)
		}
	}()
	h := sha256.New()
	req.Progress(2, "Copiando datos")
	st, err = WriteArchive(ctx, req.DataDir, io.MultiWriter(f, h), excl, func(done, total int64) {
		pct := uint32(97)
		if total > 0 {
			pct = 2 + uint32(done*95/total)
		}
		req.Progress(pct, "Copiando datos")
	})
	if err != nil {
		return 0, "", st, fmt.Errorf("copiar los datos: %w", err)
	}
	if err = f.Sync(); err != nil {
		return 0, "", st, fmt.Errorf("guardar la copia en disco: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		return 0, "", st, err
	}
	closed = true
	if err = f.Close(); err != nil {
		return 0, "", st, fmt.Errorf("guardar la copia en disco: %w", err)
	}
	if err = os.Rename(partial, final); err != nil {
		return 0, "", st, fmt.Errorf("guardar la copia: %w", err)
	}
	return info.Size(), hex.EncodeToString(h.Sum(nil)), st, nil
}

// syncDir sincroniza las entradas de un directorio (renombrados y ficheros nuevos).
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
