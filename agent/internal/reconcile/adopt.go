package reconcile

import (
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

// Adopción en caliente de contenedores importados (plan-6, spec §6.7).
//
// Un importado sigue en su contenedor original (sin etiquetas mcsm.*) hasta el primer cambio de
// spec. El registro de adopción del store dice qué contenedor es y con qué versión de spec se
// adoptó. find lo devuelve como contenedor del servidor (Adopted, con mcsm.server_id y mcsm.slug
// sintetizados), así que logs, consola, power, copias y observación funcionan igual. reconcileLocked
// no lo recrea mientras la versión de la spec no supere la de la adopción; con una mayor lo para, lo
// borra (los datos están en el bind) y crea mcsm-<slug> con la misma carpeta de datos.
//
// La spec de un importado lleva "adopt" (lo añade el panel): si falta el registro (ImportAdopt
// perdido, store nuevo), reconcileLocked vuelve a adoptar con las mismas comprobaciones; si el
// original ya no existe crea el gestionado; si existe pero no cuadra, falla sin crear nada.
//
// Orden de locks: lock por servidor → adoptMu → r.mu.

var (
	ErrAdoptNotFound = errors.New("el contenedor a adoptar no existe")
	ErrAdoptConflict = errors.New("el contenedor ya está gestionado")
	ErrAdoptMismatch = errors.New("el contenedor no coincide con la spec")
	ErrAdoptSpec     = errors.New("spec de adopción inválida")
	// ErrDataPathUnverified: la spec trae un dataPath que el agente no verificó para ese servidor (H1).
	ErrDataPathUnverified = errors.New("carpeta de datos sin verificar")
)

// Adopt establece la adopción que pide el panel (ImportAdopt): comprueba el contenedor, lo conecta a
// la red del agente con el alias mcsm-<slug>, guarda spec y adopción en una transacción y reconcilia.
// Es idempotente. Una vez guardada la adopción no devuelve error por la reconciliación (queda en
// Observed): el panel ya no debe retirar el servidor, o el siguiente SyncSpecs borraría el original.
func (r *Reconciler) Adopt(ctx context.Context, sp *mcsmv1.ServerSpec) error {
	unlock := r.lock(sp.ServerId)
	defer unlock()
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAdoptSpec, err)
	}
	if parsed.Adopt == nil {
		return fmt.Errorf("%w: falta adopt", ErrAdoptSpec)
	}
	build, err := spec.BuildContainer(spec.Meta{ServerID: sp.ServerId, Slug: sp.Slug, Version: sp.Version}, parsed, r.dataRoot, r.network)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAdoptSpec, err)
	}
	// adoptMu se suelta antes de reconciliar: reconcileLocked puede llamar a readopt, que lo toma.
	if err := r.recordAdoption(ctx, sp, parsed, build.DataDir); err != nil {
		return err
	}
	if err := r.reconcileLocked(ctx, sp.ServerId); err != nil {
		r.log.Warn("reconciliar tras adoptar", "server", sp.Slug, "err", err)
	}
	return nil
}

// recordAdoption comprueba el contenedor y guarda spec, adopción y (con dataPath) la carpeta verificada,
// bajo adoptMu (requiere el lock del servidor). Si ya está adoptado por este servidor (reintento del
// panel con el Ack perdido), solo guarda la spec si no es más vieja.
func (r *Reconciler) recordAdoption(ctx context.Context, sp *mcsmv1.ServerSpec, parsed spec.Spec, dataDir string) error {
	a := parsed.Adopt
	r.adoptMu.Lock()
	defer r.adoptMu.Unlock()
	cur, err := r.st.Adoption(sp.ServerId)
	if err != nil {
		return err
	}
	if cur != nil && cur.ContainerID == a.ContainerID {
		stored, err := r.st.GetSpec(sp.ServerId)
		if err != nil {
			return err
		}
		if stored == nil || sp.Version >= stored.Version {
			return r.st.PutSpec(sp)
		}
		return nil
	}
	// Ni gestionado ni otro adoptado que siga existiendo: dos contenedores sobre el mismo mundo no.
	existing, err := r.find(ctx, sp.ServerId)
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("%w: el servidor ya tiene el contenedor %s", ErrAdoptConflict, existing.Name)
	}
	info, err := r.verifyAdoptable(ctx, sp.ServerId, a.ContainerID, dataDir)
	if err != nil {
		return err
	}
	if err := r.connectAlias(ctx, info, sp.Slug); err != nil {
		return err
	}
	return r.st.AdoptWithSpec(sp, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version}, externalPath(parsed, dataDir))
}

// externalPath es la carpeta que se registra como verificada al adoptar: dataDir si es un dataPath
// (fuera de DATA_ROOT); "" si los datos están en DATA_ROOT (esa ruta la decide el agente).
func externalPath(parsed spec.Spec, dataDir string) string {
	if parsed.DataPath == "" {
		return ""
	}
	return dataDir
}

// readopt vuelve a adoptar un importado sin registro (su spec trae adopt). Requiere el lock del
// servidor. Devuelve el contenedor adoptado, o nil si el original ya no existe (se creará el
// gestionado). Cualquier otro fallo para la reconciliación: nunca se crea un segundo contenedor
// sobre los datos de uno que no se pudo comprobar.
func (r *Reconciler) readopt(ctx context.Context, sp *mcsmv1.ServerSpec, parsed spec.Spec, dataDir string) (*docker.Container, error) {
	a := parsed.Adopt
	r.adoptMu.Lock()
	defer r.adoptMu.Unlock()
	info, err := r.verifyAdoptable(ctx, sp.ServerId, a.ContainerID, dataDir)
	if errors.Is(err, ErrAdoptNotFound) {
		r.log.Info("el contenedor original de un importado ya no existe: se crea el gestionado", "server", sp.Slug)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := r.connectAlias(ctx, info, sp.Slug); err != nil {
		return nil, err
	}
	if err := r.st.PutAdoption(sp.ServerId, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version}, externalPath(parsed, dataDir)); err != nil {
		return nil, err
	}
	r.log.Info("importado adoptado de nuevo desde su spec", "server", sp.Slug, "contenedor", info.Name)
	return adoptedContainer(sp.ServerId, sp.Slug, info.ID, info.Name, info.State), nil
}

// verifyAdoptable comprueba que el contenedor existe, no es de MC Server Manager ni de otro
// servidor, usa la imagen itzg, tiene red propia y monta en /data exactamente dataDir. Requiere adoptMu.
func (r *Reconciler) verifyAdoptable(ctx context.Context, serverID, containerID, dataDir string) (*docker.ImportInfo, error) {
	info, err := r.eng.InspectImport(ctx, containerID)
	if errors.Is(err, docker.ErrNotFound) {
		return nil, fmt.Errorf("%w: %s", ErrAdoptNotFound, containerID)
	}
	if err != nil {
		return nil, fmt.Errorf("inspeccionar el contenedor a adoptar: %w", err)
	}
	if info.Labels[spec.LabelManaged] == "true" {
		return nil, fmt.Errorf("%w: %s ya es un contenedor de MC Server Manager", ErrAdoptConflict, info.Name)
	}
	if other, err := r.st.AdoptedBy(info.ID); err != nil {
		return nil, err
	} else if other != "" && other != serverID {
		return nil, fmt.Errorf("%w: %s ya lo adoptó otro servidor", ErrAdoptConflict, info.Name)
	}
	if !spec.IsItzgImage(info.Image) {
		return nil, fmt.Errorf("%w: %s no usa la imagen %s (%s)", ErrAdoptMismatch, info.Name, spec.Image, info.Image)
	}
	if m := info.NetworkMode; m == "host" || m == "none" || strings.HasPrefix(m, "container:") {
		return nil, fmt.Errorf("%w: %s usa la red %q; solo se adoptan contenedores con red propia", ErrAdoptMismatch, info.Name, m)
	}
	for _, m := range info.Mounts {
		// Al recrearlo solo se monta /data: lo montado debajo (/data/world…) sería otra carpeta, vacía.
		if dest := path.Clean(m.Destination); strings.HasPrefix(dest, "/data/") {
			return nil, fmt.Errorf("%w: %s monta %s en %s, dentro de /data; muévelo a la carpeta de /data para importarlo", ErrAdoptMismatch, info.Name, m.Source, dest)
		}
	}
	if src := dataBind(info); src != filepath.Clean(dataDir) {
		return nil, fmt.Errorf("%w: el /data de %s es %q y la spec espera %q", ErrAdoptMismatch, info.Name, src, dataDir)
	}
	return info, nil
}

// dataBind es la carpeta del host montada (bind) en /data del contenedor, limpia, o "" si no hay.
func dataBind(info *docker.ImportInfo) string {
	for _, m := range info.Mounts {
		if path.Clean(m.Destination) == "/data" && m.Type == "bind" {
			return filepath.Clean(m.Source)
		}
	}
	return ""
}

// checkDataPath (H1): una spec con dataPath solo se monta si es la carpeta que el agente verificó para
// ese servidor al adoptar su contenedor (recordAdoption, readopt). Si no hay registro (store perdido),
// lo recupera del contenedor gestionado del servidor que ya la monta: solo lo crea el agente, y solo
// con una carpeta verificada. Si tampoco, falla sin tocar Docker. Requiere el lock del servidor.
func (r *Reconciler) checkDataPath(ctx context.Context, serverID string, parsed spec.Spec, existing *docker.Container) error {
	if parsed.DataPath == "" {
		return nil
	}
	reg, err := r.st.ExternalPath(serverID)
	if err != nil {
		return err
	}
	switch {
	case reg == parsed.DataPath:
		return nil
	case reg != "":
		return fmt.Errorf("%w: %s no es la carpeta que se verificó al importar el servidor (%s): no se monta", ErrDataPathUnverified, parsed.DataPath, reg)
	}
	if existing != nil && !existing.Adopted {
		info, err := r.eng.InspectImport(ctx, existing.ID)
		if err == nil && dataBind(info) == parsed.DataPath {
			r.log.Warn("carpeta de datos externa recuperada del contenedor gestionado (el store no la tenía)", "server", serverID, "carpeta", parsed.DataPath)
			return r.st.PutExternalPath(serverID, parsed.DataPath)
		}
	}
	return fmt.Errorf("%w: no se puede comprobar que %s sea la carpeta del contenedor importado (este agente no la verificó: ¿se perdió su store?). No se crea nada: elimina el servidor sin borrar datos y vuelve a importarlo", ErrDataPathUnverified, parsed.DataPath)
}

// connectAlias conecta el contenedor a la red del agente con el alias mcsm-<slug> (RCON, ping y
// métricas lo buscan por ese nombre). Si ya está en la red, no hace nada.
func (r *Reconciler) connectAlias(ctx context.Context, info *docker.ImportInfo, slug string) error {
	for _, n := range info.Networks {
		if n == r.network {
			return nil
		}
	}
	if err := r.eng.ConnectNetwork(ctx, r.network, info.ID, []string{spec.ContainerName(slug)}); err != nil {
		return fmt.Errorf("conectar %s a la red %s: %w", info.Name, r.network, err)
	}
	return nil
}

func adoptedContainer(serverID, slug, id, name, state string) *docker.Container {
	return &docker.Container{ID: id, Name: name, State: state, Adopted: true,
		Labels: map[string]string{spec.LabelServerID: serverID, spec.LabelSlug: slug}}
}

// findAdopted devuelve el contenedor adoptado del servidor, o nil si no hay adopción o su
// contenedor ya no existe (reconcileLocked limpia entonces el registro).
func (r *Reconciler) findAdopted(ctx context.Context, serverID string) (*docker.Container, error) {
	ad, err := r.st.Adoption(serverID)
	if err != nil || ad == nil {
		return nil, err
	}
	ins, err := r.eng.Inspect(ctx, ad.ContainerID)
	if errors.Is(err, docker.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspeccionar el contenedor adoptado: %w", err)
	}
	return adoptedContainer(serverID, ad.Slug, ins.ID, ins.Name, ins.State), nil
}

// ServerContainers devuelve los contenedores de los servidores del nodo: los gestionados y los
// adoptados aún sin recrear (Adopted, con etiquetas sintetizadas). Lo usa el muestreador de
// métricas. Un adoptado que ya no existe se omite.
func (r *Reconciler) ServerContainers(ctx context.Context) ([]docker.Container, error) {
	list, err := r.eng.ListManaged(ctx)
	if err != nil {
		return nil, err
	}
	ads, err := r.st.Adoptions()
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, c := range list {
		have[c.Labels[spec.LabelServerID]] = true
	}
	ids := make([]string, 0, len(ads))
	for id := range ads {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if have[id] {
			continue
		}
		ad := ads[id]
		ins, err := r.eng.Inspect(ctx, ad.ContainerID)
		if errors.Is(err, docker.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		list = append(list, *adoptedContainer(id, ad.Slug, ins.ID, ins.Name, ins.State))
	}
	return list, nil
}
