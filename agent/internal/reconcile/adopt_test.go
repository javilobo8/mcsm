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

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

const desiredRunning = mcsmv1.DesiredState_DESIRED_STATE_RUNNING

// extDataPath es una carpeta fuera de DATA_ROOT que no existe: el agente nunca debe crearla.
const extDataPath = "/mcsm-test-noexiste/externo/data"

// external crea un contenedor itzg ajeno (sin etiquetas mcsm) que monta bindSrc en /data y publica
// 25565/tcp en el 25570 del host; con run lo arranca.
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

// importedSpec es la spec que el panel envía de un importado (con "adopt").
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
	id := external(t, fake, "mc-viejo", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if n := calls(fake, "Create") + calls(fake, "Stop") + calls(fake, "Remove") + calls(fake, "Start") + calls(fake, "Kill"); n != 0 {
		t.Fatalf("adoptar no toca el contenedor: %v", fake.Calls)
	}
	if calls(fake, "ConnectNetwork mcsm "+id+" mcsm-alpha") != 1 {
		t.Fatalf("debe conectarlo a la red con el alias mcsm-alpha: %v", fake.Calls)
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
	// Tick posterior: sigue sin recrear (el adoptado no tiene mcsm.spec_hash).
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 0 || len(fake.Containers) != 1 {
		t.Fatalf("un tick no recrea: %v", fake.Calls)
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
	id := external(t, fake, "mc-viejo", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil // solo cuenta lo que hace el agente
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if len(pinged) == 0 || pinged[len(pinged)-1] != "mcsm-alpha" {
		t.Fatalf("el ping va al alias mcsm-alpha: %v", pinged)
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
		t.Fatalf("power sobre el original: %v", fake.Calls)
	}
	// Un gestionado normal y el adoptado.
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
		t.Fatalf("adoptado = %+v", adopted)
	}
}

func TestFirstSpecChangeRecreatesWithSameData(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	dataDir := filepath.Join(root, "alpha", "data")
	id := external(t, fake, "mc-viejo", dataDir, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	fake.Calls = nil
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; ok {
		t.Fatal("el contenedor original se borra al recrear")
	}
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Name != "mcsm-alpha" || list[0].Labels[spec.LabelServerID] != "a" || list[0].State != "running" {
		t.Fatalf("gestionado = %+v", list)
	}
	if b := fake.Containers[list[0].ID].HostConfig.Binds; len(b) != 1 || b[0] != dataDir+":/data" {
		t.Fatalf("binds = %v: el mismo directorio de datos", b)
	}
	want := []string{"Stop " + id, "Remove " + id, "EnsureImage itzg/minecraft-server:java21", "Create mcsm-alpha", "Start " + list[0].ID}
	for i, w := range want {
		if i >= len(fake.Calls) || !strings.HasPrefix(fake.Calls[i], w) {
			t.Fatalf("calls = %v; want prefijos %v", fake.Calls, want)
		}
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatalf("la adopción termina al recrear: %+v", ad)
	}
}

func TestAdoptChecks(t *testing.T) {
	cases := []struct {
		name string
		mk   func(t *testing.T, fake *docker.Fake, root string) string
		want error
	}{
		{"no existe", func(*testing.T, *docker.Fake, string) string { return docker.FakeID(999) }, ErrAdoptNotFound},
		{"ya gestionado", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mcsm-otro", filepath.Join(root, "alpha", "data"), false, func(c *container.Config, _ *container.HostConfig) {
				c.Labels = map[string]string{spec.LabelManaged: "true"}
			})
		}, ErrAdoptConflict},
		{"no es itzg", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "web", filepath.Join(root, "alpha", "data"), false, func(c *container.Config, _ *container.HostConfig) { c.Image = "nginx:1.27" })
		}, ErrAdoptMismatch},
		{"otro /data", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mc", filepath.Join(root, "beta", "data"), false)
		}, ErrAdoptMismatch},
		// Al recrearlo solo se monta /data: el mundo de /data/world sería otro (Review Focus 1).
		{"montaje bajo /data", func(t *testing.T, f *docker.Fake, root string) string {
			return external(t, f, "mc", filepath.Join(root, "alpha", "data"), false, func(_ *container.Config, h *container.HostConfig) {
				h.Binds = append(h.Binds, "/srv/mundos/survival:/data/world")
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
				t.Fatal("un rechazo no guarda la spec")
			}
			if calls(fake, "Create")+calls(fake, "Remove")+calls(fake, "ConnectNetwork") != 0 {
				t.Fatalf("un rechazo no toca Docker: %v", fake.Calls)
			}
		})
	}
	t.Run("spec sin adopt", func(t *testing.T) {
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
	fake.Calls = nil // solo cuenta lo que hace el agente
	msg := importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))
	if err := r.Adopt(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if err := r.Adopt(ctx, msg); err != nil {
		t.Fatalf("reintento del panel: %v", err)
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
		t.Fatalf("exactamente uno adopta: %v", errs)
	}
}

func TestReadoptFromSpecWithoutRecord(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	fake.Calls = nil // solo cuenta lo que hace el agente
	// SyncSpecs tras perder el ImportAdopt.
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{})))
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 0 || calls(fake, "ConnectNetwork mcsm "+id) != 1 {
		t.Fatalf("debe adoptar, no crear: %v", fake.Calls)
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
		t.Fatalf("v3 > adopción v1: se recrea: %v", fake.Calls)
	}
}

func TestReadoptOriginalGoneCreatesManaged(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(docker.FakeID(42), impOpts{})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("sin original se crea el gestionado: %v", fake.Calls)
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatalf("no queda adopción: %+v", ad)
	}
}

func TestReadoptMismatchCreatesNothing(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	id := external(t, fake, "mc", filepath.Join(root, "otra", "data"), true)
	fake.Calls = nil // solo cuenta lo que hace el agente
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{})))
	err := r.Reconcile(context.Background(), "a")
	if !errors.Is(err, ErrAdoptMismatch) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create") != 0 {
		t.Fatalf("nunca un segundo contenedor sobre datos sin comprobar: %v", fake.Calls)
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
		t.Fatal("borrar el servidor borra su contenedor")
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatal("ni adopción")
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
		t.Fatal("la lápida borra el original adoptado")
	}
	if ad, _ := st.Adoption("a"); ad != nil {
		t.Fatal("ni adopción")
	}
}

func TestRemoveWithDataPathRefusesDeleteData(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Remove(ctx, "a", true); err == nil || !strings.Contains(err.Error(), "fuera de DATA_ROOT") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fake.Containers[id]; !ok {
		t.Fatal("un rechazo no toca nada")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("ni la spec")
	}
}

func TestDataPathCreateNeverMkdirs(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	if err := st.PutExternalPath("a", extDataPath); err != nil { // verificada al importar (H1)
		t.Fatal(err)
	}
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec("", impOpts{noAdopt: true, dataPath: extDataPath})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	list, _ := fake.ListManaged(context.Background())
	if len(list) != 1 || dataSource(t, fake, list[0].ID) != extDataPath {
		t.Fatalf("contenedor = %+v", list)
	}
	if _, err := os.Stat("/mcsm-test-noexiste"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("el agente no crea carpetas fuera de DATA_ROOT: %v", err)
	}
}

func TestHoldDefersFirstSpecChange(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "copia de seguridad")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.Containers[id]; !ok {
		t.Fatal("con el servidor reservado no se recrea")
	}
	release(ctx)
	if _, ok := fake.Containers[id]; ok || calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("al liberar se aplica el cambio: %v", fake.Calls)
	}
}

// Un servidor que ya sigue a un contenedor adoptado no adopta otro: los dos montarían el mismo
// mundo y el reconciliador arrancaría el segundo con el primero en marcha.
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
		t.Fatalf("la adopción sigue en el primero: %+v", ad)
	}
	if calls(fake, "ConnectNetwork")+calls(fake, "Start")+calls(fake, "Create") != 0 {
		t.Fatalf("un rechazo no toca Docker: %v", fake.Calls)
	}
}

// El muestreador no ve un adoptado cuyo contenedor ya no existe.
func TestServerContainersSkipsGoneAdopted(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if err := fake.Remove(ctx, id); err != nil { // borrado a mano, fuera del agente
		t.Fatal(err)
	}
	list, err := r.ServerContainers(ctx)
	if err != nil || len(list) != 0 {
		t.Fatalf("ServerContainers = %+v, %v", list, err)
	}
}

// M1: un ImportAdopt v1 tardío (sesión vieja) no pisa la v2 que ya guardó un SyncSpecs de «Adoptar y
// aplicar»: se guarda solo la adopción v1, así que la v2 recrea.
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
		t.Fatalf("spec = %v: la v2 se conserva", sp)
	}
	if _, ok := fake.Containers[id]; ok || calls(fake, "Create mcsm-alpha") != 1 {
		t.Fatalf("la v2 recrea: %v", fake.Calls)
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d", v)
	}
}

// m1: ya está en la red mcsm sin el alias (reimportado tras perder el store, con otro slug): se
// reconecta con el alias, sin pararlo; los alias que tuviera se conservan.
func TestAdoptAddsAliasWhenAlreadyOnNetwork(t *testing.T) {
	r, _, fake, _, root := setup(t)
	ctx := context.Background()
	id, err := fake.Create(ctx, "mc", &container.Config{Image: "itzg/minecraft-server:java21"},
		&container.HostConfig{Binds: []string{filepath.Join(root, "alpha", "data") + ":/data"},
			PortBindings: network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25570"}}}},
		&network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{"mcsm": {Aliases: []string{"mcsm-viejo"}}}})
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
	if !slices.Contains(info.Aliases["mcsm"], "mcsm-alpha") || !slices.Contains(info.Aliases["mcsm"], "mcsm-viejo") {
		t.Fatalf("alias = %v", info.Aliases)
	}
	if calls(fake, "DisconnectNetwork mcsm "+id) != 1 || calls(fake, "Stop")+calls(fake, "Start")+calls(fake, "Create") != 0 {
		t.Fatalf("calls = %v", fake.Calls)
	}
	// Con el alias ya puesto (reintento) no se toca la red.
	fake.Calls = nil
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "ConnectNetwork")+calls(fake, "DisconnectNetwork") != 0 {
		t.Fatalf("calls = %v", fake.Calls)
	}
}

// failStoreOnConnect cierra el store justo después de conectar el contenedor a la red: el guardado de
// la adopción falla después de ConnectNetwork.
type failStoreOnConnect struct {
	*docker.Fake
	st *store.Store
}

func (f failStoreOnConnect) ConnectNetwork(ctx context.Context, netName, id string, aliases []string) error {
	err := f.Fake.ConnectNetwork(ctx, netName, id, aliases)
	f.st.Close()
	return err
}

// m12: si guardar la adopción falla tras ConnectNetwork, el alias se deshace (no queda huérfano).
func TestAdoptUndoesAliasWhenStoreFails(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", filepath.Join(root, "alpha", "data"), true)
	r.eng = failStoreOnConnect{fake, st}
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err == nil {
		t.Fatal("el guardado falla: Adopt también")
	}
	info, _ := fake.InspectImport(ctx, id)
	if slices.Contains(info.Networks, "mcsm") {
		t.Fatalf("el alias se deshace: %v %v", info.Networks, fake.Calls)
	}
}
