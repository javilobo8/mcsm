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
	if err := r.recordAdoption(ctx, sp, parsed.Adopt, build.DataDir); err != nil {
		return err
	}
	if err := r.reconcileLocked(ctx, sp.ServerId); err != nil {
		r.log.Warn("reconciliar tras adoptar", "server", sp.Slug, "err", err)
	}
	return nil
}

// recordAdoption comprueba el contenedor y guarda spec y adopción, bajo adoptMu (requiere el lock
// del servidor). Si ya está adoptado por este servidor (reintento del panel con el Ack perdido),
// solo guarda la spec si no es más vieja.
func (r *Reconciler) recordAdoption(ctx context.Context, sp *mcsmv1.ServerSpec, a *spec.Adopt, dataDir string) error {
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
	return r.st.AdoptWithSpec(sp, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version})
}

// readopt vuelve a adoptar un importado sin registro (su spec trae adopt). Requiere el lock del
// servidor. Devuelve el contenedor adoptado, o nil si el original ya no existe (se creará el
// gestionado). Cualquier otro fallo para la reconciliación: nunca se crea un segundo contenedor
// sobre los datos de uno que no se pudo comprobar.
func (r *Reconciler) readopt(ctx context.Context, sp *mcsmv1.ServerSpec, a *spec.Adopt, dataDir string) (*docker.Container, error) {
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
	if err := r.st.PutAdoption(sp.ServerId, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version}); err != nil {
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
	src := ""
	for _, m := range info.Mounts {
		dest := path.Clean(m.Destination)
		if dest == "/data" && m.Type == "bind" {
			src = filepath.Clean(m.Source)
		}
		// Al recrearlo solo se monta /data: lo montado debajo (/data/world…) sería otra carpeta, vacía.
		if strings.HasPrefix(dest, "/data/") {
			return nil, fmt.Errorf("%w: %s monta %s en %s, dentro de /data; muévelo a la carpeta de /data para importarlo", ErrAdoptMismatch, info.Name, m.Source, dest)
		}
	}
	if src != filepath.Clean(dataDir) {
		return nil, fmt.Errorf("%w: el /data de %s es %q y la spec espera %q", ErrAdoptMismatch, info.Name, src, dataDir)
	}
	return info, nil
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
