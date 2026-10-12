package app

import (
	"context"
	"errors"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/importer"
	"mcsm/agent/internal/reconcile"
)

// Importación de contenedores existentes (plan-6, spec §6.7).

// importScanTimeout acota el escaneo (una lista y un inspect por contenedor del host).
const importScanTimeout = 20 * time.Second

// handleImportScan responde con los candidatos a importar. Solo lee: usa el contexto de la sesión.
func (a *App) handleImportScan(ctx context.Context, id uint64, send func(*mcsmv1.Envelope) error) {
	cctx, cancel := context.WithTimeout(ctx, importScanTimeout)
	defer cancel()
	ads, err := a.st.Adoptions()
	if err != nil {
		_ = send(errMsg(id, errcode.IOError, err))
		return
	}
	adopted := make(map[string]bool, len(ads))
	for _, ad := range ads {
		adopted[ad.ContainerID] = true
	}
	list, err := importer.Scan(cctx, a.eng, func(cid string) bool { return adopted[cid] })
	if err != nil {
		_ = send(errMsg(id, errcode.IOError, err))
		return
	}
	_ = send(&mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_ImportScanResult{ImportScanResult: &mcsmv1.ImportScanResult{
		Candidates: list, DataRoot: a.cfg.DataRoot,
	}}})
}

// handleImportAdopt adopta un contenedor (toca Docker y el store: contexto de vida del agente).
func (a *App) handleImportAdopt(id uint64, m *mcsmv1.ImportAdopt, send func(*mcsmv1.Envelope) error) {
	sp := m.GetServer()
	if err := validSpecMsg(sp); err != nil {
		_ = send(errMsg(id, errcode.InvalidSpec, err))
		return
	}
	if err := a.rec.Adopt(a.life, sp); err != nil {
		_ = send(errMsg(id, adoptErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// adoptErrCode traduce un fallo de Reconciler.Adopt al Error.code del protocolo.
func adoptErrCode(err error) string {
	switch {
	case errors.Is(err, reconcile.ErrAdoptNotFound):
		return errcode.NotFound
	case errors.Is(err, reconcile.ErrAdoptConflict):
		return errcode.Exists
	case errors.Is(err, reconcile.ErrAdoptMismatch):
		return errcode.InvalidRequest
	case errors.Is(err, reconcile.ErrAdoptSpec):
		return errcode.InvalidSpec
	case errors.Is(err, reconcile.ErrBusy):
		return errcode.Busy
	default:
		return errcode.ApplyFailed
	}
}
