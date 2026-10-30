package spec

import "encoding/json"

// What itzg does with the previous modpack's files (spike 2026-10-30, F2–F5). Each installer
// (MODRINTH_MODPACK, AUTO_CURSEFORGE) only knows its own manifest: on uninstall (another TYPE) or
// when switching to the other platform, the outgoing pack's mods and configs stay in /data and
// break the new server. Switching pack on the same platform is cleaned by itzg itself.
var (
	uninstallCleans      = map[string]bool{PlatformModrinth: true, PlatformAutoCurseForge: true}
	sameSlugSwitchCleans = map[string]bool{PlatformModrinth: false, PlatformAutoCurseForge: false}
)

// ModpackOf reads only the modpack section of a stored spec, without validating the rest. nil on any
// error or if there is none: the stored spec may be from an older agent or be invalid.
func ModpackOf(specJSON []byte) *Modpack {
	var doc struct {
		Modpack *Modpack `json:"modpack"`
	}
	if err := json.Unmarshal(specJSON, &doc); err != nil {
		return nil
	}
	return doc.Modpack
}

// PackCleanupPlatform returns the platform whose modpack files the agent must delete when going from
// old to new (before creating the new container), or "" if itzg cleans them or there is nothing to do.
func PackCleanupPlatform(old, new *Modpack) string {
	if old == nil || !handledPlatform(old.Platform) {
		return ""
	}
	switch {
	case new == nil:
		if uninstallCleans[old.Platform] {
			return old.Platform
		}
		return ""
	case new.Platform != old.Platform:
		return old.Platform
	case new.SlugOrURL != old.SlugOrURL && sameSlugSwitchCleans[old.Platform]:
		return old.Platform
	}
	return "" // version change (or same pack): itzg replaces the files listed in its manifest
}

// handledPlatform: the platforms whose pack manifest the agent knows how to clean (packclean).
func handledPlatform(p string) bool { return p == PlatformModrinth || p == PlatformAutoCurseForge }
