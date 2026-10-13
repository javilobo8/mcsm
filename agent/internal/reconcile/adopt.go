package reconcile

import (
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

// Hot adoption of imported containers (plan-6, spec §6.7).
//
// An imported server stays in its original container (without mcsm.* labels) until the first spec
// change. The store's adoption record says which container it is and which spec version it was
// adopted with. find returns it as the server's container (Adopted, with mcsm.server_id and mcsm.slug
// synthesized), so logs, console, power, backups and observation work the same. reconcileLocked
// does not recreate it while the spec version does not exceed the adoption's; with a higher one it stops it,
// deletes it (the data is in the bind) and creates mcsm-<slug> with the same data folder.
//
// An imported server's spec carries "adopt" (added by the panel): if the record is missing (ImportAdopt
// lost, new store), reconcileLocked adopts again with the same checks; if the original
// no longer exists it creates the managed one; if it exists but does not match, it fails without creating anything.
//
// Lock order: per-server lock → adoptMu → r.mu.

var (
	ErrAdoptNotFound = errors.New("the container to adopt does not exist")
	ErrAdoptConflict = errors.New("the container is already managed")
	ErrAdoptMismatch = errors.New("the container does not match the spec")
	ErrAdoptSpec     = errors.New("invalid adoption spec")
	// ErrDataPathUnverified: the spec carries a dataPath that the agent did not verify for that server (H1).
	ErrDataPathUnverified = errors.New("unverified data folder")
	// ErrDataInUse: another unmanaged itzg container already mounts the data folder (M2).
	ErrDataInUse = errors.New("data folder in use by another container")
)

// Adopt establishes the adoption the panel asks for (ImportAdopt): it checks the container, connects it to
// the agent's network with the alias mcsm-<slug>, stores spec and adoption in a transaction and reconciles.
// It is idempotent. Once the adoption is stored it does not return an error for the reconciliation (it stays in
// Observed): the panel must no longer withdraw the server, or the next SyncSpecs would delete the original.
func (r *Reconciler) Adopt(ctx context.Context, sp *mcsmv1.ServerSpec) error {
	unlock := r.lock(sp.ServerId)
	defer unlock()
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAdoptSpec, err)
	}
	if parsed.Adopt == nil {
		return fmt.Errorf("%w: adopt is missing", ErrAdoptSpec)
	}
	build, err := spec.BuildContainer(spec.Meta{ServerID: sp.ServerId, Slug: sp.Slug, Version: sp.Version}, parsed, r.dataRoot, r.network)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAdoptSpec, err)
	}
	// adoptMu is released before reconciling: reconcileLocked may call readopt, which takes it.
	if err := r.recordAdoption(ctx, sp, parsed, build.DataDir); err != nil {
		return err
	}
	if err := r.reconcileLocked(ctx, sp.ServerId); err != nil {
		r.log.Warn("reconcile after adopting", "server", sp.Slug, "err", err)
	}
	return nil
}

// recordAdoption checks the container and stores spec, adoption and (with dataPath) the verified folder,
// under adoptMu (it requires the server's lock). If it is already adopted by this server (a panel
// retry with the Ack lost), it only stores the spec if it is not older.
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
	// Neither managed nor another adopted one that still exists: two containers over the same world are not allowed.
	existing, err := r.find(ctx, sp.ServerId)
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("%w: the server already has the container %s", ErrAdoptConflict, existing.Name)
	}
	info, err := r.verifyAdoptable(ctx, sp.ServerId, a.ContainerID, dataDir)
	if err != nil {
		return err
	}
	undo, err := r.connectAlias(ctx, info, sp.Slug)
	if err != nil {
		return err
	}
	if err := r.st.AdoptWithSpec(sp, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version}, externalPath(parsed, dataDir)); err != nil {
		undo() // m12: without an adoption, the mcsm-<slug> alias is left over
		return err
	}
	return nil
}

// externalPath is the folder registered as verified when adopting: dataDir if it is a dataPath
// (outside DATA_ROOT); "" if the data is in DATA_ROOT (the agent decides that path).
func externalPath(parsed spec.Spec, dataDir string) string {
	if parsed.DataPath == "" {
		return ""
	}
	return dataDir
}

// readopt adopts an imported server without a record again (its spec carries adopt). It requires the
// server's lock. It returns the adopted container, or nil if the original no longer exists (the
// managed one will be created). Any other failure stops the reconciliation: a second container is never created
// over the data of one that could not be checked.
func (r *Reconciler) readopt(ctx context.Context, sp *mcsmv1.ServerSpec, parsed spec.Spec, dataDir string) (*docker.Container, error) {
	a := parsed.Adopt
	r.adoptMu.Lock()
	defer r.adoptMu.Unlock()
	info, err := r.verifyAdoptable(ctx, sp.ServerId, a.ContainerID, dataDir)
	if errors.Is(err, ErrAdoptNotFound) {
		r.log.Info("an imported server's original container no longer exists: the managed one is created", "server", sp.Slug)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	undo, err := r.connectAlias(ctx, info, sp.Slug)
	if err != nil {
		return nil, err
	}
	if err := r.st.PutAdoption(sp.ServerId, store.Adoption{ContainerID: info.ID, Slug: sp.Slug, Version: a.Version}, externalPath(parsed, dataDir)); err != nil {
		undo()
		return nil, err
	}
	r.log.Info("imported server adopted again from its spec", "server", sp.Slug, "container", info.Name)
	return adoptedContainer(sp.ServerId, sp.Slug, info.ID, info.Name, info.State), nil
}

// verifyAdoptable checks that the container exists, is not MC Server Manager's or another
// server's, uses the itzg image, has its own network and mounts exactly dataDir at /data. Requires adoptMu.
func (r *Reconciler) verifyAdoptable(ctx context.Context, serverID, containerID, dataDir string) (*docker.ImportInfo, error) {
	info, err := r.eng.InspectImport(ctx, containerID)
	if errors.Is(err, docker.ErrNotFound) {
		return nil, fmt.Errorf("%w: %s", ErrAdoptNotFound, containerID)
	}
	if err != nil {
		return nil, fmt.Errorf("inspect the container to adopt: %w", err)
	}
	if info.Labels[spec.LabelManaged] == "true" {
		return nil, fmt.Errorf("%w: %s is already an MC Server Manager container", ErrAdoptConflict, info.Name)
	}
	if other, err := r.st.AdoptedBy(info.ID); err != nil {
		return nil, err
	} else if other != "" && other != serverID {
		return nil, fmt.Errorf("%w: %s was already adopted by another server", ErrAdoptConflict, info.Name)
	}
	if !spec.IsItzgImage(info.Image) {
		return nil, fmt.Errorf("%w: %s does not use the image %s (%s)", ErrAdoptMismatch, info.Name, spec.Image, info.Image)
	}
	if m := info.NetworkMode; m == "host" || m == "none" || strings.HasPrefix(m, "container:") {
		return nil, fmt.Errorf("%w: %s uses the network %q; only containers with their own network are adopted", ErrAdoptMismatch, info.Name, m)
	}
	for _, m := range info.Mounts {
		// When recreating it only /data is mounted: what is mounted below (/data/world…) would be another, empty folder.
		if dest := path.Clean(m.Destination); strings.HasPrefix(dest, "/data/") {
			return nil, fmt.Errorf("%w: %s mounts %s at %s, inside /data; move it to the /data folder to import it", ErrAdoptMismatch, info.Name, m.Source, dest)
		}
	}
	if src := dataBind(info); src != filepath.Clean(dataDir) {
		return nil, fmt.Errorf("%w: the /data of %s is %q and the spec expects %q", ErrAdoptMismatch, info.Name, src, dataDir)
	}
	return info, nil
}

// dataBind is the host folder mounted (bind) at the container's /data, clean, or "" if there is none.
func dataBind(info *docker.ImportInfo) string {
	for _, m := range info.Mounts {
		if path.Clean(m.Destination) == "/data" && m.Type == "bind" {
			return filepath.Clean(m.Source)
		}
	}
	return ""
}

// checkDataPath (H1): a spec with dataPath is only mounted if it is the folder the agent verified for
// that server when adopting its container (recordAdoption, readopt). If there is no record (lost store),
// it recovers it from the server's managed container that already mounts it: only the agent creates it, and only
// with a verified folder. Otherwise, it fails without touching Docker. Requires the server's lock.
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
		return fmt.Errorf("%w: %s is not the folder that was verified when importing the server (%s): it is not mounted", ErrDataPathUnverified, parsed.DataPath, reg)
	}
	if existing != nil && !existing.Adopted {
		info, err := r.eng.InspectImport(ctx, existing.ID)
		if err == nil && dataBind(info) == parsed.DataPath {
			r.log.Warn("external data folder recovered from the managed container (the store did not have it)", "server", serverID, "folder", parsed.DataPath)
			return r.st.PutExternalPath(serverID, parsed.DataPath)
		}
	}
	return fmt.Errorf("%w: cannot verify that %s is the imported container's folder (this agent did not verify it: was its store lost?). Nothing is created: remove the server without deleting data and import it again", ErrDataPathUnverified, parsed.DataPath)
}

// checkDataFree (M2) fails if any unmanaged itzg container, except exclude (the one about to be
// replaced), mounts dataDir at /data. It is for imported servers before creating their managed one: if the original
// disappeared because Compose recreated it with another id, creating mcsm-<slug> would put two servers over the
// same world. Requires the server's lock.
func (r *Reconciler) checkDataFree(ctx context.Context, dataDir, exclude string) error {
	all, err := r.eng.ListAll(ctx)
	if err != nil {
		return fmt.Errorf("list containers: %w", err)
	}
	want := filepath.Clean(dataDir)
	for _, c := range all {
		if c.ID == exclude || c.Labels[spec.LabelManaged] == "true" {
			continue
		}
		info, err := r.eng.InspectImport(ctx, c.ID)
		if errors.Is(err, docker.ErrNotFound) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect %s: %w", c.Name, err)
		}
		if spec.IsItzgImage(info.Image) && dataBind(info) == want {
			return fmt.Errorf("%w: %s (not an MC Server Manager one) already mounts %s at /data: another container is not created over the same world. "+
				"Remove it, or remove this server without deleting data and import it again from %s", ErrDataInUse, info.Name, dataDir, info.Name)
		}
	}
	return nil
}

// connectAlias connects the container to the agent's network with the alias mcsm-<slug> (RCON, ping and
// metrics look it up by that name), without restarting it. If it is already on the network with the alias, it does nothing;
// if it is without it (m1: e.g. reimported with another slug), it reconnects it keeping its other aliases:
// Docker does not change the aliases of an existing connection. undo reverts the change, as far as possible (m12).
func (r *Reconciler) connectAlias(ctx context.Context, info *docker.ImportInfo, slug string) (undo func(), err error) {
	want := spec.ContainerName(slug)
	prev := info.Aliases[r.network]
	if !slices.Contains(info.Networks, r.network) {
		if err := r.eng.ConnectNetwork(ctx, r.network, info.ID, []string{want}); err != nil {
			return nil, fmt.Errorf("connect %s to network %s: %w", info.Name, r.network, err)
		}
		return func() {
			if err := r.eng.DisconnectNetwork(ctx, r.network, info.ID); err != nil {
				r.log.Warn("undo the network connection of a non-adopted container", "container", info.Name, "err", err)
			}
		}, nil
	}
	if slices.Contains(prev, want) {
		return func() {}, nil
	}
	if err := r.eng.DisconnectNetwork(ctx, r.network, info.ID); err != nil {
		return nil, fmt.Errorf("reconnect %s to network %s with alias %s: %w", info.Name, r.network, want, err)
	}
	if err := r.eng.ConnectNetwork(ctx, r.network, info.ID, append(slices.Clone(prev), want)); err != nil {
		if rerr := r.eng.ConnectNetwork(ctx, r.network, info.ID, prev); rerr != nil {
			r.log.Warn("reconnect a container to the network with its aliases", "container", info.Name, "err", rerr)
		}
		return nil, fmt.Errorf("reconnect %s to network %s with alias %s: %w", info.Name, r.network, want, err)
	}
	return func() {
		if err := r.eng.DisconnectNetwork(ctx, r.network, info.ID); err == nil {
			err = r.eng.ConnectNetwork(ctx, r.network, info.ID, prev)
			if err != nil {
				r.log.Warn("restore the network aliases of a non-adopted container", "container", info.Name, "err", err)
			}
		}
	}, nil
}

func adoptedContainer(serverID, slug, id, name, state string) *docker.Container {
	return &docker.Container{ID: id, Name: name, State: state, Adopted: true,
		Labels: map[string]string{spec.LabelServerID: serverID, spec.LabelSlug: slug}}
}

// findAdopted returns the server's adopted container, or nil if there is no adoption or its
// container no longer exists (reconcileLocked then cleans up the record).
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
		return nil, fmt.Errorf("inspect the adopted container: %w", err)
	}
	return adoptedContainer(serverID, ad.Slug, ins.ID, ins.Name, ins.State), nil
}

// ServerContainers returns the containers of the node's servers: the managed ones and the
// adopted ones not yet recreated (Adopted, with synthesized labels). Used by the metrics
// sampler. An adopted one that no longer exists is omitted.
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
