package spec

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Plataformas de modpack. El TYPE de la imagen es la propia plataforma: itzg
// (scripts/start-configuration) copia TYPE=MODRINTH|AUTO_CURSEFORGE|FTBA a
// MODPACK_PLATFORM, y emitir también MODPACK_PLATFORM con TYPE≠VANILLA solo
// produce el aviso "Avoid setting TYPE and MODPACK_PLATFORM". Por eso no se emite.
const (
	PlatformModrinth       = "MODRINTH"
	PlatformAutoCurseForge = "AUTO_CURSEFORGE"
	PlatformFTBA           = "FTBA"
)

// ModpackPlatforms son los valores válidos de modpack.platform (y de type con modpack).
var ModpackPlatforms = map[string]bool{PlatformModrinth: true, PlatformAutoCurseForge: true, PlatformFTBA: true}

// ModrinthLoaders son los valores de MODRINTH_LOADER que acepta mc-image-helper ("" = sin fijar).
var ModrinthLoaders = map[string]bool{"": true, "fabric": true, "forge": true, "quilt": true, "neoforge": true}

var (
	// listEntryRe: ASCII imprimible sin espacios ni comas (las listas se unen con comas).
	// El mismo patrón está en zod; no usar \s, que no significa lo mismo en Go (RE2) y en JS.
	listEntryRe = regexp.MustCompile(`^[!-+\--~]{1,300}$`)
	urlRe       = regexp.MustCompile(`^https?://[!-+\--~]{1,1000}$`)
	digitsRe    = regexp.MustCompile(`^[0-9]{1,12}$`)
	// playerRe: nombre de perfil de Java (1-16 letras, números o _) o UUID con o sin guiones.
	playerRe = regexp.MustCompile(`^([A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$`)
)

// whitelistProps las gestiona la sección whitelist por env; no pueden ir también en properties.
var whitelistProps = []string{"white-list", "enforce-whitelist"}

type Modpack struct {
	Platform  string `json:"platform"`
	SlugOrURL string `json:"slugOrUrl"`
	VersionID string `json:"versionId"`
	Loader    string `json:"loader"`
}

type ModSources struct {
	ModrinthProjects []string `json:"modrinthProjects"`
	CurseforgeFiles  []string `json:"curseforgeFiles"`
	URLs             []string `json:"urls"`
}

type PluginSources struct {
	ModrinthProjects []string `json:"modrinthProjects"`
	SpigetResources  []string `json:"spigetResources"`
	URLs             []string `json:"urls"`
}

type Whitelist struct {
	Enabled bool     `json:"enabled"`
	Players []string `json:"players"`
}

type listRule struct {
	name  string
	items []string
	re    *regexp.Regexp
}

// UsesCurseForge indica si la spec descarga algo de CurseForge (y por tanto recibe CF_API_KEY).
func (s Spec) UsesCurseForge() bool {
	return (s.Modpack != nil && s.Modpack.Platform == PlatformAutoCurseForge) ||
		(s.Mods != nil && len(s.Mods.CurseforgeFiles) > 0)
}

func (s Spec) validateContent() error {
	if err := s.validateModpack(); err != nil {
		return err
	}
	var rules []listRule
	if s.Mods != nil {
		rules = append(rules,
			listRule{"mods.modrinthProjects", s.Mods.ModrinthProjects, listEntryRe},
			listRule{"mods.curseforgeFiles", s.Mods.CurseforgeFiles, listEntryRe},
			listRule{"mods.urls", s.Mods.URLs, urlRe})
	}
	if s.Plugins != nil {
		rules = append(rules,
			listRule{"plugins.modrinthProjects", s.Plugins.ModrinthProjects, listEntryRe},
			listRule{"plugins.spigetResources", s.Plugins.SpigetResources, digitsRe},
			listRule{"plugins.urls", s.Plugins.URLs, urlRe})
	}
	rules = append(rules, listRule{"ops", s.Ops, playerRe})
	if s.Whitelist != nil {
		rules = append(rules, listRule{"whitelist.players", s.Whitelist.Players, playerRe})
		for _, k := range whitelistProps {
			if _, ok := s.Properties[k]; ok {
				return fmt.Errorf("spec: la propiedad %s se gestiona desde la sección whitelist", k)
			}
		}
	}
	for _, r := range rules {
		for _, it := range r.items {
			if !r.re.MatchString(it) {
				return fmt.Errorf("spec: entrada inválida en %s: %q", r.name, it)
			}
		}
	}
	return nil
}

func (s Spec) validateModpack() error {
	mp := s.Modpack
	if mp == nil {
		if ModpackPlatforms[s.Type] {
			return fmt.Errorf("spec: type %s requiere un modpack", s.Type)
		}
		return nil
	}
	if !ModpackPlatforms[mp.Platform] {
		return fmt.Errorf("spec: modpack.platform inválida %q (MODRINTH|AUTO_CURSEFORGE|FTBA)", mp.Platform)
	}
	if s.Type != mp.Platform {
		return fmt.Errorf("spec: un modpack de %s requiere type=%s (type actual %q)", mp.Platform, mp.Platform, s.Type)
	}
	if !listEntryRe.MatchString(mp.SlugOrURL) {
		return fmt.Errorf("spec: modpack.slugOrUrl es obligatorio, sin espacios ni comas")
	}
	if mp.VersionID != "" && !listEntryRe.MatchString(mp.VersionID) {
		return fmt.Errorf("spec: modpack.versionId inválido %q", mp.VersionID)
	}
	if mp.Platform != PlatformModrinth && mp.Loader != "" {
		return fmt.Errorf("spec: modpack.loader solo se elige en modpacks de Modrinth")
	}
	switch mp.Platform {
	case PlatformModrinth:
		if !ModrinthLoaders[mp.Loader] {
			return fmt.Errorf("spec: modpack.loader inválido %q (fabric|forge|quilt|neoforge)", mp.Loader)
		}
	case PlatformAutoCurseForge:
		if mp.VersionID != "" && !digitsRe.MatchString(mp.VersionID) {
			return fmt.Errorf("spec: en CurseForge modpack.versionId es el id numérico del fichero")
		}
	case PlatformFTBA:
		if !digitsRe.MatchString(mp.SlugOrURL) || (mp.VersionID != "" && !digitsRe.MatchString(mp.VersionID)) {
			return fmt.Errorf("spec: los modpacks de FTB se indican con su id numérico (y versión numérica)")
		}
	}
	return nil
}

// contentEnv añade a m las variables itzg de modpack, mods, plugins, whitelist y ops.
// Una sección ausente no emite nada: las specs anteriores a este plan conservan su hash.
func (s Spec) contentEnv(m map[string]string) {
	if mp := s.Modpack; mp != nil {
		switch mp.Platform {
		case PlatformModrinth:
			m["MODRINTH_MODPACK"] = mp.SlugOrURL
			setIf(m, "MODRINTH_VERSION", mp.VersionID)
			setIf(m, "MODRINTH_LOADER", mp.Loader)
		case PlatformAutoCurseForge:
			if strings.HasPrefix(mp.SlugOrURL, "http://") || strings.HasPrefix(mp.SlugOrURL, "https://") {
				m["CF_PAGE_URL"] = mp.SlugOrURL
			} else {
				m["CF_SLUG"] = mp.SlugOrURL
			}
			setIf(m, "CF_FILE_ID", mp.VersionID)
		case PlatformFTBA:
			m["FTB_MODPACK_ID"] = mp.SlugOrURL
			setIf(m, "FTB_MODPACK_VERSION_ID", mp.VersionID)
		}
	}
	if s.Mods != nil || s.Plugins != nil {
		var mods, plugins []string
		if s.Mods != nil {
			mods = s.Mods.ModrinthProjects
		}
		if s.Plugins != nil {
			plugins = s.Plugins.ModrinthProjects
		}
		// Con la sección presente se emite aunque quede vacía: itzg borra entonces lo que
		// instaló desde Modrinth (quitar el último mod en la UI lo quita del servidor).
		m["MODRINTH_PROJECTS"] = joinList(mods, plugins)
	}
	if s.Mods != nil {
		setIf(m, "CURSEFORGE_FILES", joinList(s.Mods.CurseforgeFiles))
		setIf(m, "MODS", joinList(s.Mods.URLs))
	}
	if s.Plugins != nil {
		setIf(m, "SPIGET_RESOURCES", joinList(s.Plugins.SpigetResources))
		setIf(m, "PLUGINS", joinList(s.Plugins.URLs))
	}
	if w := s.Whitelist; w != nil {
		if w.Enabled {
			m["ENABLE_WHITELIST"] = "true"
			// Sección presente: el panel es la fuente de verdad aunque la lista quede vacía
			// (quitar al último jugador debe vaciar el fichero; sin SYNCHRONIZE itzg lo conserva).
			m["WHITELIST"] = joinPlayers(w.Players)
			m["EXISTING_WHITELIST_FILE"] = "SYNCHRONIZE"
		} else {
			// Explícito: sin esto, una whitelist activada antes seguiría activa en server.properties.
			m["ENABLE_WHITELIST"] = "false"
		}
	}
	// Ops: nil = ausente (no se emite nada); presente (aunque vacío) sincroniza el fichero,
	// de modo que revocar al último op le quita el permiso.
	if s.Ops != nil {
		m["OPS"] = joinPlayers(s.Ops)
		m["EXISTING_OPS_FILE"] = "SYNCHRONIZE"
	}
	if s.CurseForgeAPIKey != "" && s.UsesCurseForge() {
		m["CF_API_KEY"] = s.CurseForgeAPIKey
	}
}

func setIf(m map[string]string, k, v string) {
	if v != "" {
		m[k] = v
	}
}

// joinList une las listas sin duplicados y ordenadas, separadas por comas: reordenar en la
// UI no cambia el env (ni el hash, ni recrea el contenedor).
func joinList(lists ...[]string) string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, it := range l {
			if !seen[it] {
				seen[it] = true
				out = append(out, it)
			}
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// joinPlayers como joinList pero sin distinguir mayúsculas (los nombres de Minecraft no
// las distinguen): se conserva la primera variante en orden ASCII.
func joinPlayers(list []string) string {
	out := append([]string{}, list...)
	sort.Strings(out)
	seen := map[string]bool{}
	res := out[:0]
	for _, it := range out {
		k := strings.ToLower(it)
		if !seen[k] {
			seen[k] = true
			res = append(res, it)
		}
	}
	return strings.Join(res, ",")
}
