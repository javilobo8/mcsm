package reconcile

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

// H1: the agent only mounts a dataPath if it is the folder it verified when adopting that
// server's container. A compromised panel cannot mount /root (or anything) in a container.

func TestUnverifiedDataPathCreatesNothing(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec("", impOpts{noAdopt: true, dataPath: "/root/mc"})))
	err := r.Reconcile(context.Background(), "a")
	if !errors.Is(err, ErrDataPathUnverified) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create")+calls(fake, "EnsureImage") != 0 {
		t.Fatalf("unverified, Docker is not touched: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "/root/mc") {
		t.Fatalf("observed = %+v", o)
	}
}

func TestDataPathOtherThanVerifiedIsRefused(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	if p, _ := st.ExternalPath("a"); p != extDataPath {
		t.Fatalf("adopting registers the verified folder: %q", p)
	}
	fake.Calls = nil
	err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{dataPath: "/root/mc", memory: "3G"})))
	if !errors.Is(err, ErrDataPathUnverified) {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fake.Containers[id]; !ok || calls(fake, "Stop")+calls(fake, "Remove")+calls(fake, "Create") != 0 {
		t.Fatalf("the original stays intact: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "/root/mc") {
		t.Fatalf("observed = %+v", o)
	}
}

// The record survives restarting the agent: the first recreation after the restart mounts the folder.
func TestVerifiedDataPathSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	dbPath, root := filepath.Join(dir, "agent.db"), filepath.Join(dir, "data")
	fake := docker.NewFake()
	newRec := func(st *store.Store) *Reconciler {
		r := New(st, fake, root, "mcsm", stubStatus, nil)
		r.now = func() time.Time { return time.Unix(1_000_000, 0) }
		r.log = slog.New(slog.NewTextHandler(io.Discard, nil))
		return r
	}
	ctx := context.Background()
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	id := external(t, fake, "mc", extDataPath, true)
	if err := newRec(st).Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := newRec(st).Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{dataPath: extDataPath, memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Name != "mcsm-alpha" {
		t.Fatalf("managed = %+v", list)
	}
	if src := dataSource(t, fake, list[0].ID); src != extDataPath {
		t.Fatalf("/data = %q", src)
	}
}

// Lost store and vanished original: nothing proves that the folder is the imported one's.
func TestStoreLostAndOriginalGoneCreatesNothing(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(docker.FakeID(42), impOpts{dataPath: extDataPath})))
	if err := r.Reconcile(context.Background(), "a"); !errors.Is(err, ErrDataPathUnverified) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create") != 0 {
		t.Fatalf("nothing is created: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "import it again") {
		t.Fatalf("observed = %+v", o)
	}
}

// Lost store with the original alive: the re-adoption verifies again and registers the folder.
func TestStoreLostReadoptRegistersDataPath(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	id := external(t, fake, "mc", extDataPath, true)
	put(t, st, "a", "alpha", 1, desiredRunning, string(importedSpec(id, impOpts{dataPath: extDataPath})))
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if p, _ := st.ExternalPath("a"); p != extDataPath {
		t.Fatalf("path = %q", p)
	}
}

// Lost store after the recreation: the managed one (only the agent creates it, with the folder already
// verified) keeps mounting it; the record is recovered without recreating.
func TestStoreLostRecoversFromManagedContainer(t *testing.T) {
	r, _, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{dataPath: extDataPath, memory: "3G"}))); err != nil {
		t.Fatal(err)
	}
	// New agent (empty store) over the same Docker.
	r2, st2, _, _, _ := setup(t)
	r2.eng, r2.dataRoot = fake, r.dataRoot
	put(t, st2, "a", "alpha", 2, desiredRunning, string(importedSpec(id, impOpts{dataPath: extDataPath, memory: "3G"})))
	fake.Calls = nil
	if err := r2.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create")+calls(fake, "Remove") != 0 {
		t.Fatalf("does not recreate: %v", fake.Calls)
	}
	if p, _ := st2.ExternalPath("a"); p != extDataPath {
		t.Fatalf("recovered path = %q", p)
	}
}

// dataSource is the host folder mounted at /data of a fake container (Binds or Mounts).
func dataSource(t *testing.T, fake *docker.Fake, id string) string {
	t.Helper()
	info, err := fake.InspectImport(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range info.Mounts {
		if m.Destination == "/data" {
			return m.Source
		}
	}
	return ""
}

// M2: the original disappeared because Compose recreated it with another id over the same folder: mcsm-<slug>
// is not created on top of the same world.
func TestOriginalGoneButAnotherContainerUsesData(t *testing.T) {
	r, _, fake, rec, root := setup(t)
	ctx := context.Background()
	dataDir := filepath.Join(root, "alpha", "data")
	id := external(t, fake, "mc", dataDir, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{}))); err != nil {
		t.Fatal(err)
	}
	if err := fake.Remove(ctx, id); err != nil { // docker compose up -d
		t.Fatal(err)
	}
	external(t, fake, "home-survival-1", dataDir, false)
	fake.Calls = nil
	if err := r.Reconcile(ctx, "a"); !errors.Is(err, ErrDataInUse) {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Create")+calls(fake, "Start") != 0 {
		t.Fatalf("nothing is created: %v", fake.Calls)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "home-survival-1") {
		t.Fatalf("observed = %+v", o)
	}
}

// M2 with dataPath, and on recreation: the adopted original is not stopped if another itzg container mounts
// the same folder (a second server over the same world would be created).
func TestRecreateRefusedWhileAnotherContainerUsesData(t *testing.T) {
	r, _, fake, _, _ := setup(t)
	ctx := context.Background()
	id := external(t, fake, "mc", extDataPath, true)
	if err := r.Adopt(ctx, importMsg("a", "alpha", 1, importedSpec(id, impOpts{dataPath: extDataPath}))); err != nil {
		t.Fatal(err)
	}
	external(t, fake, "manual-copy", extDataPath, false)
	fake.Calls = nil
	err := r.Apply(ctx, importMsg("a", "alpha", 2, importedSpec(id, impOpts{dataPath: extDataPath, memory: "3G"})))
	if !errors.Is(err, ErrDataInUse) {
		t.Fatalf("err = %v", err)
	}
	if _, ok := fake.Containers[id]; !ok || calls(fake, "Stop")+calls(fake, "Remove")+calls(fake, "Create") != 0 {
		t.Fatalf("the original stays intact: %v", fake.Calls)
	}
}
