package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

const desiredRunning = mcsmv1.DesiredState_DESIRED_STATE_RUNNING

// extDataPath is a folder outside DATA_ROOT that does not exist: the agent must never create it.
const extDataPath = "/mcsm-test-nonexistent/external/data"

// external creates a foreign itzg container (without mcsm labels) that mounts bindSrc at /data and publishes
// 25565/tcp on the host's 25570; with run it starts it.
func external(t *testing.T, fake *docker.Fake, name, bindSrc string, run bool, mut ...func(*container.Config, *container.HostConfig)) string {
	t.Helper()
	ctx := context.Background()
	cfg := &container.Config{Image: "itzg/minecraft-server:java21", Env: []string{"EULA=TRUE", "TYPE=PAPER"}}
	hc := &container.HostConfig{
		Binds:         []string{bindSrc + ":/data"},
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
		PortBindings:  network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25570"}}},
	}
	for _, m := range mut {
		m(cfg, hc)
	}
	id, err := fake.Create(ctx, name, cfg, hc, &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{"bridge": {}}})
	if err != nil {
		t.Fatal(err)
	}
	if run {
		if err := fake.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

type impOpts struct {
	adoptVersion uint64
	memory       string
	dataPath     string
	noAdopt      bool
}

// importedSpec is the spec the panel sends for an imported server (with "adopt").
func importedSpec(containerID string, o impOpts) []byte {
	if o.memory == "" {
		o.memory = "2G"
	}
	if o.adoptVersion == 0 {
		o.adoptVersion = 1
	}
	m := map[string]any{
		"imageTag": "java21", "type": "PAPER", "version": "1.21.4", "memory": o.memory,
		"ports": map[string]any{"game": 25570}, "restartPolicy": "unless-stopped", "rconPassword": "abcdefgh",
	}
	if !o.noAdopt {
		m["adopt"] = map[string]any{"containerId": containerID, "version": o.adoptVersion}
	}
	if o.dataPath != "" {
		m["dataPath"] = o.dataPath
	}
	b, _ := json.Marshal(m)
	return b
}

func importMsg(id, slug string, v uint64, js []byte) *mcsmv1.ServerSpec {
	return &mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: desiredRunning, SpecJson: js}
}

func TestAdoptKeepsContainerRunning(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc-old", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if n := calls(fake, "Create") + calls(fake, "Stop") + calls(fake, "Remove") + calls(fake, "Start") + calls(fake, "Kill"); n != 0 {
		t.Fatalf("adopting does not touch the container: %v", fake.Calls)
	}
	if calls(fake, "ConnectNetwork mcsm "+id+" mcsm-alpha") != 1 {
		t.Fatalf("it must connect it to the network with the alias mcsm-alpha: %v", fake.Calls)
	}
	if got := r.ContainerID(ctx, "a"); got != id {
		t.Fatalf("ContainerID = %q", got)
	}
	if o := rec.get("a"); o == nil || o.ContainerId != id || o.State != "running" || o.Error != "" {
		t.Fatalf("observed = %+v", o)
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d", v)
	}
	if ad, _ := st.Adoption("a"); ad == nil || *ad != (store.Adoption{ContainerID: id, Slug: "alpha", Version: 1}) {
		t.Fatalf("adoption = %+v", ad)
	}
	// Later tick: it still does not recreate (the adopted one has no mcsm.spec_hash).
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 0 || len(fake.Containers) != 1 {
		t.Fatalf("a tick does not recreate: %v", fake.Calls)
	}
}

func TestAdoptedIsVisibleToPowerObserveAndServerContainers(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	var pinged []string
	r.status = func(_ context.Context, host string, _ uint16) *mcsmv1.McStatus {
		pinged = append(pinged, host)
		return &mcsmv1.McStatus{Online: true}
	}
	id := external(t, fake, "mc-old", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil // only counts what the agent does
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if len(pinged) == 0 || pinged[len(pinged)-1] != "mcsm-alpha" {
		t.Fatalf("the ping goes to the alias mcsm-alpha: %v", pinged)
	}
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err != nil {
		t.Fatal(err)
	}
	if fake.Containers[id].State != "exited" {
		t.Fatalf("state = %s", fake.Containers[id].State)
	}
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	if fake.Containers[id].State != "running" || calls(fake, "Create") != 0 {
		t.Fatalf("power on the original: %v", fake.Calls)
	}
	// A normal managed one and the adopted one.
	put(t, r.st, "b", "beta", 1, desiredRunning, specJSON)
	if err := r.Reconcile(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	list, err := r.ServerContainers(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("ServerContainers = %+v, %v", list, err)
	}
	var adopted *docker.Container
	for i := range list {
		if list[i].Adopted {
			adopted = &list[i]
		}
	}
	if adopted == nil || adopted.ID != id || adopted.Labels[spec.LabelServerID] != "a" || adopted.Labels[spec.LabelSlug] != "alpha" || adopted.State != "running" {
		t.Fatalf("adopted = %+v", adopted)
	}
}

func TestFirstSpecChangeRecreatesWithSameData(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	dataDir := filepath.Join(root, "alpha", "data")
	id := external(t, fake, "mc-old", dataDir, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	fake.Calls = nil
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; ok {
		t.Fatal("the original container is deleted on recreation")
	}
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Name != "mcsm-alpha" || list[0].Labels[spec.LabelServerID] != "a" || list[0].State != "running" {
		t.Fatalf("managed = %+v", list)
	}
	if b := fake.Containers[list[0].ID].HostConfig.Binds; len(b) != 1 || b[0] != dataDir+":/data" {
		t.Fatalf("binds = %v: the same data directory", b)
	}
	want := []string{"Stop " + id, "Remove " + id, "EnsureImage itzg/minecraft-server:java21", "Create mcsm-alpha", "Start " + list[0].ID}
	for i, w := range want {
		if i >= len(fake.Calls) || !strings.HasPrefix(fake.Calls[i], w) {
			t.Fatalf("calls = %v; want prefixes %v", fake.Calls, want)
		}
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatalf("the adoption ends on recreation: %+v", ad)
	}
}

func TestAdoptChecks(t *testing.T) {
	cases := []struct {
		name string
		mk   func(t *testing.T, fake *docker.Fake, root string) string
		want error
	}{
		{"does not exist", func(*testing.T, *docker.Fake, string) string { return docker.FakeID(999) }, ErrAdoptNotFound},
		{"already managed", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mcsm-other", filepath.Join(root, "alpha", "data"), false, func(c *container.Config, _ *container.HostConfig) {
				c.Labels = map[string]string{spec.LabelManaged: "true"}
			})
		}, ErrAdoptConflict},
		{"not itzg", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "web", filepath.Join(root, "alpha", "data"), false, func(c *container.Config, _ *container.HostConfig) { c.Image = "nginx:1.27" })
		}, ErrAdoptMismatch},
		{"another /data", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mc", filepath.Join(root, "beta", "data"), false)
		}, ErrAdoptMismatch},
		// When recreating it only /data is mounted: the world in /data/world would be another one (Review Focus 1).
		{"mount under /data", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mc", filepath.Join(root, "alpha", "data"), false, func(_ *container.Config, h *container.HostConfig) {
				h.Binds = append(h.Binds, "/srv/worlds/survival:/data/world")
			})
		}, ErrAdoptMismatch},
		{"red host", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mc", filepath.Join(root, "alpha", "data"), false, func(_ *container.Config, h *container.HostConfig) { h.NetworkMode = "host" })
		}, ErrAdoptMismatch},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, st, fake, _, root := setup(t)
			id := c.mk(t, fake, root)
			fake.Calls = nil
			err := r.Adopt(context.Background(), importMsg("a", "alpha", 1, importedSpec(id, impOpts{})))
			if !errors.Is(err, c.want) {
				t.Fatalf("err = %v; want %v", err, c.want)
			}
			if sp, _ := st.GetSpec("a"); sp != nil {
				t.Fatal("a rejection does not store the spec")
			}
			if calls(fake, "Create")+calls(fake, "Remove")+calls(fake, "ConnectNetwork") != 0 {
				t.Fatalf("a rejection does not touch Docker: %v", fake.Calls)
			}
		})
	}
	t.Run("spec without adopt", func(t *testing.T) {
		r, _, _, _, _ := setup(t)
		err := r.Adopt(context.Background(), importMsg("a", "alpha", 1, importedSpec("x", impOpts{noAdopt: true})))
		if !errors.Is(err, ErrAdoptSpec) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestAdoptIsIdempotent(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil // only counts what the agent does
	msg := importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))
	if err := r.Adopt(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if err := r.Adopt(ctx, msg); err != nil {
		t.Fatalf("panel retry: %v", err)
	}
	if calls(fake, "ConnectNetwork") != 1 || calls(fake, "Create") != 0 {
		t.Fatalf("calls = %v", fake.Calls)
	}
}

func TestTwoServersCannotAdoptSameContainer(t *testing.T) {
	r, _, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, sid := range []string{"a", "b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = r.Adopt(ctx, importMsg(sid, sid+"-slug", 1, importedSpec(id, impOpts{dataPath: extDataPath})))
		}()
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		if err == nil {
			ok++
		} else if !errors.Is(err, ErrAdoptConflict) {
			t.Fatalf("err = %v", err)
		}
	}
	if ok != 1 {
		t.Fatalf("exactly one adopts: %v", errs)
	}
}

func TestReadoptFromSpecWithoutRecord(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil // only counts what the agent does
	// SyncSpecs after losing the ImportAdopt.
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{})))
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 0 || calls(fake, "ConnectNetwork mcsm "+id) != 1 {
		t.Fatalf("it must adopt, not create: %v", fake.Calls)
	}
	if ad, _ := st.Adoption("a"); ad == nil || ad.ContainerID != id || ad.Version != 1 {
		t.Fatalf("adoption = %+v", ad)
	}
}

func TestReadoptWithNewerSpecRecreatesAtOnce(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	put(t, r.st, "a", "alpha", 3, desiredRunning, string(importedSpec(id, impOpts{adoptVersion: 1})))
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; ok || calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("v3 > adoption v1: it is recreated: %v", fake.Calls)
	}
}

func TestReadoptOriginalGoneCreatesManaged(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(docker.FakeID(42), impOpts{})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("without the original the managed one is created: %v", fake.Calls)
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatalf("no adoption remains: %+v", ad)
	}
}

func TestReadoptMismatchCreatesNothing(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	id := external(t, fake, "mc", filepath.Join(root, "other", "data"), true)
	fake.Calls = nil // only counts what the agent does
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{})))
	err := r.Reconcile(context.Background(), "a")
	if !errors.Is(err, ErrAdoptMismatch) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create") != 0 {
		t.Fatalf("never a second container over unchecked data: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "/data") {
		t.Fatalf("observed = %+v", o)
	}
}

func TestRemoveAdoptedRemovesOriginal(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Remove(ctx, "a", false); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; ok {
		t.Fatal("deleting the server deletes its container")
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatal("nor the adoption")
	}
}

func TestForgetAdoptedThenRetryRemovesOriginal(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Forget("a"); err != nil {
		t.Fatal(err)
	}
	if done := r.RetryRemovals(ctx); len(done) != 1 || done[0] != "a" {
		t.Fatalf("RetryRemovals = %v", done)
	}
	if _, ok := fake.Containers[id]; ok {
		t.Fatal("the tombstone deletes the adopted original")
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatal("nor the adoption")
	}
}

func TestRemoveWithDataPathRefusesDeleteData(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Remove(ctx, "a", true); err == nil || !strings.Contains(err.Error(), "outside DATA_ROOT") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fake.Containers[id]; !ok {
		t.Fatal("a rejection touches nothing")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("nor the spec")
	}
}

func TestDataPathCreateNeverMkdirs(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	if err := st.PutExternalPath("a", extDataPath); err != nil { // verified when importing (H1)
		t.Fatal(err)
	}
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec("", impOpts{noAdopt: true, dataPath: extDataPath})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	list, _ := fake.ListManaged(context.Background())
	if len(list) != 1 || dataSource(t, fake, list[0].ID) != extDataPath {
		t.Fatalf("container = %+v", list)
	}
	if _, err := os.Stat("/mcsm-test-nonexistent"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the agent does not create folders outside DATA_ROOT: %v", err)
	}
}

func TestHoldDefersFirstSpecChange(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; !ok {
		t.Fatal("with the server reserved it is not recreated")
	}
	release(ctx)
	if _, ok := fake.Containers[id]; ok || calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("on release the change is applied: %v", fake.Calls)
	}
}

// A server that already follows an adopted container does not adopt another: both would mount the same
// world and the reconciler would start the second with the first running.
func TestAdoptRefusesSecondContainerForSameServer(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	dataDir := filepath.Join(root, "alpha", "data")
	first := external(t, fake, "mc-1", dataDir, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(first, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	second := external(t, fake, "mc-2", dataDir, false)
	fake.Calls = nil
	err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(second, impOpts{})))
	if !errors.Is(err, ErrAdoptConflict) {
		t.Fatalf("err = %v", err)
	}
	if ad, _ := st.Adoption("a"); ad == nil || ad.ContainerID != first {
		t.Fatalf("the adoption stays on the first: %+v", ad)
	}
	if calls(fake, "ConnectNetwork")+calls(fake, "Start")+calls(fake, "Create") != 0 {
		t.Fatalf("a rejection does not touch Docker: %v", fake.Calls)
	}
}

// The sampler does not see an adopted one whose container no longer exists.
func TestServerContainersSkipsGoneAdopted(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if err := fake.Remove(ctx, id); err != nil { // deleted by hand, outside the agent
		t.Fatal(err)
	}
	list, err := r.ServerContainers(ctx)
	if err != nil || len(list) != 0 {
		t.Fatalf("ServerContainers = %+v, %v", list, err)
	}
}

// M1: a late ImportAdopt v1 (old session) does not overwrite the v2 that a SyncSpecs from "Adopt and
// apply" already stored: only the v1 adoption is stored, so v2 recreates.
func TestLateAdoptKeepsNewerSpecAndRecreates(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.StoreForce(importMsg("a", "alpha", 2, importedSpec(id, impOpts{memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if sp, _ := st.GetSpec("a"); sp == nil || sp.Version != 2 {
		t.Fatalf("spec = %v: v2 is kept", sp)
	}
	if _, ok := fake.Containers[id]; ok || calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("v2 recreates: %v", fake.Calls)
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d", v)
	}
}

// m1: it is already on the mcsm network without the alias (reimported after losing the store, with another slug): it is
// reconnected with the alias, without stopping it; any aliases it had are kept.
func TestAdoptAddsAliasWhenAlreadyOnNetwork(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id, err := fake.Create(ctx, "mc", &container.Config{Image: "itzg/minecraft-server:java21"},
		&container.HostConfig{Binds: []string{filepath.Join(root, "alpha", "data") + ":/data"},
			PortBindings: network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25570"}}}},
		&network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{"mcsm": {Aliases: []string{"mcsm-old"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	fake.Calls = nil
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	info, _ := fake.InspectImport(ctx, id)
	if !slices.Contains(info.Aliases["mcsm"], "mcsm-alpha") || !slices.Contains(info.Aliases["mcsm"], "mcsm-old") {
		t.Fatalf("alias = %v", info.Aliases)
	}
	if calls(fake, "DisconnectNetwork mcsm "+id) != 1 || calls(fake, "Stop")+calls(fake, "Start")+calls(fake, "Create") != 0 {
		t.Fatalf("calls = %v", fake.Calls)
	}
	// With the alias already set (retry) the network is not touched.
	fake.Calls = nil
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "ConnectNetwork")+calls(fake, "DisconnectNetwork") != 0 {
		t.Fatalf("calls = %v", fake.Calls)
	}
}

// failStoreOnConnect closes the store right after connecting the container to the network: saving
// the adoption fails after ConnectNetwork.
type failStoreOnConnect struct {
	*docker.Fake
	st *store.Store
}

func (f failStoreOnConnect) ConnectNetwork(ctx context.Context, netName, id string, aliases []string) error {
	err := f.Fake.ConnectNetwork(ctx, netName, id, aliases)
	f.st.Close()
	return err
}

// m12: if saving the adoption fails after ConnectNetwork, the alias is undone (it is not left orphaned).
func TestAdoptUndoesAliasWhenStoreFails(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	r.eng = failStoreOnConnect{fake, st}
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err == nil {
		t.Fatal("saving fails: Adopt too")
	}
	info, _ := fake.InspectImport(ctx, id)
	if slices.Contains(info.Networks, "mcsm") {
		t.Fatalf("the alias is undone: %v %v", info.Networks, fake.Calls)
	}
}

// m6: a paused container is adopted "running" and left as it is: Docker does not start a paused
// one (it would have to be resumed), so the reconciler does not try.
func TestAdoptPausedLeavesItPaused(t *testing.T) {
	r, _, fake, rec, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	fake.Containers[id].State = "paused"
	fake.Calls = nil
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Start")+calls(fake, "Stop") != 0 {
		t.Fatalf("calls = %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || o.State != "paused" || o.Error != "" {
		t.Fatalf("observed = %+v", o)
	}
}

// plan-6 × plan-8 (I1): the adopted container is the user's original. Even if it does not start (port
// taken; Docker 29.7.2 leaves it tainted) or starts without publishing its ports, startOrDiscard does not
// delete it, neither from the reconciliation nor from "Start"/"Restart": it only reports the error.
func TestAdoptedIsNeverDiscardedOnStart(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc-old", filepath.Join(root, "alpha", "data"), false)
	blocker := blockPort(t, fake, "25570")
	fake.Calls = nil // only counts what the agent does
	// Adopting with the desired state running tries to start it: the port is taken.
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	kept := func(when string) {
		t.Helper()
		if _, ok := fake.Containers[id]; !ok || calls(fake, "Remove "+id) != 0 || calls(fake, "Create") != 0 {
			t.Fatalf("%s: the original is neither deleted nor replaced: %v", when, fake.Calls)
		}
		if c := serverContainer(t, r, "a"); c == nil || c.ID != id || !c.Adopted {
			t.Fatalf("%s: the server stays on its original: %+v", when, c)
		}
	}
	kept("when adopting")
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "already allocated") || strings.Contains(o.Error, "will be recreated") {
		t.Fatalf("observed = %+v", o)
	}
	// Retry after the backoff: it starts, but tainted (without publishing the port). It is reported.
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) }
	r.ReconcileAll(ctx)
	kept("on the tick")
	if o := rec.get("a"); o.State != "running" || !strings.Contains(o.Error, "without publishing its ports") || !strings.Contains(o.Error, "original container") {
		t.Fatalf("observed = %+v", o)
	}
	// With the port freed, "Restart" does not fix it (it stays tainted) and does not delete it either.
	_ = fake.Stop(ctx, blocker, time.Second)
	err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART)
	if err == nil || !strings.Contains(err.Error(), "without publishing its ports") || errors.Is(err, errDiscarded) {
		t.Fatalf("Restart = %v", err)
	}
	kept("when restarting")
	if d := desired(t, st, "a"); d != desiredRunning {
		t.Fatalf("desired = %v", d)
	}
	obs := r.Observe(ctx, "a")
	if obs.State != "running" || !strings.Contains(obs.Error, "without publishing its ports") || strings.Contains(obs.Error, "Restart") {
		t.Fatalf("observed = %+v", obs)
	}
}
