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
	"regexp"
	"time"
)

// migratedInfix: <slug>.migrated-<ts> es el directorio de un servidor que conserva el nodo origen
// tras una migración confirmada (spec §7, paso 7).
const migratedInfix = ".migrated-"

var sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// MigratedName es el nombre con que se aparta, junto a él, el directorio de un servidor del nodo
// origen al confirmar una migración: p. ej. survival.migrated-20261012T040000.000Z. Conserva data y
// sus copias y deja libre <slug> (el servidor puede volver, o crearse otro con ese slug).
func MigratedName(serverDir string, t time.Time) string {
	return filepath.Base(serverDir) + migratedInfix + t.UTC().Format(tsLayout)
}

// CheckSpace falla, envolviendo ErrNoSpace, si en dir no caben need bytes más el margen
// max(5 %, 256 MiB) con el que los servidores del nodo siguen pudiendo guardar. Si no se puede
// consultar el espacio libre no falla: lo vigilan después las escrituras. free nil usa statfs.
func CheckSpace(dir string, need int64, what string, free func(dir string) (uint64, error)) error {
	if free == nil {
		free = freeSpace
	}
	got, err := free(dir)
	if err != nil {
		return nil
	}
	n := uint64(max(need, 0))
	if req := requiredSpace(need); got < req {
		return fmt.Errorf("%w para %s: hacen falta %s (%s más un margen de %s para que los servidores del nodo sigan pudiendo guardar) y quedan %s libres en %s; faltan %s",
			ErrNoSpace, what, humanBytes(req), humanBytes(n), humanBytes(req-n), humanBytes(got), dir, humanBytes(req-got))
	}
	return nil
}

// ReceiveRequest describe una copia que llega de otro nodo (migración, spec §7).
type ReceiveRequest struct {
	BackupsDir string
	ServerID   string
	Slug       string
	Filename   string    // <slug>-<ts>-<versión>.tar.zst (ValidName con Slug)
	Body       io.Reader // la copia; se leen como mucho Size+1 bytes
	Size       int64     // bytes exactos que deben llegar
	SHA256     string    // hex en minúsculas del fichero completo
	// ExtractBytes es lo que ocupará extraída (0 = desconocido: se toma Size). Mientras llega se
	// exige que siga cabiendo con el margen: la restauración va justo después.
	ExtractBytes int64
	Now          func() time.Time
	FreeSpace    func(dir string) (uint64, error) // nil: statfs
	Progress     func(done, total int64)
}

// Receive escribe la copia como <Filename>.partial en BackupsDir calculando su sha256 y, solo si
// llegan exactamente Size bytes con ese sha256, escribe su .json (trigger pre_migration) y la
// renombra a su nombre final: Restore la vuelve a verificar con ese .json. Si algo falla, se
// cancela o deja de haber espacio, no deja nada (ni parcial ni .json) y nunca pisa una copia
// existente.
func Receive(ctx context.Context, req ReceiveRequest) (meta Meta, err error) {
	if req.Now == nil {
		req.Now = time.Now
	}
	if req.FreeSpace == nil {
		req.FreeSpace = freeSpace
	}
	if req.Progress == nil {
		req.Progress = func(int64, int64) {}
	}
	if !ValidName(req.Slug, req.Filename) {
		return Meta{}, fmt.Errorf("nombre de copia inválido %q", req.Filename)
	}
	if req.Size <= 0 || !sha256Re.MatchString(req.SHA256) {
		return Meta{}, errors.New("tamaño o sha256 de la copia inválidos")
	}
	started, version, _ := parseName(req.Slug, req.Filename)
	if err := os.MkdirAll(req.BackupsDir, 0o750); err != nil {
		return Meta{}, fmt.Errorf("crear el directorio de copias: %w", err)
	}
	final := filepath.Join(req.BackupsDir, req.Filename)
	if _, serr := os.Lstat(final); serr == nil {
		return Meta{}, fmt.Errorf("la copia %s ya existe", req.Filename)
	}
	extract := req.ExtractBytes
	if extract <= 0 {
		extract = req.Size
	}
	partial := final + partialExt
	f, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return Meta{}, fmt.Errorf("crear la copia: %w", err)
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
	// Lo que debe seguir libre mientras llega: la extracción que viene después, con su margen.
	guard := &spaceGuard{w: f, free: req.FreeSpace, dir: req.BackupsDir, margin: requiredSpace(extract), since: -1}
	src := &progressReader{r: ctxReader{ctx: ctx, r: io.LimitReader(req.Body, req.Size+1)}, total: req.Size, fn: req.Progress}
	var n int64
	n, err = io.Copy(io.MultiWriter(guard, h), src)
	if err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return Meta{}, fmt.Errorf("recepción cancelada: %w", cerr)
		}
		return Meta{}, fmt.Errorf("recibir la copia: %w", err)
	}
	if n < req.Size {
		return Meta{}, fmt.Errorf("la copia llegó incompleta: %d bytes de %d", n, req.Size)
	}
	if n > req.Size {
		return Meta{}, fmt.Errorf("la copia llegó con bytes de más: se esperaban %d", req.Size)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if sum != req.SHA256 {
		return Meta{}, fmt.Errorf("la copia llegó dañada: sha256 %s, esperado %s", sum, req.SHA256)
	}
	if err = f.Sync(); err != nil {
		return Meta{}, fmt.Errorf("guardar la copia en disco: %w", err)
	}
	closed = true
	if err = f.Close(); err != nil {
		return Meta{}, fmt.Errorf("guardar la copia en disco: %w", err)
	}
	meta = Meta{
		Filename: req.Filename, ServerID: req.ServerID, Slug: req.Slug, SpecVersion: version, Trigger: TriggerPreMigration,
		SizeBytes: req.Size, SHA256: sum, StartedAt: started.UTC(), FinishedAt: req.Now().UTC(), DataBytes: req.ExtractBytes,
	}
	if err = WriteMeta(req.BackupsDir, meta); err != nil {
		return Meta{}, fmt.Errorf("guardar los metadatos de la copia: %w", err)
	}
	if err = rename(partial, final); err != nil {
		_ = os.Remove(final + MetaExt)
		return Meta{}, fmt.Errorf("guardar la copia: %w", err)
	}
	_ = syncDir(req.BackupsDir)
	return meta, nil
}
