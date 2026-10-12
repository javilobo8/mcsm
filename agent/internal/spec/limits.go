package spec

import (
	"fmt"
	"sort"
)

// Topes de tamaño (auditoría L1), iguales a los de zod (panel/packages/shared/src/spec-limits.ts).
// Una spec enorme deja al nodo desconectado en bucle (el WebSocket corta los mensajes de más de
// 4 MiB y el panel reenvía el mismo SyncSpecs) y una variable de más de 128 KiB impide arrancar el
// contenedor (E2BIG). Las entradas de lista y las URL ya están acotadas por sus regex (300 y ~1000
// bytes) y la API key a 200. Las cadenas se miden en bytes UTF-8.
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
			sizedList{"plugins.spigetResources", len(s.Plugins.SpigetResources)}, sizedList{"plugins.urls", len(s.Plugins.URLs)})
	}
	if s.Whitelist != nil {
		lists = append(lists, sizedList{"whitelist.players", len(s.Whitelist.Players)})
	}
	for _, l := range lists {
		if l.n > MaxListItems {
			return fmt.Errorf("spec: la lista %s tiene %d elementos (máx. %d)", l.name, l.n, MaxListItems)
		}
	}

	strs := []sizedString{
		{"type", s.Type}, {"version", s.Version}, {"memory", s.Memory}, {"imageTag", s.ImageTag},
		{"resources.memLimit", s.Resources.MemLimit}, {"rconPassword", s.RconPassword},
	}
	for i, pm := range s.Ports.Extra {
		strs = append(strs, sizedString{fmt.Sprintf("ports.extra.%d.label", i), pm.Label})
	}
	// Claves ordenadas: con varias cadenas largas el error es siempre el mismo.
	for _, k := range sortedKeys(s.Env) {
		strs = append(strs, sizedString{"env." + k, k}, sizedString{"env." + k, s.Env[k]})
	}
	for _, k := range sortedKeys(s.Properties) {
		strs = append(strs, sizedString{"properties." + k, k}, sizedString{"properties." + k, s.Properties[k]})
	}
	for _, it := range strs {
		if len(it.v) > MaxStringBytes {
			return fmt.Errorf("spec: %s ocupa %d bytes (máx. %d)", it.name, len(it.v), MaxStringBytes)
		}
	}

	// Lo que de verdad llega al contenedor: variables generadas + env libre, "CLAVE=valor".
	total := 0
	for _, kv := range s.envList() {
		total += len(kv)
	}
	if total > MaxEnvBytes {
		return fmt.Errorf("spec: el entorno del contenedor ocuparía %d bytes (máx. 96 KiB): recorta listas, propiedades o variables de entorno", total)
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
