// Package packclean deletes the files a modpack installed in a server's data folder, from the
// manifest itzg (mc-image-helper) wrote when installing it. itzg only does it itself when the next
// pack is from the same platform (spike 2026-10-30, F2–F5): on uninstall or a switch to the other
// platform the agent does it before creating the new container.
//
// Safety: everything goes through os.Root (no escape from /data, not even through symlinks), the
// manifest's entries are only files or symlinks (never a directory, never RemoveAll), no parent
// may be a symlink, and the world, the server's own files and whatever the admin installed with
// MODRINTH_PROJECTS / CURSEFORGE_FILES are never touched.
package packclean

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"mcsm/agent/internal/spec"
)

// Manifests written by itzg (spike F6).
const (
	modrinthPackManifest   = ".modrinth-modpack-manifest.json" // MODRINTH_MODPACK
	curseforgePackManifest = ".curseforge-manifest.json"       // AUTO_CURSEFORGE
	// Admin-managed content (the Mods/Plugins/Datapacks tabs): what they list is never deleted.
	modrinthProjectsManifest = ".modrinth-manifest.json"         // MODRINTH_PROJECTS
	curseforgeFilesManifest  = ".curseforge-files-manifest.json" // CURSEFORGE_FILES
)

const (
	maxManifestBytes   = 8 << 20
	maxManifestEntries = 50_000
	// maxWarnings bounds the per-entry warnings of a hostile or broken manifest.
	maxWarnings = 10
)

var errTooLarge = errors.New("the previous modpack's manifest is too large")

// protectedTop are files of the server itself (top level of /data) that a pack may list but that
// belong to the admin.
var protectedTop = map[string]bool{
	"server.properties": true, "ops.json": true, "whitelist.json": true, "banned-players.json": true,
	"banned-ips.json": true, "usercache.json": true, "eula.txt": true,
	modrinthProjectsManifest: true, curseforgeFilesManifest: true,
}

// Options: LevelNames are the world folders (level-name) besides "world" and the pack's levelName.
// Log receives the warnings about entries not removed (nil = slog.Default()).
type Options struct {
	LevelNames []string
	Log        *slog.Logger
}

// Result: Removed files (and symlinks); Kept entries not removed (protected, unsafe or not a file).
type Result struct {
	Removed int
	Kept    int
}

// ManifestFor is the name of platform's pack manifest inside /data, or "" if the agent does not know it.
func ManifestFor(platform string) string {
	switch platform {
	case spec.PlatformModrinth:
		return modrinthPackManifest
	case spec.PlatformAutoCurseForge:
		return curseforgePackManifest
	}
	return ""
}

type manifest struct {
	Files     []string `json:"files"`
	LevelName *string  `json:"levelName"` // CurseForge pack manifest only (may be null)
}

// Clean deletes the files listed in platform's pack manifest inside dataDir, prunes the folders it
// leaves empty and finally deletes the manifest. Without a manifest (or a data folder) it does nothing. It is idempotent:
// after a failure the manifest stays and a new run finishes the job. With the container stopped.
func Clean(dataDir, platform string, opt Options) (Result, error) {
	name := ManifestFor(platform)
	if name == "" {
		return Result{}, fmt.Errorf("no known modpack manifest for platform %q", platform)
	}
	root, err := os.OpenRoot(dataDir)
	if errors.Is(err, fs.ErrNotExist) {
		return Result{}, nil // no data folder yet: nothing was installed
	}
	if err != nil {
		return Result{}, fmt.Errorf("open the data folder: %w", err)
	}
	defer root.Close()

	pack, ok, err := readManifest(root, name)
	if err != nil {
		if errors.Is(err, errTooLarge) {
			return Result{}, errTooLarge
		}
		return Result{}, fmt.Errorf("the previous modpack's manifest: %w", err)
	}
	if !ok {
		return Result{}, nil
	}
	protected, err := protectedFiles(root)
	if err != nil {
		return Result{}, err
	}
	// The world folders, with their dimensions (Bukkit keeps them next to it: <name>_nether, <name>_the_end).
	names := append([]string{"world"}, opt.LevelNames...)
	if pack.LevelName != nil {
		names = append(names, *pack.LevelName)
	}
	levels := map[string]bool{}
	for _, n := range names {
		if n != "" {
			levels[n], levels[n+"_nether"], levels[n+"_the_end"] = true, true, true
		}
	}

	log := opt.Log
	if log == nil {
		log = slog.Default()
	}
	log = log.With("component", "packclean", "manifest", name)
	warned := 0
	keep := func(entry, why string) {
		if warned < maxWarnings {
			log.Warn("modpack entry not removed", "entry", entry, "reason", why)
		} else if warned == maxWarnings {
			log.Warn("more modpack entries not removed (not logged)")
		}
		warned++
	}

	var res Result
	for _, entry := range pack.Files {
		if strings.ContainsRune(entry, 0) || !filepath.IsLocal(entry) {
			res.Kept++
			keep(entry, "not a path inside /data")
			continue
		}
		p := filepath.Clean(entry)
		parts := strings.Split(p, string(filepath.Separator))
		if protected[p] || levels[parts[0]] || (len(parts) == 1 && protectedTop[p]) {
			res.Kept++
			continue
		}
		removed, why, err := removeEntry(root, parts)
		if err != nil {
			return res, fmt.Errorf("remove %s: %w", p, err)
		}
		switch {
		case removed:
			res.Removed++
			prune(root, parts)
		case why != "":
			res.Kept++
			keep(entry, why)
		}
	}
	if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return res, fmt.Errorf("remove %s: %w", name, err)
	}
	return res, nil
}

// removeEntry deletes the file or symlink at parts. removed=false with why="" means it no longer
// exists (nothing to do); with why set, it was kept for that reason. err only for a failed deletion.
func removeEntry(root *os.Root, parts []string) (removed bool, why string, err error) {
	// Every parent must be a real folder: a symlink inside /data could lead to the world.
	for i := 1; i < len(parts); i++ {
		fi, err := root.Lstat(filepath.Join(parts[:i]...))
		if errors.Is(err, fs.ErrNotExist) {
			return false, "", nil
		}
		if err != nil {
			return false, err.Error(), nil
		}
		if !fi.IsDir() { // a symlink's Lstat mode is not a directory
			return false, "a parent folder is a symlink or not a folder", nil
		}
	}
	p := filepath.Join(parts...)
	fi, err := root.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, "", nil
	}
	if err != nil {
		return false, err.Error(), nil
	}
	if !fi.Mode().IsRegular() && fi.Mode()&fs.ModeSymlink == 0 {
		return false, "not a file", nil
	}
	if err := root.Remove(p); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, "", nil
		}
		return false, "", err
	}
	return true, "", nil
}

// prune deletes the parent folders of parts that are left empty (never the root, never a symlink).
func prune(root *os.Root, parts []string) {
	for i := len(parts) - 1; i >= 1; i-- {
		d := filepath.Join(parts[:i]...)
		fi, err := root.Lstat(d)
		if err != nil || !fi.IsDir() {
			return
		}
		if root.Remove(d) != nil { // not empty (or gone): neither are its parents
			return
		}
	}
}

// protectedFiles are the files listed by the admin-managed manifests.
func protectedFiles(root *os.Root) (map[string]bool, error) {
	out := map[string]bool{}
	for _, name := range []string{modrinthProjectsManifest, curseforgeFilesManifest} {
		m, ok, err := readManifest(root, name)
		if errors.Is(err, errTooLarge) {
			return nil, fmt.Errorf("the %s manifest is too large", name)
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if !ok {
			continue
		}
		for _, f := range m.Files {
			if filepath.IsLocal(f) {
				out[filepath.Clean(f)] = true
			}
		}
	}
	return out, nil
}

// readManifest reads a manifest at the top of /data. ok=false if it does not exist.
func readManifest(root *os.Root, name string) (m manifest, ok bool, err error) {
	f, err := root.Open(name)
	if errors.Is(err, fs.ErrNotExist) {
		return m, false, nil
	}
	if err != nil {
		return m, false, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxManifestBytes+1))
	if err != nil {
		return m, false, err
	}
	if len(b) > maxManifestBytes {
		return m, false, errTooLarge
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, false, fmt.Errorf("not valid JSON: %w", err)
	}
	if len(m.Files) > maxManifestEntries {
		return m, false, errTooLarge
	}
	return m, true, nil
}
