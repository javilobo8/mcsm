package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/files"
	"mcsm/agent/internal/reconcile"
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
