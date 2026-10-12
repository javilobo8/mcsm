package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/files"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
)

// Migración entre nodos (Plan 7, spec §7). El panel orquesta; el agente ejecuta pasos
// idempotentes. Origen: BackupPush (sube la copia pre_migration al panel) y MigrateRetire (lo
// retira al confirmar). Destino: MigrateReceive (recibe y restaura) y MigrateAbort (deshace).

// errMigrateExists: el destino ya tiene el servidor o su directorio; no se pisa nada.
var errMigrateExists = errors.New("ya existe")

// migrateErrCode traduce un fallo de los mensajes de migración al Error.code del protocolo.
func migrateErrCode(err error) string {
	switch {
	case errors.Is(err, reconcile.ErrBusy), errors.Is(err, errTransfersBusy), errors.Is(err, errClosing), errors.Is(err, errFilesClosing):
		return errcode.Busy
	case errors.Is(err, errUnknownServer):
		return errcode.UnknownServer
	case errors.Is(err, errBadRequest):
		return errcode.InvalidRequest
	case errors.Is(err, errMigrateExists):
		return errcode.Exists
	case errors.Is(err, backup.ErrNoSpace):
		return errcode.TooLarge
	case errors.Is(err, files.ErrTransfer):
		return errcode.TransferFailed
	case errors.Is(err, fs.ErrNotExist):
		return errcode.NotFound
	default:
		return errcode.BackupFailed
	}
}

// handleBackupPush sube una copia al panel (PUT /agent/transfer/{id}) y responde con sus
// metadatos cuando el panel la ha recibido entera. Cuenta como Files* en curso para el cierre
// (xfer.enter) y ocupa uno de los huecos de transferencia del nodo. ctx: el de vida del agente.
func (a *App) handleBackupPush(ctx context.Context, id uint64, m *mcsmv1.BackupPush, send func(*mcsmv1.Envelope) error) {
	if !a.xfer.enter() {
		_ = send(errMsg(id, errcode.Busy, errFilesClosing))
		return
	}
	defer a.xfer.leave()
	res, err := a.backupPush(ctx, m)
	if err != nil {
		_ = send(errMsg(id, migrateErrCode(err), err))
		return
	}
	_ = send(&mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_BackupPushResult{BackupPushResult: res}})
}

func (a *App) backupPush(ctx context.Context, m *mcsmv1.BackupPush) (*mcsmv1.BackupPushResult, error) {
	t, err := a.bk.target(m.GetServerId())
	if err != nil {
		return nil, err
	}
	if !backup.ValidName(t.slug, m.GetFilename()) {
		return nil, fmt.Errorf("%w: nombre de copia inválido %q", errBadRequest, m.GetFilename())
	}
	meta, err := backup.ReadMeta(t.backupsDir, m.GetFilename())
	if err != nil || meta.SHA256 == "" {
		return nil, fmt.Errorf("la copia %s no tiene sha256 en su .json: no se envía sin poder comprobarla", m.GetFilename())
	}
	// Abierta antes de reclamar la transferencia: una copia que ya no existe no la consume. El
	// descriptor sigue valiendo aunque la poda la borre mientras se envía.
	f, err := os.Open(filepath.Join(t.backupsDir, m.GetFilename()))
	if err != nil {
		return nil, fmt.Errorf("abrir la copia: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: la copia no es un fichero normal", errBadRequest)
	}
	xfer, err := a.transfers()
	if err != nil {
		return nil, err
	}
	release, err := a.xfer.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	size := fi.Size()
	err = a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		// LimitReader: se manda lo que medía al abrirla; si encoge, Put falla por Content-Length.
		if err := xfer.Put(ctx, m.GetTransferId(), track(io.LimitReader(f, size)), size); err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &mcsmv1.BackupPushResult{SizeBytes: uint64(size), Sha256: meta.SHA256, DataBytes: uint64(max(meta.DataBytes, 0))}, nil
}

// ── Recepción en el destino ──

const (
	// jobTypeMigrateIn es el tipo de job de la recepción (JobProgress.type, inventario).
	jobTypeMigrateIn = "migrate_in"
	// holdMigration es el motivo de la reserva durante los pasos de una migración.
	holdMigration = "migración"
	// migrationMarker se crea en <DATA_ROOT>/<slug> al recibir una migración y contiene su id:
	// MigrateAbort solo borra un directorio con el marcador de esa misma migración.
	migrationMarker = ".mcsm-migration"
	// maxMigrateBytes acota size_bytes y data_bytes (un valor absurdo desbordaría las cuentas).
	maxMigrateBytes = 1 << 50
)

var migrateSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (b *backupService) handleMigrateReceive(id uint64, m *mcsmv1.MigrateReceive, send func(*mcsmv1.Envelope) error) {
	if err := b.startReceive(m); err != nil {
		_ = send(errMsg(id, migrateErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// startReceive valida, registra el job (un job_id ya conocido reenvía su estado, §5.4),
// comprueba que ni el servidor ni su directorio existen en este nodo y que cabe la copia más su
// extracción con el margen, reserva el servidor y lanza la recepción en segundo plano.
func (b *backupService) startReceive(m *mcsmv1.MigrateReceive) error {
	if m.GetJobId() == "" || m.GetServerId() == "" || m.GetMigrationId() == "" {
		return fmt.Errorf("%w: faltan job_id, server_id o migration_id", errBadRequest)
	}
	if !spec.ValidSlug(m.GetSlug()) || !backup.ValidName(m.GetSlug(), m.GetFilename()) {
		return fmt.Errorf("%w: slug o nombre de copia no válidos", errBadRequest)
	}
	if m.GetSizeBytes() == 0 || m.GetSizeBytes() > maxMigrateBytes || m.GetDataBytes() > maxMigrateBytes || !migrateSHA256.MatchString(m.GetSha256()) {
		return fmt.Errorf("%w: tamaño o sha256 de la copia no válidos", errBadRequest)
	}
	j, existing, err := b.jobs.Begin(m.GetJobId(), m.GetServerId(), jobTypeMigrateIn)
	if err != nil {
		return err
	}
	if existing != nil {
		b.jobs.Replay(existing)
		return nil
	}
	fail := func(err error) error {
		b.finish(j, err, "")
		return err
	}
	sp, err := b.a.st.GetSpec(m.GetServerId())
	if err != nil {
		return fail(err)
	}
	if sp != nil {
		return fail(fmt.Errorf("%w: el servidor ya está en este nodo", errMigrateExists))
	}
	dir := filepath.Join(b.a.cfg.DataRoot, m.GetSlug())
	if _, err := os.Lstat(dir); err == nil {
		return fail(fmt.Errorf("%w: %s ya existe en el nodo destino; muévelo o bórralo antes de migrar aquí", errMigrateExists, dir))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fail(err)
	}
	size, extract := int64(m.GetSizeBytes()), int64(m.GetDataBytes())
	if extract <= 0 {
		extract = size
	}
	if err := backup.CheckSpace(b.a.cfg.DataRoot, size+extract, "recibir la migración", b.freeSpace); err != nil {
		return fail(err)
	}
	// Reserva sin spec: un ApplySpec que llegara durante la recepción solo se guarda; se aplica
	// (y crea el contenedor) al liberar, ya con data restaurado. Ningún Files* puede escribir en este
	// servidor (serverFS responde unknown_server antes de fileWrites.enter): no hay escrituras que esperar.
	release, err := b.a.rec.Hold(m.GetServerId(), holdMigration)
	if err != nil {
		return fail(err)
	}
	if !b.spawn(func() { b.runReceive(m, dir, j, release) }) {
		release(b.a.life)
		return fail(errClosing)
	}
	return nil
}

func (b *backupService) runReceive(m *mcsmv1.MigrateReceive, dir string, j *jobs.Job, release func(context.Context)) {
	ctx := b.a.life
	err := b.withSlot(ctx, j, func() error { return b.receive(ctx, m, dir, j) })
	err = interrupted(ctx, err)
	release(b.a.life) // normalmente sin spec: no hay nada que reconciliar
	b.finish(j, err, "Copia recibida, verificada y restaurada en "+filepath.Join(dir, "data"))
}

// receive crea <DATA_ROOT>/<slug> (exclusivo) con el marcador de la migración, descarga la copia
// a su backups/ comprobando tamaño y sha256, y la restaura como data/ con backup.Restore (que la
// verifica otra vez, comprueba el espacio y acota la extracción). Si algo falla, borra el
// directorio entero: lo ha creado esta recepción.
func (b *backupService) receive(ctx context.Context, m *mcsmv1.MigrateReceive, dir string, j *jobs.Job) (err error) {
	if err := os.Mkdir(dir, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%w: %s ya existe en el nodo destino", errMigrateExists, dir)
		}
		return fmt.Errorf("crear %s: %w", dir, err)
	}
	defer func() {
		if err == nil {
			return
		}
		if rerr := os.RemoveAll(dir); rerr != nil {
			j.Log("aviso: no se pudo borrar " + dir + " (bórralo a mano): " + rerr.Error())
		}
	}()
	if err := os.WriteFile(filepath.Join(dir, migrationMarker), []byte(m.GetMigrationId()+"\n"), 0o644); err != nil {
		return fmt.Errorf("marcar el directorio de la migración: %w", err)
	}
	xfer, err := b.a.transfers()
	if err != nil {
		return err
	}
	releaseSlot, err := b.a.xfer.acquire()
	if err != nil {
		return err
	}
	backupsDir := backup.Dir(b.a.cfg.DataRoot, m.GetSlug())
	size := int64(m.GetSizeBytes())
	j.Progress(1, "Recibiendo la copia desde el panel")
	err = b.a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		body, got, err := xfer.Get(ctx, m.GetTransferId())
		if err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		defer body.Close()
		if got >= 0 && got != size {
			return fmt.Errorf("%w: el panel anuncia %d bytes y la copia mide %d", files.ErrTransfer, got, size)
		}
		_, err = backup.Receive(ctx, backup.ReceiveRequest{
			BackupsDir: backupsDir, ServerID: m.GetServerId(), Slug: m.GetSlug(), Filename: m.GetFilename(),
			Body: track(body), Size: size, SHA256: m.GetSha256(), ExtractBytes: int64(m.GetDataBytes()),
			Now: b.clock.Now, FreeSpace: b.freeSpace,
			Progress: func(done, total int64) {
				j.Progress(1+uint32(done*49/max(total, 1)), "Recibiendo la copia desde el panel")
			},
		})
		return err
	})
	releaseSlot()
	if err != nil {
		return err
	}
	j.Log("copia recibida y verificada (sha256 " + m.GetSha256() + ")")
	_, err = b.restore(ctx, backup.RestoreRequest{
		ServerID: m.GetServerId(), Slug: m.GetSlug(), Filename: m.GetFilename(),
		DataDir: filepath.Join(dir, "data"), BackupsDir: backupsDir, Now: b.clock.Now,
		Progress: func(pct uint32, msg string) { j.Progress(50+pct/2, msg) }, Log: j.Log,
	})
	return err
}
