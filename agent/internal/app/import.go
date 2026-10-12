package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/importer"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
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

// serverContainers es lo que mide el muestreador de métricas (stats.Containers): los contenedores
// gestionados y los adoptados, con mcsm.server_id y mcsm.slug (ping a mcsm-<slug>, el alias de red).
type serverContainers struct{ a *App }

func (c serverContainers) ListManaged(ctx context.Context) ([]docker.Container, error) {
	return c.a.rec.ServerContainers(ctx)
}

func (c serverContainers) Stats(ctx context.Context, id string) (docker.Stats, error) {
	return c.a.eng.Stats(ctx, id)
}

// errExternalData: el servidor guarda sus datos fuera de DATA_ROOT (dataPath) y el agente no los ve
// (solo monta DATA_ROOT, spec §6.1): ni copias ni archivos.
var errExternalData = errors.New("datos fuera de DATA_ROOT")

func externalDataSpec(s spec.Spec) error {
	if s.DataPath == "" {
		return nil
	}
	return fmt.Errorf("%w: los datos de este servidor están en %s, fuera de DATA_ROOT, y el agente no los ve; "+
		"no hay copias de seguridad ni archivos. Para tenerlos, para el servidor, mueve esa carpeta a DATA_ROOT/<slug>/data "+
		"y quita dataPath de su configuración", errExternalData, s.DataPath)
}

// externalData es externalDataSpec para un servidor del store; nil si no existe o su spec no se lee
// (de eso responde quien llama).
func (a *App) externalData(serverID string) error {
	sp, err := a.st.GetSpec(serverID)
	if err != nil || sp == nil {
		return nil
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return nil
	}
	return externalDataSpec(parsed)
}
