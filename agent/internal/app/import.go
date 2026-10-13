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

// Import of existing containers (plan-6, spec §6.7).

// importScanTimeout bounds the scan (one list and one inspect per host container).
const importScanTimeout = 20 * time.Second

// handleImportScan answers with the import candidates. It only reads: it uses the session's context.
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

// handleImportAdopt adopts a container (it touches Docker and the store: the agent's life context).
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

// adoptErrCode translates a Reconciler.Adopt failure to the protocol's Error.code.
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

// serverContainers is what the metrics sampler measures (stats.Containers): the managed and adopted
// containers, with mcsm.server_id and mcsm.slug (ping to mcsm-<slug>, the network alias).
type serverContainers struct{ a *App }

func (c serverContainers) ListManaged(ctx context.Context) ([]docker.Container, error) {
	return c.a.rec.ServerContainers(ctx)
}

func (c serverContainers) Stats(ctx context.Context, id string) (docker.Stats, error) {
	return c.a.eng.Stats(ctx, id)
}

// errExternalData: the server keeps its data outside DATA_ROOT (dataPath) and the agent does not see it
// (it only mounts DATA_ROOT, spec §6.1): neither backups nor files.
var errExternalData = errors.New("data outside DATA_ROOT")

func externalDataSpec(s spec.Spec) error {
	if s.DataPath == "" {
		return nil
	}
	return fmt.Errorf("%w: the data of this server is at %s, outside DATA_ROOT, and the agent does not see it; "+
		"there are no backups or files. To have them, remove the server without deleting data, move that folder "+
		"to DATA_ROOT/<slug>/data and import it again", errExternalData, s.DataPath)
}

// externalData is externalDataSpec for a server in the store; nil if it does not exist or its spec cannot be read
// (the caller is responsible for that).
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
