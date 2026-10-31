package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

// plan-11: on uninstalling a modpack (or switching to the other platform) itzg leaves its files in /data
// (spike F2/F3); the agent deletes them from its manifest before creating the new container.

const (
	mrPackJSON = `{"imageTag":"java21","type":"MODRINTH","version":"1.21.1","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","modpack":{"platform":"MODRINTH","slugOrUrl":"adrenaserver"}}`
	mrPack2    = `{"imageTag":"java21","type":"MODRINTH","version":"1.21.1","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","modpack":{"platform":"MODRINTH","slugOrUrl":"fabulously-optimized"}}`
	fabricJSON = `{"imageTag":"java21","type":"FABRIC","version":"1.21.1","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh"}`
)

func specMsg(id, slug string, v uint64, js string) *mcsmv1.ServerSpec {
	return &mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: running, SpecJson: []byte(js)}
}

// installPack writes into dir what itzg leaves after installing a Modrinth pack: its manifest, its
// files, and the world (which is not the pack's).
func installPack(t *testing.T, dir string) {
	t.Helper()
	for _, f := range []string{"mods/a.jar", "config/a.toml", "world/level.dat"} {
		p := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := json.Marshal(map[string]any{"files": []string{"mods/a.jar", "config/a.toml"}, "projectSlug": "adrenaserver"})
	if err := os.WriteFile(filepath.Join(dir, ".modrinth-modpack-manifest.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func fileExists(t *testing.T, p string) bool {
	t.Helper()
	_, err := os.Lstat(p)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return err == nil
}

func packPending(t *testing.T, st *store.Store, id string) []string {
	t.Helper()
	got, err := st.PackCleanups(id)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// startPack creates server "a" (alpha) with a Modrinth pack, running, and leaves the pack installed.
func startPack(t *testing.T, r *Reconciler, root string) string {
	t.Helper()
	if err := r.Apply(context.Background(), specMsg("a", "alpha", 1, mrPackJSON)); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(root, "alpha", "data")
	installPack(t, data)
	return data
}

func TestUninstallPackCleansBeforeCreate(t *testing.T) {
	r, st, fake, _, root := setup(t)
	ctx := context.Background()
	sink := &sinkRec{}
	r.SetEventSink(sink.fn)
	data := startPack(t, r, root)
	fake.CreateErr = errors.New("create refused")
	err := r.Apply(ctx, specMsg("a", "alpha", 2, fabricJSON))
	if err == nil || !strings.Contains(err.Error(), "create refused") {
		t.Fatalf("err = %v", err)
	}
	if calls(fake, "Remove") < 1 {
		t.Fatalf("the old container must be removed: %v", fake.Calls)
	}
	if fileExists(t, filepath.Join(data, "mods", "a.jar")) || fileExists(t, filepath.Join(data, "config")) {
		t.Fatal("the pack's files must be removed before creating")
	}
	if !fileExists(t, filepath.Join(data, "world", "level.dat")) {
		t.Fatal("the world must stay")
	}
	if got := packPending(t, st, "a"); len(got) != 0 {
		t.Fatalf("marker = %v", got)
	}
	if got := sink.list(); !reflect.DeepEqual(got, []string{KindPackCleanup}) {
		t.Fatalf("events = %v", got)
	}
	fake.CreateErr = nil
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 || list[0].State != "running" {
		t.Fatalf("containers = %+v", list)
	}
}

// A failed cleanup must not create the container over a half-cleaned folder; the marker stays.
func TestPackCleanupFailureBlocksCreate(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	ctx := context.Background()
	data := startPack(t, r, root)
	if err := os.WriteFile(filepath.Join(data, ".modrinth-modpack-manifest.json"), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	creates := calls(fake, "Create")
	if err := r.Apply(ctx, specMsg("a", "alpha", 2, fabricJSON)); err == nil {
		t.Fatal("the cleanup failure must be returned")
	}
	if calls(fake, "Create") != creates {
		t.Fatalf("no container may be created: %v", fake.Calls)
	}
	if got := packPending(t, st, "a"); !reflect.DeepEqual(got, []string{spec.PlatformModrinth}) {
		t.Fatalf("marker = %v", got)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "modpack") {
		t.Fatalf("observed = %+v", o)
	}
}

func TestPackCleanupDeferredWhileHeld(t *testing.T) {
	r, st, _, _, root := setup(t)
	ctx := context.Background()
	data := startPack(t, r, root)
	release, err := r.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, specMsg("a", "alpha", 2, fabricJSON)); err != nil {
		t.Fatal(err)
	}
	if !fileExists(t, filepath.Join(data, "mods", "a.jar")) {
		t.Fatal("nothing is deleted while the server is reserved")
	}
	if got := packPending(t, st, "a"); !reflect.DeepEqual(got, []string{spec.PlatformModrinth}) {
		t.Fatalf("marker = %v", got)
	}
	release(ctx)
	if fileExists(t, filepath.Join(data, "mods", "a.jar")) {
		t.Fatal("releasing the reservation must clean")
	}
	if got := packPending(t, st, "a"); len(got) != 0 {
		t.Fatalf("marker = %v", got)
	}
}

// StoreForce (SyncSpecs) marks too: the background reconciliation cleans.
func TestStoreForceMarksPackCleanup(t *testing.T) {
	r, st, _, _, root := setup(t)
	data := startPack(t, r, root)
	if err := r.StoreForce(specMsg("a", "alpha", 2, fabricJSON)); err != nil {
		t.Fatal(err)
	}
	if got := packPending(t, st, "a"); !reflect.DeepEqual(got, []string{spec.PlatformModrinth}) {
		t.Fatalf("marker = %v", got)
	}
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if fileExists(t, filepath.Join(data, "mods", "a.jar")) {
		t.Fatal("the reconciliation after SyncSpecs must clean")
	}
}

func TestPackCleanupMarkerSurvivesRestart(t *testing.T) {
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
	r1 := newRec(st)
	data := startPack(t, r1, root)
	if _, err := r1.Hold("a", "backup"); err != nil {
		t.Fatal(err)
	}
	if err := r1.Apply(ctx, specMsg("a", "alpha", 2, fabricJSON)); err != nil {
		t.Fatal(err)
	}
	st.Close() // the agent dies with the cleanup pending
	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := newRec(st).Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if fileExists(t, filepath.Join(data, "mods", "a.jar")) || !fileExists(t, filepath.Join(data, "world", "level.dat")) {
		t.Fatal("the new agent must finish the cleanup")
	}
	if got := packPending(t, st, "a"); len(got) != 0 {
		t.Fatalf("marker = %v", got)
	}
}

// Back on the same platform before the cleanup ran: itzg itself replaces the old pack (F4), the agent
// deletes nothing.
func TestSwitchBackToSamePlatformSkipsCleanup(t *testing.T) {
	r, st, _, _, root := setup(t)
	ctx := context.Background()
	data := startPack(t, r, root)
	if err := st.PutSpecMarkingPackCleanup(specMsg("a", "alpha", 2, mrPack2), spec.PlatformModrinth); err != nil {
		t.Fatal(err)
	}
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if !fileExists(t, filepath.Join(data, "mods", "a.jar")) {
		t.Fatal("the agent must not delete what itzg will replace")
	}
	if got := packPending(t, st, "a"); len(got) != 0 {
		t.Fatalf("marker = %v", got)
	}
}

// A dataPath is outside DATA_ROOT and not mounted in the agent: nothing is deleted, the admin is told.
func TestPackCleanupDataPathSkipped(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	sink := &sinkRec{}
	r.SetEventSink(sink.fn)
	ext := t.TempDir()
	installPack(t, ext)
	id := external(t, fake, "mc", ext, true)
	withPack := func(v uint64, pack bool) *mcsmv1.ServerSpec {
		var m map[string]any
		_ = json.Unmarshal(importedSpec(id, impOpts{dataPath: ext}), &m)
		if pack {
			m["type"] = "MODRINTH"
			m["modpack"] = map[string]any{"platform": "MODRINTH", "slugOrUrl": "adrenaserver"}
		} else {
			m["type"] = "FABRIC"
		}
		b, _ := json.Marshal(m)
		return importMsg("a", "alpha", v, b)
	}
	if err := r.Adopt(ctx, withPack(1, true)); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, withPack(2, false)); err != nil {
		t.Fatal(err)
	}
	if !fileExists(t, filepath.Join(ext, "mods", "a.jar")) {
		t.Fatal("the agent must not touch a dataPath")
	}
	if got := packPending(t, st, "a"); len(got) != 0 {
		t.Fatalf("marker = %v", got)
	}
	if got := sink.list(); !reflect.DeepEqual(got, []string{KindPackCleanupSkipped}) {
		t.Fatalf("events = %v", got)
	}
}

type guardRec struct {
	mu            sync.Mutex
	enters, leave int
}

func (g *guardRec) fn(string) func() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.enters++
	return func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.leave++
	}
}

func TestPackCleanupUsesWriteGuard(t *testing.T) {
	r, _, _, _, root := setup(t)
	g := &guardRec{}
	r.SetDataWriteGuard(g.fn)
	data := startPack(t, r, root)
	if g.enters != 0 {
		t.Fatalf("without a cleanup the guard is not used: %d", g.enters)
	}
	if err := r.Apply(context.Background(), specMsg("a", "alpha", 2, fabricJSON)); err != nil {
		t.Fatal(err)
	}
	if fileExists(t, filepath.Join(data, "mods", "a.jar")) {
		t.Fatal("not cleaned")
	}
	if g.enters != 1 || g.leave != 1 {
		t.Fatalf("enter=%d leave=%d", g.enters, g.leave)
	}
}

// Pack removed before the first container was ever created: there is no data folder, nothing to clean.
func TestPackCleanupWithoutDataFolder(t *testing.T) {
	r, st, fake, _, root := setup(t)
	if err := r.StoreForce(specMsg("a", "alpha", 1, mrPackJSON)); err != nil {
		t.Fatal(err)
	}
	if err := r.StoreForce(specMsg("a", "alpha", 2, fabricJSON)); err != nil {
		t.Fatal(err)
	}
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 1 || !fileExists(t, filepath.Join(root, "alpha", "data")) {
		t.Fatalf("the server must be created: %v", fake.Calls)
	}
	if got := packPending(t, st, "a"); len(got) != 0 {
		t.Fatalf("marker = %v", got)
	}
}

// The world named through env.LEVEL (which wins over the property) is protected too.
func TestPackCleanupProtectsEnvLevel(t *testing.T) {
	r, _, _, _, root := setup(t)
	data := startPack(t, r, root)
	for _, f := range []string{"envworld/region/r.mca"} {
		p := filepath.Join(data, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := json.Marshal(map[string]any{"files": []string{"mods/a.jar", "envworld/region/r.mca"}})
	if err := os.WriteFile(filepath.Join(data, ".modrinth-modpack-manifest.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	withEnv := strings.Replace(fabricJSON, `"rconPassword"`, `"env":{"LEVEL":"envworld"},"rconPassword"`, 1)
	if err := r.Apply(context.Background(), specMsg("a", "alpha", 2, withEnv)); err != nil {
		t.Fatal(err)
	}
	if fileExists(t, filepath.Join(data, "mods", "a.jar")) || !fileExists(t, filepath.Join(data, "envworld", "region", "r.mca")) {
		t.Fatal("the mod must go and the env.LEVEL world stay")
	}
}
