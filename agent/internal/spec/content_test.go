package spec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixturePath(name string) string {
	return filepath.Join("..", "..", "..", "proto", "fixtures", name)
}

func loadModded(t *testing.T) Spec {
	t.Helper()
	b, err := os.ReadFile(fixturePath("spec-modded.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func buildEnv(t *testing.T, s Spec) map[string]string {
	t.Helper()
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	return envMap(b.Config.Env)
}

func hashOfSpec(t *testing.T, s Spec) string {
	t.Helper()
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	return b.Hash
}

// Casos compartidos con panel/packages/shared/src/spec-content.test.ts: Go y zod deben
// aceptar y rechazar exactamente lo mismo.
func TestContentCasesSharedWithZod(t *testing.T) {
	baseRaw, err := os.ReadFile(fixturePath("spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	casesRaw, err := os.ReadFile(fixturePath("spec-content-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string                     `json:"name"`
		OK    bool                       `json:"ok"`
		Merge map[string]json.RawMessage `json:"merge"`
	}
	if err := json.Unmarshal(casesRaw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("solo %d casos: ¿fixture truncada?", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(baseRaw, &doc); err != nil {
				t.Fatal(err)
			}
			for k, v := range c.Merge {
				doc[k] = v
			}
			b, _ := json.Marshal(doc)
			_, err := Parse(b)
			if c.OK && err != nil {
				t.Fatalf("debía aceptarse: %v", err)
			}
			if !c.OK && err == nil {
				t.Fatal("debía rechazarse")
			}
		})
	}
}

func TestContentEnvModrinthModpack(t *testing.T) {
	env := buildEnv(t, loadModded(t))
	want := map[string]string{
		"TYPE":                    "MODRINTH",
		"MODRINTH_MODPACK":        "cobblemon-fabric",
		"MODRINTH_LOADER":         "fabric",
		"MODRINTH_PROJECTS":       "ferritecore:beta,lithium",
		"ENABLE_WHITELIST":        "true",
		"WHITELIST":               "Lobo,Steve",
		"EXISTING_WHITELIST_FILE": "SYNCHRONIZE",
		"OPS":                     "Lobo",
		"EXISTING_OPS_FILE":       "SYNCHRONIZE",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	for _, k := range []string{"MODPACK_PLATFORM", "MODRINTH_VERSION", "CF_API_KEY", "MODS", "PLUGINS", "SPIGET_RESOURCES", "CURSEFORGE_FILES"} {
		if _, ok := env[k]; ok {
			t.Errorf("no debía emitirse %s (= %q)", k, env[k])
		}
	}
}

func TestContentEnvCurseForgeAndFTB(t *testing.T) {
	s := loadFixture(t)
	s.Type = PlatformAutoCurseForge
	s.Modpack = &Modpack{Platform: PlatformAutoCurseForge, SlugOrURL: "all-the-mods-10", VersionID: "6013341"}
	s.CurseForgeAPIKey = "$2a$10$abc/def"
	env := buildEnv(t, s)
	if env["CF_SLUG"] != "all-the-mods-10" || env["CF_FILE_ID"] != "6013341" || env["CF_PAGE_URL"] != "" {
		t.Errorf("slug: %v", env)
	}
	if env["CF_API_KEY"] != "$2a$10$abc/def" {
		t.Errorf("CF_API_KEY = %q (los $ no se escapan: la API de Docker no interpola)", env["CF_API_KEY"])
	}

	s.Modpack.SlugOrURL = "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10"
	env = buildEnv(t, s)
	if env["CF_PAGE_URL"] != s.Modpack.SlugOrURL || env["CF_SLUG"] != "" {
		t.Errorf("url: %v", env)
	}

	f := loadFixture(t)
	f.Type = PlatformFTBA
	f.Modpack = &Modpack{Platform: PlatformFTBA, SlugOrURL: "126", VersionID: "100"}
	env = buildEnv(t, f)
	if env["FTB_MODPACK_ID"] != "126" || env["FTB_MODPACK_VERSION_ID"] != "100" || env["TYPE"] != "FTBA" {
		t.Errorf("ftba: %v", env)
	}
}

func TestContentEnvModsPluginsAndWhitelistOff(t *testing.T) {
	s := loadFixture(t) // PAPER
	s.Plugins = &PluginSources{ModrinthProjects: []string{"luckperms"}, SpigetResources: []string{"34315", "28140"}, URLs: []string{"https://example.com/b.jar", "https://example.com/a.jar"}}
	s.Mods = &ModSources{CurseforgeFiles: []string{"jei:4593548"}}
	s.Whitelist = &Whitelist{Enabled: false, Players: []string{"Lobo"}}
	env := buildEnv(t, s)
	want := map[string]string{
		"MODRINTH_PROJECTS": "luckperms",
		"SPIGET_RESOURCES":  "28140,34315",
		"PLUGINS":           "https://example.com/a.jar,https://example.com/b.jar",
		"CURSEFORGE_FILES":  "jei:4593548",
		"ENABLE_WHITELIST":  "false",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	if _, ok := env["WHITELIST"]; ok {
		t.Error("con la whitelist desactivada no se emite WHITELIST (itzg la activaría)")
	}
	if _, ok := env["CF_API_KEY"]; ok {
		t.Error("sin API key en la spec no se emite CF_API_KEY")
	}
}

func TestEnvLibreGanaSobreLoGenerado(t *testing.T) {
	s := loadModded(t)
	s.Env = map[string]string{"EXISTING_WHITELIST_FILE": "MERGE"}
	if env := buildEnv(t, s); env["EXISTING_WHITELIST_FILE"] != "MERGE" {
		t.Errorf("env libre debe ganar: %q", env["EXISTING_WHITELIST_FILE"])
	}
}

// El hash solo cambia cuando cambia el contenedor.
func TestContentHash(t *testing.T) {
	base := loadFixture(t)
	h0 := hashOfSpec(t, base)
	// Valor calculado con el código del Plan 1 para spec-example.json: si cambia, al
	// actualizar el agente se recrearían TODOS los contenedores existentes. Solo puede
	// cambiar si se actualiza la versión de github.com/moby/moby/api.
	if h0 != "09ff6e5490b40677" {
		t.Fatalf("el hash de una spec sin campos nuevos cambió: %s", h0)
	}

	noOps := base
	noOps.Ops = []string{}
	if hashOfSpec(t, noOps) == h0 {
		t.Error("ops presente y vacío debe cambiar el hash (sincroniza el fichero)")
	}
	absentOps := base
	absentOps.Ops = nil
	if hashOfSpec(t, absentOps) != h0 {
		t.Error("ops ausente no debe cambiar el hash")
	}

	withKey := base
	withKey.CurseForgeAPIKey = "k"
	if hashOfSpec(t, withKey) != h0 {
		t.Error("la API key de CurseForge no debe afectar a servidores que no usan CurseForge")
	}

	a := base
	a.Mods = &ModSources{ModrinthProjects: []string{"lithium", "sodium"}}
	b := base
	b.Mods = &ModSources{ModrinthProjects: []string{"sodium", "lithium", "lithium"}}
	if hashOfSpec(t, a) != hashOfSpec(t, b) {
		t.Error("reordenar o duplicar mods no debe recrear el contenedor")
	}
	if hashOfSpec(t, a) == h0 {
		t.Error("añadir mods debe cambiar el hash")
	}

	cf := base
	cf.Mods = &ModSources{CurseforgeFiles: []string{"jei"}}
	cf1, cf2 := cf, cf
	cf1.CurseForgeAPIKey = "uno"
	cf2.CurseForgeAPIKey = "dos"
	if hashOfSpec(t, cf1) == hashOfSpec(t, cf2) {
		t.Error("cambiar la API key debe recrear los servidores que usan CurseForge")
	}
}

// Quitar el último mod debe llegar a itzg como MODRINTH_PROJECTS vacía (borra lo instalado);
// sin la sección, la variable no existe y itzg no toca nada.
func TestEmptyModsSectionClearsModrinthProjects(t *testing.T) {
	s := loadFixture(t)
	if _, ok := buildEnv(t, s)["MODRINTH_PROJECTS"]; ok {
		t.Fatal("sin sección mods/plugins no debe existir MODRINTH_PROJECTS")
	}
	s.Mods = &ModSources{}
	env := buildEnv(t, s)
	if v, ok := env["MODRINTH_PROJECTS"]; !ok || v != "" {
		t.Errorf("MODRINTH_PROJECTS = %q (presente=%v), want vacía y presente", v, ok)
	}
	for _, k := range []string{"MODS", "CURSEFORGE_FILES"} {
		if _, ok := env[k]; ok {
			t.Errorf("%s vacía no debe emitirse", k)
		}
	}
}

func TestParseIgnoresUnknownFields(t *testing.T) {
	// Campos de otros planes (p. ej. backups) no deben romper el agente de este plan.
	raw, _ := os.ReadFile(fixturePath("spec-example.json"))
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(raw, &doc)
	doc["backups"] = json.RawMessage(`{"enabled":true,"cron":"0 4 * * *"}`)
	b, _ := json.Marshal(doc)
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if hashOfSpec(t, s) != "09ff6e5490b40677" {
		t.Error("un campo desconocido no debe cambiar el hash")
	}
	if !strings.Contains(string(b), "backups") {
		t.Fatal("fixture mal construida")
	}
}

// Ausente (nil) no emite nada; presente y vacío sincroniza el fichero a vacío (revocar al
// último op o jugador debe llegar al servidor).
func TestEmptyOpsAndWhitelistSynchronize(t *testing.T) {
	s := loadFixture(t)
	env := buildEnv(t, s)
	for _, k := range []string{"OPS", "EXISTING_OPS_FILE", "WHITELIST", "EXISTING_WHITELIST_FILE", "ENABLE_WHITELIST"} {
		if _, ok := env[k]; ok {
			t.Errorf("sección ausente no debe emitir %s", k)
		}
	}
	s.Ops = []string{}
	s.Whitelist = &Whitelist{Enabled: true, Players: []string{}}
	env = buildEnv(t, s)
	for k, want := range map[string]string{
		"OPS": "", "EXISTING_OPS_FILE": "SYNCHRONIZE",
		"WHITELIST": "", "EXISTING_WHITELIST_FILE": "SYNCHRONIZE", "ENABLE_WHITELIST": "true",
	} {
		if v, ok := env[k]; !ok || v != want {
			t.Errorf("env[%s] = %q (presente=%v), want %q", k, v, ok, want)
		}
	}
}

// La distinción ausente/vacío sobrevive a Parse y a re-serializar.
func TestOpsAbsentVsEmptyJSON(t *testing.T) {
	base, _ := os.ReadFile(fixturePath("spec-example.json"))
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(base, &doc)
	doc["ops"] = json.RawMessage(`[]`)
	b, _ := json.Marshal(doc)
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if s.Ops == nil {
		t.Fatal(`"ops": [] debe parsear como presente (no nil)`)
	}
	out, _ := json.Marshal(s)
	if !strings.Contains(string(out), `"ops":[]`) {
		t.Errorf("re-serializar debe conservar ops vacío: %s", out)
	}
	s.Ops = nil
	out, _ = json.Marshal(s)
	if strings.Contains(string(out), `"ops"`) {
		t.Errorf("ops ausente no debe serializarse: %s", out)
	}
}

func TestPlayerListsDedupeCaseInsensitive(t *testing.T) {
	s := loadFixture(t)
	s.Ops = []string{"lobo", "Lobo", "Steve"}
	s.Whitelist = &Whitelist{Enabled: true, Players: []string{"steve", "Steve", "Lobo"}}
	env := buildEnv(t, s)
	if env["OPS"] != "Lobo,Steve" || env["WHITELIST"] != "Lobo,Steve" {
		t.Errorf("OPS=%q WHITELIST=%q", env["OPS"], env["WHITELIST"])
	}
	a, b := s, s
	a.Ops = []string{"Lobo"}
	b.Ops = []string{"lobo", "Lobo"}
	if hashOfSpec(t, a) != hashOfSpec(t, b) {
		t.Error("variantes de mayúsculas no deben recrear el contenedor")
	}
}

func TestModsAndPluginsShareModrinthProjects(t *testing.T) {
	s := loadFixture(t)
	s.Mods = &ModSources{ModrinthProjects: []string{"lithium", "sodium"}}
	s.Plugins = &PluginSources{ModrinthProjects: []string{"luckperms", "lithium"}}
	if got := buildEnv(t, s)["MODRINTH_PROJECTS"]; got != "lithium,luckperms,sodium" {
		t.Errorf("MODRINTH_PROJECTS = %q", got)
	}
}

// La API key de CurseForge llega del panel dentro de la spec: ASCII imprimible sin espacios,
// 1-200 caracteres. Una key con NUL o saltos de línea haría que Docker rechazara el env de
// todos los servidores CurseForge. El error no repite la key (acaba en observed.error).
func TestCurseForgeAPIKeyValidated(t *testing.T) {
	s := loadFixture(t)
	s.Mods = &ModSources{CurseforgeFiles: []string{"jei"}}
	for _, ok := range []string{"", "$2a$10$abc/DEF.ghi", strings.Repeat("k", 200), "!~"} {
		s.CurseForgeAPIKey = ok
		if err := s.Validate(); err != nil {
			t.Errorf("key %q debía aceptarse: %v", ok, err)
		}
	}
	for _, bad := range []string{"con espacio", "nul\x00", "salto\n", "tab\t", "del\x7f", "clé", strings.Repeat("k", 201)} {
		s.CurseForgeAPIKey = bad
		err := s.Validate()
		if err == nil {
			t.Errorf("key %q debía rechazarse", bad)
			continue
		}
		if strings.Contains(err.Error(), bad) {
			t.Errorf("el error no debe repetir la key: %v", err)
		}
	}
}

// Con la sección presente, el env libre no puede fijar lo que ella genera: como el env gana,
// revocar un op o un jugador de la whitelist no tendría efecto (auditoría M1).
func TestPlayersSectionsRejectOverridingEnv(t *testing.T) {
	s := loadFixture(t)
	s.Ops = []string{"Lobo"}
	s.Env = map[string]string{"OPS": "Lobo,Pepe"}
	err := s.Validate()
	want := "spec: Quita la variable OPS de las variables de entorno (Avanzado): los operadores se gestionan en la sección Jugadores"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	s = loadFixture(t)
	s.Whitelist = &Whitelist{Enabled: true}
	s.Env = map[string]string{"ENABLE_WHITELIST": "false"}
	err = s.Validate()
	want = "spec: Quita la variable ENABLE_WHITELIST de las variables de entorno (Avanzado): la whitelist se gestiona en la sección Jugadores"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

// level-name es la carpeta del mundo dentro de /data: sin separadores ni "..", para que ningún
// código que construya rutas del host con ella pueda salirse (auditoría L6).
func TestLevelNameIsAPlainFolder(t *testing.T) {
	s := loadFixture(t)
	s.Properties = map[string]string{"level-name": "../../etc"}
	want := "spec: La propiedad level-name es la carpeta del mundo: no puede contener «/», «\\» ni «..»"
	if err := s.Validate(); err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}
