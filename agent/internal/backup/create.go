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
	"strings"
	"time"
	"unicode/utf8"

	"mcsm/agent/internal/spec"
)

const (
	// FlushWait es la espera tras save-all flush (spec §6.5).
	FlushWait = 3 * time.Second
	// resumeTimeout acota el save-on, que se envía aunque el job esté cancelado.
	resumeTimeout = 15 * time.Second
	// maxReply acota la respuesta de RCON que se copia al log del job.
	maxReply = 200
	// spaceCheckEvery: cada cuántos bytes escritos se vuelve a mirar el espacio libre.
	spaceCheckEvery = 64 << 20
)

// ErrResume indica que no se pudo reactivar el guardado automático tras una copia en
// caliente: el mundo puede seguir con save-off hasta que alguien ejecute save-on.
var ErrResume = errors.New("no se pudo reactivar el guardado automático (save-on); ejecuta save-on en la consola")

// ErrNoSpace: no hay (o deja de haber) espacio libre para la copia o la restauración sin
// dejar el disco del nodo por debajo del margen con el que los servidores siguen guardando.
var ErrNoSpace = errors.New("no hay espacio libre suficiente")

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
	// FreeSpace devuelve el espacio libre del sistema de ficheros de dir (nil: statfs).
	FreeSpace func(dir string) (uint64, error)
}

func (r *CreateRequest) defaults() {
	if r.FreeSpace == nil {
		r.FreeSpace = freeSpace
	}
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
// save-all flush, espera de 3 s, tar y save-on en cuanto el tar se cierra (antes del
// fsync, los metadatos y el renombrado). save-on está además en un defer registrado antes
// del save-off y con un contexto propio: ni un fallo ni una cancelación dejan el mundo sin
// autoguardado, y se envía una sola vez. El fichero se escribe como .partial; su .json se
// escribe antes de darle el nombre final (el inventario nunca ve una copia sin
// metadatos); si algo falla, el parcial (y su .json) se borran (spec §10). Si la copia se
// escribió pero save-on falla, devuelve los metadatos de la copia Y un error que envuelve
// ErrResume; si fallan las dos cosas, el error envuelve ambas.
func Create(ctx context.Context, req CreateRequest) (meta Meta, err error) {
	req.defaults()
	if !spec.ValidSlug(req.Slug) {
		return Meta{}, fmt.Errorf("slug inválido %q", req.Slug)
	}
	excl, err := NewExcluder(req.Excludes)
	if err != nil {
		return Meta{}, err
	}
	fi, serr := os.Lstat(req.DataDir)
	switch {
	case errors.Is(serr, fs.ErrNotExist):
		return Meta{}, fmt.Errorf("el servidor aún no tiene datos que copiar (%s)", req.DataDir)
	case serr != nil:
		return Meta{}, fmt.Errorf("leer el directorio de datos: %w", serr)
	case !fi.IsDir():
		return Meta{}, fmt.Errorf("%s no es un directorio (los enlaces simbólicos no se siguen): no se copia", req.DataDir)
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
	// Antes de save-off: sin espacio, el servidor ni se entera.
	margin, err := backupSpace(ctx, req, excl)
	if err != nil {
		return Meta{}, err
	}

	resume := func() {}
	if req.Rcon != nil {
		var resumeErr error
		resumed := false
		resume = func() {
			if resumed {
				return
			}
			resumed = true
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), resumeTimeout)
			defer cancel()
			out, rerr := req.Rcon(rctx, "save-on")
			if rerr != nil {
				req.Log("ATENCIÓN: save-on falló; el guardado automático puede seguir desactivado: " + rerr.Error())
				resumeErr = fmt.Errorf("%w: %v", ErrResume, rerr)
				return
			}
			logRcon(req.Log, "save-on", "guardado automático reactivado", out)
		}
		// Registrado ANTES de save-off: aunque save-off falle (quizá sí llegó al servidor),
		// la copia falle o el job se cancele, save-on se envía con su propio contexto.
		defer func() {
			resume()
			switch {
			case resumeErr == nil:
			case err == nil:
				err = resumeErr
			default:
				err = fmt.Errorf("%w; además, %w", err, resumeErr)
			}
		}()
		req.Progress(1, "Desactivando el guardado automático")
		out, rerr := req.Rcon(ctx, "save-off")
		if rerr != nil {
			return Meta{}, fmt.Errorf("RCON save-off: %w", rerr)
		}
		logRcon(req.Log, "save-off", "guardado automático desactivado", out)
		if out, rerr = req.Rcon(ctx, "save-all flush"); rerr != nil {
			return Meta{}, fmt.Errorf("RCON save-all flush: %w", rerr)
		}
		logRcon(req.Log, "save-all flush", "mundo escrito en disco", out)
		if err := req.Sleep(ctx, FlushWait); err != nil {
			return Meta{}, err
		}
	}

	partial := final + partialExt
	size, sum, stats, err := writeArchive(ctx, req, excl, partial, margin, resume)
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
	metaErr := WriteMeta(req.BackupsDir, meta)
	if metaErr != nil {
		req.Log("aviso: no se pudo escribir el .json de metadatos (la copia es válida): " + metaErr.Error())
	}
	if err := rename(partial, final); err != nil {
		_ = os.Remove(partial)
		if metaErr == nil {
			_ = os.Remove(final + MetaExt)
		}
		return Meta{}, fmt.Errorf("guardar la copia: %w", err)
	}
	_ = syncDir(req.BackupsDir)
	req.Progress(99, "Copia escrita")
	req.Log(fmt.Sprintf("copia escrita: %s (%d ficheros, %d bytes comprimidos)", name, stats.Files, size))
	return meta, nil
}

// writeArchive escribe la copia en partial calculando su sha256 y la sincroniza. Llama a
// archived en cuanto el tar está cerrado (ya no se leen los datos del mundo: es cuando
// toca save-on). Si algo falla, borra el parcial.
func writeArchive(ctx context.Context, req CreateRequest, excl *Excluder, partial string, margin uint64, archived func()) (size int64, sum string, st ArchiveStats, err error) {
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
	out := io.Writer(f)
	if margin > 0 {
		out = &spaceGuard{w: f, free: req.FreeSpace, dir: req.BackupsDir, margin: margin, since: -1}
	}
	req.Progress(2, "Copiando datos")
	st, err = WriteArchive(ctx, req.DataDir, io.MultiWriter(out, h), excl, func(done, total int64) {
		pct := uint32(97)
		if total > 0 {
			pct = 2 + uint32(done*95/total)
		}
		req.Progress(pct, "Copiando datos")
	})
	if err != nil {
		return 0, "", st, fmt.Errorf("copiar los datos: %w", err)
	}
	archived()
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
	return info.Size(), hex.EncodeToString(h.Sum(nil)), st, nil
}

// backupSpace comprueba, antes de tocar el servidor, que cabe la copia: la estimación (la
// última copia del servidor ×1,2 o, si es la primera, lo que ocupan los datos sin comprimir)
// más el margen de la restauración, max(5 %, 256 MiB), para que los servidores del nodo
// sigan pudiendo guardar. Devuelve ese margen, que vigila spaceGuard durante el tar, o 0 si
// no se pudo consultar el espacio (se avisa y se copia sin vigilancia).
func backupSpace(ctx context.Context, req CreateRequest, excl *Excluder) (uint64, error) {
	est, basis, err := estimateBackup(ctx, req, excl)
	if err != nil {
		return 0, err
	}
	free, err := req.FreeSpace(req.BackupsDir)
	if err != nil {
		req.Log("aviso: no se pudo comprobar el espacio libre en " + req.BackupsDir + ": " + err.Error())
		return 0, nil
	}
	need := requiredSpace(est)
	margin := need - uint64(max(est, 0))
	if free < need {
		return 0, fmt.Errorf("%w para la copia: hacen falta %s (%s de copia según %s, más un margen de %s para que los servidores del nodo sigan pudiendo guardar) y quedan %s libres en %s; faltan %s",
			ErrNoSpace, humanBytes(need), humanBytes(uint64(max(est, 0))), basis, humanBytes(margin), humanBytes(free), req.BackupsDir, humanBytes(need-free))
	}
	return margin, nil
}

// estimateBackup estima lo que ocupará la copia y explica de dónde sale la cifra.
func estimateBackup(ctx context.Context, req CreateRequest, excl *Excluder) (int64, string, error) {
	if metas, err := List(req.BackupsDir, req.Slug); err == nil && len(metas) > 0 && metas[0].SizeBytes > 0 {
		last := metas[0].SizeBytes
		return last + last/5, "la última copia (" + humanBytes(uint64(last)) + ") más un 20 %", nil
	}
	root, err := os.OpenRoot(req.DataDir)
	if err != nil {
		return 0, "", fmt.Errorf("medir los datos: %w", err)
	}
	defer root.Close()
	var st ArchiveStats
	_, total, err := scan(ctx, root, excl, &st)
	if err != nil {
		return 0, "", fmt.Errorf("medir los datos: %w", err)
	}
	return total, "lo que ocupan los datos sin comprimir (es la primera copia)", nil
}

// spaceGuard deja de escribir la copia si el espacio libre baja del margen: otra copia u otro
// servidor pueden estar llenando el disco. Lo mira al empezar y cada spaceCheckEvery bytes; si
// no puede consultarlo, sigue.
type spaceGuard struct {
	w      io.Writer
	free   func(dir string) (uint64, error)
	dir    string
	margin uint64
	since  int64 // bytes desde la última comprobación; -1 = ninguna todavía
}

func (g *spaceGuard) Write(p []byte) (int, error) {
	if g.since < 0 || g.since >= spaceCheckEvery {
		g.since = 0
		if free, err := g.free(g.dir); err == nil && free < g.margin {
			return 0, fmt.Errorf("%w: el espacio libre bajó a %s durante la copia, por debajo del margen de %s en %s; copia cancelada para no llenar el disco",
				ErrNoSpace, humanBytes(free), humanBytes(g.margin), g.dir)
		}
	}
	n, err := g.w.Write(p)
	g.since += int64(n)
	return n, err
}

// logRcon registra en el log del job la respuesta a un comando de la copia. Minecraft
// contesta con texto aunque el comando falle («Unable to save the game», «Unknown or
// incomplete command»): esas respuestas se marcan con ATENCIÓN (la copia sigue: el disco
// conserva el último guardado completo).
func logRcon(log func(string), cmd, done, reply string) {
	reply = oneLine(reply)
	switch {
	case reply == "":
		log(cmd + ": " + done)
	case looksLikeFailure(reply):
		log("ATENCIÓN: respuesta inesperada a " + cmd + ": " + reply)
	default:
		log(cmd + ": " + done + " (" + reply + ")")
	}
}

func looksLikeFailure(reply string) bool {
	r := strings.ToLower(reply)
	for _, w := range []string{"unable", "unknown", "incorrect", "error", "fail", "cannot", "can't"} {
		if strings.Contains(r, w) {
			return true
		}
	}
	return false
}

// oneLine quita los códigos de color (§x), junta las líneas y recorta a maxReply bytes.
func oneLine(s string) string {
	var b strings.Builder
	skip := false
	for _, r := range s {
		switch {
		case skip:
			skip = false
		case r == '§':
			skip = true
		default:
			b.WriteRune(r)
		}
	}
	s = strings.Join(strings.Fields(b.String()), " ")
	if len(s) > maxReply {
		cut := maxReply
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
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
