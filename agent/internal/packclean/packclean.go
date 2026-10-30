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
	"strconv"
	"strings"
	"syscall"

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
	maxPropertiesBytes = 1 << 20
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

// Options: LevelNames are the world folders (level-name property, env LEVEL) besides "world", the level-name of
// /data/server.properties and the pack's levelName; only their first path element counts.
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
	// The world folders, with their dimensions (Bukkit keeps them next to it: <name>_nether, <name>_the_end):
	// "world", the ones given (level-name property, env LEVEL), server.properties on disk and the CF pack's.
	disk, err := diskLevelName(root)
	if err != nil {
		return Result{}, err
	}
	names := append([]string{"world", disk}, opt.LevelNames...)
	if pack.LevelName != nil {
		names = append(names, *pack.LevelName)
	}
	levels := map[string]bool{}
	for _, n := range names {
		if n = firstElement(n); n != "" {
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
	b, ok, err := readSmall(root, name, maxManifestBytes)
	if err != nil || !ok {
		return m, false, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, false, fmt.Errorf("%s is not valid JSON: %w", name, err)
	}
	if len(m.Files) > maxManifestEntries {
		return m, false, errTooLarge
	}
	return m, true, nil
}

// readSmall reads a regular file at the top of /data, up to max bytes (more → errTooLarge). ok=false if it does
// not exist. Opened with O_NONBLOCK: the container may have replaced it with a FIFO, whose open would block the
// agent forever with the server's lock held; anything but a regular file is refused.
func readSmall(root *os.Root, name string, max int64) (b []byte, ok bool, err error) {
	f, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	if !fi.Mode().IsRegular() {
		return nil, false, fmt.Errorf("%s is not a regular file", name)
	}
	b, err = io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) > max {
		return nil, false, errTooLarge
	}
	return b, true, nil
}

// diskLevelName is level-name in /data/server.properties ("" if absent): it may have been edited on disk
// (Files tab), and without LEVEL itzg keeps it.
func diskLevelName(root *os.Root) (string, error) {
	b, ok, err := readSmall(root, "server.properties", maxPropertiesBytes)
	if errors.Is(err, errTooLarge) {
		return "", errors.New("server.properties is too large")
	}
	if err != nil || !ok {
		return "", err
	}
	name := ""
	for _, line := range strings.Split(string(b), "\n") {
		if k, v, ok := propertyLine(line); ok && k == "level-name" {
			name = v // the last one wins, as in java.util.Properties
		}
	}
	return name, nil
}

// propertyLine parses one line of a .properties file (without continuation lines, which Minecraft never writes).
func propertyLine(line string) (key, value string, ok bool) {
	line = strings.TrimLeft(strings.TrimRight(line, "\r"), " \t\f")
	if line == "" || line[0] == '#' || line[0] == '!' {
		return "", "", false
	}
	i := 0
	for i < len(line) {
		c := line[i]
		if c == '\\' {
			i += 2
			continue
		}
		if c == '=' || c == ':' || c == ' ' || c == '\t' || c == '\f' {
			break
		}
		i++
	}
	key, rest := line[:min(i, len(line))], line[min(i, len(line)):]
	rest = strings.TrimLeft(rest, " \t\f")
	if rest != "" && (rest[0] == '=' || rest[0] == ':') {
		rest = strings.TrimLeft(rest[1:], " \t\f")
	}
	return unescapeProperty(key), unescapeProperty(rest), true
}

func unescapeProperty(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 == len(s) {
			out.WriteByte(s[i])
			continue
		}
		i++
		switch s[i] {
		case 't':
			out.WriteByte('\t')
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 'f':
			out.WriteByte('\f')
		case 'u':
			if i+4 < len(s) {
				if r, err := strconv.ParseUint(s[i+1:i+5], 16, 16); err == nil {
					out.WriteRune(rune(r))
					i += 4
					continue
				}
			}
			out.WriteByte('u')
		default:
			out.WriteByte(s[i])
		}
	}
	return out.String()
}

// firstElement is the folder of /data a level name points to: LEVEL from env is not validated like the
// property ("./w/sub" → "w"). "" if there is none.
func firstElement(name string) string {
	for _, part := range strings.Split(filepath.Clean(name), string(filepath.Separator)) {
		if part != "" && part != "." {
			return part
		}
	}
	return ""
}
