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

// Cases shared with panel/packages/shared/src/spec-content.test.ts: Go and zod must
// accept and reject exactly the same.
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
		t.Fatalf("only %d cases: truncated fixture?", len(cases))
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
				t.Fatalf("should have been accepted: %v", err)
			}
			if !c.OK && err == nil {
				t.Fatal("should have been rejected")
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
			t.Errorf("%s (= %q) should not have been emitted", k, env[k])
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
		t.Errorf("CF_API_KEY = %q (the $ are not escaped: the Docker API does not interpolate)", env["CF_API_KEY"])
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
		t.Error("with the whitelist disabled WHITELIST is not emitted (itzg would enable it)")
	}
	if _, ok := env["CF_API_KEY"]; ok {
		t.Error("without an API key in the spec CF_API_KEY is not emitted")
	}
}

func TestEnvLibreGanaSobreLoGenerado(t *testing.T) {
	s := loadModded(t)
	s.Env = map[string]string{"EXISTING_WHITELIST_FILE": "MERGE"}
	if env := buildEnv(t, s); env["EXISTING_WHITELIST_FILE"] != "MERGE" {
		t.Errorf("free-form env must win: %q", env["EXISTING_WHITELIST_FILE"])
	}
}

// The hash only changes when the container changes.
func TestContentHash(t *testing.T) {
	base := loadFixture(t)
	h0 := hashOfSpec(t, base)
	// Value computed with Plan 1's code for spec-example.json: if it changes, updating the
	// agent would recreate ALL the existing containers. It can only
	// change if the github.com/moby/moby/api version is updated.
	if h0 != "09ff6e5490b40677" {
		t.Fatalf("the hash of a spec without new fields changed: %s", h0)
	}

	noOps := base
	noOps.Ops = []string{}
	if hashOfSpec(t, noOps) == h0 {
		t.Error("ops present and empty must change the hash (it synchronizes the file)")
	}
	absentOps := base
	absentOps.Ops = nil
	if hashOfSpec(t, absentOps) != h0 {
		t.Error("absent ops must not change the hash")
	}

	withKey := base
	withKey.CurseForgeAPIKey = "k"
	if hashOfSpec(t, withKey) != h0 {
		t.Error("the CurseForge API key must not affect servers that do not use CurseForge")
	}

	a := base
	a.Mods = &ModSources{ModrinthProjects: []string{"lithium", "sodium"}}
	b := base
	b.Mods = &ModSources{ModrinthProjects: []string{"sodium", "lithium", "lithium"}}
	if hashOfSpec(t, a) != hashOfSpec(t, b) {
		t.Error("reordering or duplicating mods must not recreate the container")
	}
	if hashOfSpec(t, a) == h0 {
		t.Error("adding mods must change the hash")
	}

	cf := base
	cf.Mods = &ModSources{CurseforgeFiles: []string{"jei"}}
	cf1, cf2 := cf, cf
	cf1.CurseForgeAPIKey = "one"
	cf2.CurseForgeAPIKey = "two"
	if hashOfSpec(t, cf1) == hashOfSpec(t, cf2) {
		t.Error("changing the API key must recreate the servers that use CurseForge")
	}
}

// Removing the last mod must reach itzg as an empty MODRINTH_PROJECTS (it deletes what is installed);
// without the section, the variable does not exist and itzg touches nothing.
func TestEmptyModsSectionClearsModrinthProjects(t *testing.T) {
	s := loadFixture(t)
	if _, ok := buildEnv(t, s)["MODRINTH_PROJECTS"]; ok {
		t.Fatal("without a mods/plugins section MODRINTH_PROJECTS must not exist")
	}
	s.Mods = &ModSources{}
	env := buildEnv(t, s)
	if v, ok := env["MODRINTH_PROJECTS"]; !ok || v != "" {
		t.Errorf("MODRINTH_PROJECTS = %q (present=%v), want empty and present", v, ok)
	}
	for _, k := range []string{"MODS", "CURSEFORGE_FILES"} {
		if _, ok := env[k]; ok {
			t.Errorf("an empty %s must not be emitted", k)
		}
	}
}

func TestParseIgnoresUnknownFields(t *testing.T) {
	// Fields from other plans (e.g. backups) must not break this plan's agent.
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
		t.Error("an unknown field must not change the hash")
	}
	if !strings.Contains(string(b), "backups") {
		t.Fatal("badly built fixture")
	}
}

// Absent (nil) emits nothing; present and empty synchronizes the file to empty (revoking the
// last op or player must reach the server).
func TestEmptyOpsAndWhitelistSynchronize(t *testing.T) {
	s := loadFixture(t)
	env := buildEnv(t, s)
	for _, k := range []string{"OPS", "EXISTING_OPS_FILE", "WHITELIST", "EXISTING_WHITELIST_FILE", "ENABLE_WHITELIST"} {
		if _, ok := env[k]; ok {
			t.Errorf("an absent section must not emit %s", k)
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
			t.Errorf("env[%s] = %q (present=%v), want %q", k, v, ok, want)
		}
	}
}

// The absent/empty distinction survives Parse and re-serialization.
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
		t.Fatal(`"ops": [] must parse as present (not nil)`)
	}
	out, _ := json.Marshal(s)
	if !strings.Contains(string(out), `"ops":[]`) {
		t.Errorf("re-serializing must keep ops empty: %s", out)
	}
	s.Ops = nil
	out, _ = json.Marshal(s)
	if strings.Contains(string(out), `"ops"`) {
		t.Errorf("absent ops must not be serialized: %s", out)
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
		t.Error("case variants must not recreate the container")
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

// The CurseForge API key comes from the panel inside the spec: printable ASCII without spaces,
// 1-200 characters. A key with NUL or line breaks would make Docker reject the env of
// all CurseForge servers. The error does not repeat the key (it ends up in observed.error).
func TestCurseForgeAPIKeyValidated(t *testing.T) {
	s := loadFixture(t)
	s.Mods = &ModSources{CurseforgeFiles: []string{"jei"}}
	for _, ok := range []string{"", "$2a$10$abc/DEF.ghi", strings.Repeat("k", 200), "!~"} {
		s.CurseForgeAPIKey = ok
		if err := s.Validate(); err != nil {
			t.Errorf("key %q should have been accepted: %v", ok, err)
		}
	}
	for _, bad := range []string{"with space", "nul\x00", "newline\n", "tab\t", "del\x7f", "clé", strings.Repeat("k", 201)} {
		s.CurseForgeAPIKey = bad
		err := s.Validate()
		if err == nil {
			t.Errorf("key %q should have been rejected", bad)
			continue
		}
		if strings.Contains(err.Error(), bad) {
			t.Errorf("the error must not repeat the key: %v", err)
		}
	}
}

// With the section present, the free-form env cannot set what it generates: since env wins,
// revoking an op or a whitelist player would have no effect (audit M1).
func TestPlayersSectionsRejectOverridingEnv(t *testing.T) {
	s := loadFixture(t)
	s.Ops = []string{"Lobo"}
	s.Env = map[string]string{"OPS": "Lobo,Pepe"}
	err := s.Validate()
	want := "spec: Remove the variable OPS from the environment variables (Advanced): operators are managed in the Players section"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	s = loadFixture(t)
	s.Whitelist = &Whitelist{Enabled: true}
	s.Env = map[string]string{"ENABLE_WHITELIST": "false"}
	err = s.Validate()
	want = "spec: Remove the variable ENABLE_WHITELIST from the environment variables (Advanced): the whitelist is managed in the Players section"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

// level-name is the world folder inside /data: no separators or "..", so that no
// code that builds host paths with it can escape (audit L6).
func TestLevelNameIsAPlainFolder(t *testing.T) {
	s := loadFixture(t)
	s.Properties = map[string]string{"level-name": "../../etc"}
	want := "spec: The level-name property is the world folder: it cannot contain “/”, “\\” or “..”"
	if err := s.Validate(); err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}
