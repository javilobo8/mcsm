package packclean

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"mcsm/agent/internal/spec"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func opts() Options { return Options{Log: quiet} }

// tree creates files (with content) under dir; a name ending in "/" is a directory.
func tree(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, n := range names {
		p := filepath.Join(dir, filepath.FromSlash(n))
		if strings.HasSuffix(n, "/") {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(n), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func writeManifest(t *testing.T, dir, name string, doc map[string]any) {
	t.Helper()
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(t *testing.T, p string) bool {
	t.Helper()
	_, err := os.Lstat(p)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return err == nil
}

func TestManifestFor(t *testing.T) {
	if got := ManifestFor(spec.PlatformModrinth); got != ".modrinth-modpack-manifest.json" {
		t.Fatalf("Modrinth: %q", got)
	}
	if got := ManifestFor(spec.PlatformAutoCurseForge); got != ".curseforge-manifest.json" {
		t.Fatalf("CurseForge: %q", got)
	}
	if got := ManifestFor(spec.PlatformFTBA); got != "" {
		t.Fatalf("FTB: %q", got)
	}
}

func TestCleanRemovesManifestFiles(t *testing.T) {
	dir := t.TempDir()
	files := []string{"mods/a.jar", "config/a.toml", "kubejs/x.js"}
	tree(t, dir, files...)
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": files, "projectSlug": "adrenaserver"})
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Removed: 3}) {
		t.Fatalf("result = %+v", res)
	}
	for _, p := range append(files, "mods", "config", "kubejs", ".modrinth-modpack-manifest.json") {
		if exists(t, filepath.Join(dir, p)) {
			t.Errorf("%s still exists", p)
		}
	}
	if !exists(t, dir) {
		t.Fatal("the data folder itself must stay")
	}
}

func TestCleanPrunesOnlyEmptyDirectories(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "mods/a.jar", "mods/mine.jar", "config/sub/a.toml")
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"mods/a.jar", "config/sub/a.toml"}})
	if _, err := Clean(dir, spec.PlatformModrinth, opts()); err != nil {
		t.Fatal(err)
	}
	if !exists(t, filepath.Join(dir, "mods", "mine.jar")) {
		t.Fatal("a file outside the manifest was removed")
	}
	if exists(t, filepath.Join(dir, "config")) {
		t.Fatal("config/sub and config were left empty: they must be pruned")
	}
}

func TestCleanKeepsWorldAndAdminFiles(t *testing.T) {
	dir := t.TempDir()
	listed := []string{"world/datapacks/p.zip", "myworld/region/r.0.0.mca", "server.properties", "ops.json", "mods/extra.jar"}
	tree(t, dir, listed...)
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": listed})
	writeManifest(t, dir, ".modrinth-manifest.json", map[string]any{"files": []string{"mods/extra.jar"}, "projects": []string{"extra"}})
	res, err := Clean(dir, spec.PlatformModrinth, Options{LevelNames: []string{"myworld"}, Log: quiet})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range listed {
		if !exists(t, filepath.Join(dir, p)) {
			t.Errorf("%s was removed", p)
		}
	}
	if res != (Result{Kept: 5}) {
		t.Fatalf("result = %+v", res)
	}
}

func TestCleanKeepsDimensionFoldersAndOtherProtectedNames(t *testing.T) {
	dir := t.TempDir()
	listed := []string{
		"world_nether/DIM-1/r.mca", "world_the_end/DIM1/r.mca", "myworld_nether/x", "myworld_the_end/x",
		"whitelist.json", "banned-players.json", "banned-ips.json", "usercache.json", "eula.txt",
		"plugins/cf.jar", ".curseforge-files-manifest.json", ".modrinth-manifest.json",
	}
	tree(t, dir, listed...)
	writeManifest(t, dir, ".curseforge-manifest.json", map[string]any{"files": listed, "levelName": nil})
	writeManifest(t, dir, ".curseforge-files-manifest.json", map[string]any{"files": []string{"plugins/cf.jar"}})
	writeManifest(t, dir, ".modrinth-manifest.json", map[string]any{"files": []string{}})
	res, err := Clean(dir, spec.PlatformAutoCurseForge, Options{LevelNames: []string{"myworld"}, Log: quiet})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range listed {
		if !exists(t, filepath.Join(dir, p)) {
			t.Errorf("%s was removed", p)
		}
	}
	if res.Removed != 0 || res.Kept != len(listed) {
		t.Fatalf("result = %+v", res)
	}
}

func TestCleanRejectsEscapingPaths(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "data")
	outside := filepath.Join(base, "outside")
	tree(t, base, "outside.txt", "outside/evil.txt", "data/")
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	hostname := filepath.Join(base, "hostname")
	tree(t, base, "hostname")
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{
		"../outside.txt", hostname, "link/evil.txt", "", "mods/nul\x00.jar", "mods/../../outside.txt",
	}})
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(base, "outside.txt"), hostname, filepath.Join(outside, "evil.txt"), filepath.Join(dir, "link")} {
		if !exists(t, p) {
			t.Errorf("%s was removed", p)
		}
	}
	if res.Removed != 0 || res.Kept != 6 {
		t.Fatalf("result = %+v", res)
	}
}

// A symlinked folder inside /data must not let an entry reach a protected folder (the world).
func TestCleanDoesNotFollowSymlinkedParents(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "world/level.dat")
	if err := os.Symlink("world", filepath.Join(dir, "alias")); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"alias/level.dat"}})
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil {
		t.Fatal(err)
	}
	if !exists(t, filepath.Join(dir, "world", "level.dat")) || !exists(t, filepath.Join(dir, "alias")) {
		t.Fatal("the world was reached through a symlink")
	}
	if res != (Result{Kept: 1}) {
		t.Fatalf("result = %+v", res)
	}
}

// A listed symlink is removed as such: its target stays.
func TestCleanRemovesSymlinkNotTarget(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "keep/target.jar")
	if err := os.MkdirAll(filepath.Join(dir, "mods"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../keep/target.jar", filepath.Join(dir, "mods", "l.jar")); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"mods/l.jar"}})
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil {
		t.Fatal(err)
	}
	if exists(t, filepath.Join(dir, "mods", "l.jar")) || !exists(t, filepath.Join(dir, "keep", "target.jar")) {
		t.Fatal("the link must go and its target stay")
	}
	if res != (Result{Removed: 1}) {
		t.Fatalf("result = %+v", res)
	}
}

func TestCleanMissingManifestIsNoop(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "mods/a.jar")
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil || res != (Result{}) {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
	if !exists(t, filepath.Join(dir, "mods", "a.jar")) {
		t.Fatal("nothing must be touched")
	}
}

func TestCleanNeverRemovesDirectories(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "mods/a.jar", "empty/")
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"mods", "empty"}})
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil {
		t.Fatal(err)
	}
	if !exists(t, filepath.Join(dir, "mods", "a.jar")) || !exists(t, filepath.Join(dir, "empty")) {
		t.Fatal("a listed directory was removed")
	}
	if res != (Result{Kept: 2}) {
		t.Fatalf("result = %+v", res)
	}
}

func TestCleanCurseForgeLevelName(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "packworld/level.dat", "mods/a.jar")
	writeManifest(t, dir, ".curseforge-manifest.json", map[string]any{"files": []string{"packworld/level.dat", "mods/a.jar"}, "levelName": "packworld"})
	res, err := Clean(dir, spec.PlatformAutoCurseForge, opts())
	if err != nil {
		t.Fatal(err)
	}
	if !exists(t, filepath.Join(dir, "packworld", "level.dat")) || exists(t, filepath.Join(dir, "mods", "a.jar")) {
		t.Fatal("level.dat must stay and the mod go")
	}
	if exists(t, filepath.Join(dir, ".curseforge-manifest.json")) {
		t.Fatal("the pack manifest must be removed")
	}
	if res != (Result{Removed: 1, Kept: 1}) {
		t.Fatalf("result = %+v", res)
	}
}

func TestCleanManifestTooLarge(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "mods/a.jar")
	many := make([]string, 50_001)
	for i := range many {
		many[i] = "mods/a.jar"
	}
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": many})
	if _, err := Clean(dir, spec.PlatformModrinth, opts()); err == nil || err.Error() != "the previous modpack's manifest is too large" {
		t.Fatalf("too many entries: err = %v", err)
	}
	big := `{"files":["` + strings.Repeat("a", 8<<20) + `"]}`
	if err := os.WriteFile(filepath.Join(dir, ".modrinth-modpack-manifest.json"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Clean(dir, spec.PlatformModrinth, opts()); err == nil || err.Error() != "the previous modpack's manifest is too large" {
		t.Fatalf("over 8 MiB: err = %v", err)
	}
	if !exists(t, filepath.Join(dir, "mods", "a.jar")) {
		t.Fatal("nothing must be removed")
	}
}

func TestCleanInvalidManifestFails(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "mods/a.jar")
	if err := os.WriteFile(filepath.Join(dir, ".modrinth-modpack-manifest.json"), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Clean(dir, spec.PlatformModrinth, opts()); err == nil {
		t.Fatal("an unreadable manifest must fail (nothing is removed blindly)")
	}
	// An unreadable admin manifest: what it protects is unknown, so nothing is removed either.
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"mods/a.jar"}})
	if err := os.WriteFile(filepath.Join(dir, ".modrinth-manifest.json"), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Clean(dir, spec.PlatformModrinth, opts()); err == nil {
		t.Fatal("an unreadable admin manifest must fail")
	}
	if !exists(t, filepath.Join(dir, "mods", "a.jar")) {
		t.Fatal("nothing must be removed")
	}
}

func TestCleanUnknownPlatform(t *testing.T) {
	if _, err := Clean(t.TempDir(), spec.PlatformFTBA, opts()); err == nil {
		t.Fatal("FTB has no known manifest")
	}
}

// Idempotent: a second run after a partial one (the manifest stays until the end) finishes the job.
func TestCleanIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "mods/b.jar")
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"mods/a.jar", "mods/b.jar"}})
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Removed: 1}) || exists(t, filepath.Join(dir, "mods")) {
		t.Fatalf("result = %+v", res)
	}
}

// A server whose pack was removed before its first container existed has no data folder yet.
func TestCleanMissingDataDirIsNoop(t *testing.T) {
	res, err := Clean(filepath.Join(t.TempDir(), "nope"), spec.PlatformModrinth, opts())
	if err != nil || res != (Result{}) {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
}

// cleanWithDeadline runs Clean and fails the test instead of hanging forever if it blocks.
func cleanWithDeadline(t *testing.T, dir, platform string, opt Options) (Result, error) {
	t.Helper()
	type out struct {
		res Result
		err error
	}
	ch := make(chan out, 1)
	go func() {
		res, err := Clean(dir, platform, opt)
		ch <- out{res, err}
	}()
	select {
	case o := <-ch:
		return o.res, o.err
	case <-time.After(5 * time.Second):
		t.Fatal("Clean blocked")
		return Result{}, nil
	}
}

// A container can replace a manifest with a FIFO: opening it must not block the agent (it holds the
// server's lock), and a FIFO is not a manifest.
func TestCleanRefusesFIFOManifests(t *testing.T) {
	for _, name := range []string{".modrinth-modpack-manifest.json", ".modrinth-manifest.json", ".curseforge-files-manifest.json", "server.properties"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			tree(t, dir, "mods/a.jar")
			if name != ".modrinth-modpack-manifest.json" {
				writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"mods/a.jar"}})
			}
			if err := syscall.Mkfifo(filepath.Join(dir, name), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := cleanWithDeadline(t, dir, spec.PlatformModrinth, opts())
			if err == nil || !strings.Contains(err.Error(), name) {
				t.Fatalf("err = %v, want an error naming %s", err, name)
			}
			if !exists(t, filepath.Join(dir, "mods", "a.jar")) {
				t.Fatal("nothing must be removed")
			}
		})
	}
}

// The world may be named on disk (server.properties edited from the Files tab): it is protected too.
func TestCleanProtectsLevelFromServerProperties(t *testing.T) {
	dir := t.TempDir()
	listed := []string{"diskworld/region/r.0.0.mca", "diskworld_nether/x", "my world/level.dat", "mods/a.jar"}
	tree(t, dir, listed...)
	props := "#Minecraft server properties\nmotd=hi\n  level-name = diskworld\n"
	if err := os.WriteFile(filepath.Join(dir, "server.properties"), []byte(props), 0o644); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": listed})
	res, err := Clean(dir, spec.PlatformModrinth, opts())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range listed[:2] {
		if !exists(t, filepath.Join(dir, p)) {
			t.Errorf("%s was removed", p)
		}
	}
	if exists(t, filepath.Join(dir, "mods", "a.jar")) {
		t.Fatal("the mod must go")
	}
	if res.Removed != 2 || res.Kept != 2 { // "my world" is not the world here
		t.Fatalf("result = %+v", res)
	}
	// Escaped value (Java properties): "my\ world".
	tree(t, dir, "my world/level.dat")
	if err := os.WriteFile(filepath.Join(dir, "server.properties"), []byte("level-name=my\\ world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"my world/level.dat"}})
	if _, err := Clean(dir, spec.PlatformModrinth, opts()); err != nil {
		t.Fatal(err)
	}
	if !exists(t, filepath.Join(dir, "my world", "level.dat")) {
		t.Fatal("an escaped level-name must be protected")
	}
}

// LevelNames from env.LEVEL are not validated like the property: only the first path element counts.
func TestCleanLevelNamesUseFirstElement(t *testing.T) {
	dir := t.TempDir()
	tree(t, dir, "envworld/region/r.mca", "mods/a.jar")
	writeManifest(t, dir, ".modrinth-modpack-manifest.json", map[string]any{"files": []string{"envworld/region/r.mca", "mods/a.jar"}})
	res, err := Clean(dir, spec.PlatformModrinth, Options{LevelNames: []string{"./envworld/sub/"}, Log: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if !exists(t, filepath.Join(dir, "envworld", "region", "r.mca")) || res != (Result{Removed: 1, Kept: 1}) {
		t.Fatalf("result = %+v", res)
	}
}
