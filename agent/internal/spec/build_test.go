package spec

import (
	"encoding/json"
	"os"
	"testing"
)

func TestBuildCasesSharedWithZod(t *testing.T) {
	raw, err := os.ReadFile(fixturePath("build-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string            `json:"name"`
		Type    string            `json:"type"`
		Version string            `json:"version"`
		Build   string            `json:"build"`
		Env     map[string]string `json:"env"`
		OK      bool              `json:"ok"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 20 {
		t.Fatalf("only %d cases: truncated fixture?", len(cases))
	}
	for _, c := range cases {
		s := loadFixture(t)
		s.Type, s.Version, s.Build = c.Type, c.Version, c.Build
		if c.Env != nil {
			s.Env = c.Env
		}
		if err := s.Validate(); (err == nil) != c.OK {
			t.Errorf("%s: Validate() = %v; expected ok %v", c.Name, err, c.OK)
		}
	}
}

func TestBuildEnvPorTipo(t *testing.T) {
	want := map[string]string{
		"PAPER": "PAPER_BUILD", "FOLIA": "FOLIABUILD", "PURPUR": "PURPUR_BUILD",
		"FABRIC": "FABRIC_LOADER_VERSION", "QUILT": "QUILT_LOADER_VERSION",
		"FORGE": "FORGE_VERSION", "NEOFORGE": "NEOFORGE_VERSION",
	}
	if len(buildEnvKeys) != len(want) {
		t.Fatalf("buildEnvKeys = %v", buildEnvKeys)
	}
	for typ, key := range want {
		s := loadFixture(t)
		s.Type, s.Build = typ, "42"
		env := buildEnv(t, s)
		if env[key] != "42" {
			t.Errorf("%s: %s = %q, want 42", typ, key, env[key])
		}
		for _, other := range buildEnvKeys {
			if _, ok := env[other]; ok && other != key {
				t.Errorf("%s: must not emit %s", typ, other)
			}
		}
	}
}

// Without build nothing is emitted: no container is recreated when updating the agent.
func TestBuildVacioNoCambiaElHash(t *testing.T) {
	s := loadFixture(t)
	if s.Build != "" {
		t.Fatal("the fixture must not carry build")
	}
	if h := hashOfSpec(t, s); h != "09ff6e5490b40677" {
		t.Fatalf("the hash of a spec without build changed: %s", h)
	}
	env := buildEnv(t, s)
	for _, k := range buildEnvKeys {
		if _, ok := env[k]; ok {
			t.Errorf("without build %s is not emitted", k)
		}
	}
	s.Build = "178"
	if hashOfSpec(t, s) == "09ff6e5490b40677" {
		t.Error("a pinned build changes the environment and must change the hash")
	}
}

// A panel without the field (or an old agent) does not break the JSON.
func TestBuildAusenteEnElJSON(t *testing.T) {
	s, err := Parse([]byte(`{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"4G","ports":{"game":25565,"extra":[]},"restartPolicy":"unless-stopped","rconPassword":"s3cretpassw0rd"}`))
	if err != nil || s.Build != "" {
		t.Fatalf("Parse without build: %v, %q", err, s.Build)
	}
	b, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["build"]; ok {
		t.Error("an empty build is not serialized (omitempty)")
	}
}
