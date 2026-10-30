package spec

import (
	"fmt"
	"sort"
)

// Size caps (audit L1), equal to zod's (panel/packages/shared/src/spec-limits.ts).
// A huge spec leaves the node disconnected in a loop (the WebSocket cuts messages over
// 4 MiB and the panel resends the same SyncSpecs) and a variable over 128 KiB prevents starting the
// container (E2BIG). List entries and URLs are already bounded by their regexes (300 and ~1000
// bytes) and the API key to 200. Strings are measured in UTF-8 bytes.
const (
	MaxListItems   = 1000
	MaxStringBytes = 4 << 10
	MaxEnvBytes    = 96 << 10
)

type sizedList struct {
	name string
	n    int
}

type sizedString struct {
	name, v string
}

func (s Spec) validateLimits() error {
	lists := []sizedList{{"ops", len(s.Ops)}, {"ports.extra", len(s.Ports.Extra)}}
	if s.Mods != nil {
		lists = append(lists, sizedList{"mods.modrinthProjects", len(s.Mods.ModrinthProjects)},
			sizedList{"mods.curseforgeFiles", len(s.Mods.CurseforgeFiles)}, sizedList{"mods.urls", len(s.Mods.URLs)})
	}
	if s.Plugins != nil {
		lists = append(lists, sizedList{"plugins.modrinthProjects", len(s.Plugins.ModrinthProjects)},
			sizedList{"plugins.spigetResources", len(s.Plugins.SpigetResources)}, sizedList{"plugins.urls", len(s.Plugins.URLs)},
			sizedList{"plugins.curseforgeFiles", len(s.Plugins.CurseforgeFiles)})
	}
	if s.Datapacks != nil {
		lists = append(lists, sizedList{"datapacks.modrinthProjects", len(s.Datapacks.ModrinthProjects)})
	}
	if s.Whitelist != nil {
		lists = append(lists, sizedList{"whitelist.players", len(s.Whitelist.Players)})
	}
	for _, l := range lists {
		if l.n > MaxListItems {
			return fmt.Errorf("spec: the %s list has %d elements (max. %d)", l.name, l.n, MaxListItems)
		}
	}

	strs := []sizedString{
		{"type", s.Type}, {"version", s.Version}, {"memory", s.Memory}, {"imageTag", s.ImageTag},
		{"resources.memLimit", s.Resources.MemLimit}, {"rconPassword", s.RconPassword},
	}
	for i, pm := range s.Ports.Extra {
		strs = append(strs, sizedString{fmt.Sprintf("ports.extra.%d.label", i), pm.Label})
	}
	// Sorted keys: with several long strings the error is always the same.
	for _, k := range sortedKeys(s.Env) {
		strs = append(strs, sizedString{"env." + k, k}, sizedString{"env." + k, s.Env[k]})
	}
	for _, k := range sortedKeys(s.Properties) {
		strs = append(strs, sizedString{"properties." + k, k}, sizedString{"properties." + k, s.Properties[k]})
	}
	for _, it := range strs {
		if len(it.v) > MaxStringBytes {
			return fmt.Errorf("spec: %s takes %d bytes (max. %d)", it.name, len(it.v), MaxStringBytes)
		}
	}

	// What really reaches the container: generated variables + free-form env, "KEY=value".
	total := 0
	for _, kv := range s.envList() {
		total += len(kv)
	}
	if total > MaxEnvBytes {
		return fmt.Errorf("spec: the container environment would take %d bytes (max. 96 KiB): trim lists, properties or environment variables", total)
	}
	return nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
