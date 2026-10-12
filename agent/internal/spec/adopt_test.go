package spec

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDataPathCasesSharedWithZod(t *testing.T) {
	raw, err := os.ReadFile(fixturePath("data-path-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Path string `json:"path"`
		OK   bool   `json:"ok"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("solo %d casos: ¿fixture truncada?", len(cases))
	}
	for _, c := range cases {
		if err := ValidateDataPath(c.Path); (err == nil) != c.OK {
			t.Errorf("ValidateDataPath(%q) = %v; ok esperado %v", c.Path, err, c.OK)
		}
	}
}

func TestDataPathLength(t *testing.T) {
	ok := "/srv/" + strings.Repeat("a", MaxDataPath-len("/srv/"))
	if err := ValidateDataPath(ok); err != nil {
		t.Fatalf("%d bytes debería valer: %v", len(ok), err)
	}
	if err := ValidateDataPath(ok + "a"); err == nil {
		t.Fatal("más de MaxDataPath bytes debe fallar")
	}
}

func TestBuildContainerUsesDataPath(t *testing.T) {
	base, err := BuildContainer(meta, loadFixture(t), "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	s := loadFixture(t)
	s.DataPath = "/home/lobo/minecraft/survival/data"
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if b.DataDir != s.DataPath || len(b.HostConfig.Binds) != 1 || b.HostConfig.Binds[0] != s.DataPath+":/data" {
		t.Fatalf("dataDir = %q, binds = %v", b.DataDir, b.HostConfig.Binds)
	}
	if b.Name != "mcsm-survival" {
		t.Fatalf("name = %q", b.Name)
	}
	if b.Hash == base.Hash {
		t.Fatal("otra carpeta de datos es otro contenedor: el hash debe cambiar")
	}
}

func TestDataPathCannotOverlapDataRoot(t *testing.T) {
	for _, tc := range []struct{ dataPath, root string }{
		{"/srv/minecraft/survival/data", "/srv/minecraft"},
		{"/srv/minecraft/otro", "/srv/minecraft"},
		{"/srv/minecraft", "/srv/minecraft"},
		{"/srv/data", "/srv/data/minecraft"},
	} {
		s := loadFixture(t)
		s.DataPath = tc.dataPath
		if _, err := BuildContainer(meta, s, tc.root, "mcsm"); err == nil || !strings.Contains(err.Error(), "DATA_ROOT") {
			t.Errorf("dataPath %q con DATA_ROOT %q: err = %v", tc.dataPath, tc.root, err)
		}
	}
	s := loadFixture(t)
	s.DataPath = "/srv/minecraft-viejo/survival" // comparte texto con DATA_ROOT, no ruta
	if _, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm"); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyDataPathAndAdoptKeepGoldenHash(t *testing.T) {
	raw, err := os.ReadFile(fixturePath("spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["dataPath"] = json.RawMessage(`""`)
	doc["adopt"] = json.RawMessage(`{"containerId":"` + strings.Repeat("ab", 32) + `","version":1}`)
	b, _ := json.Marshal(doc)
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	build, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if build.Hash != "09ff6e5490b40677" {
		t.Fatalf("hash = %s: dataPath vacío y adopt no pueden cambiar el contenedor", build.Hash)
	}
	for _, e := range build.Config.Env {
		if strings.Contains(strings.ToLower(e), "adopt") {
			t.Errorf("adopt no va al env: %q", e)
		}
	}
}

func TestDataPathWithScheduledBackupsIsInvalid(t *testing.T) {
	s := loadFixture(t)
	s.DataPath = "/home/lobo/minecraft/survival"
	s.Backups = &Backups{Enabled: true, Cron: "0 4 * * *", KeepDays: 7, KeepCount: 10}
	if err := s.Validate(); err == nil || !strings.Contains(err.Error(), "dataPath") {
		t.Fatalf("copias programadas con dataPath: err = %v", err)
	}
	s.Backups.Enabled = false
	if err := s.Validate(); err != nil {
		t.Fatalf("sin programar sí vale: %v", err)
	}
}

func TestAdoptValidation(t *testing.T) {
	for _, tc := range []struct {
		adopt Adopt
		ok    bool
	}{
		{Adopt{ContainerID: strings.Repeat("0f", 32), Version: 1}, true},
		// Solo ids completos: Docker resolvería un nombre o un prefijo a otro contenedor.
		{Adopt{ContainerID: "fake0001", Version: 3}, false},
		{Adopt{ContainerID: "mc-viejo", Version: 1}, false},
		{Adopt{ContainerID: strings.Repeat("0f", 6), Version: 1}, false},
		{Adopt{ContainerID: strings.Repeat("0F", 32), Version: 1}, false},
		{Adopt{ContainerID: "", Version: 1}, false},
		{Adopt{ContainerID: "../containers/x", Version: 1}, false},
		{Adopt{ContainerID: strings.Repeat("a", 65), Version: 1}, false},
		{Adopt{ContainerID: "abc", Version: 0}, false},
	} {
		s := loadFixture(t)
		a := tc.adopt
		s.Adopt = &a
		if err := s.Validate(); (err == nil) != tc.ok {
			t.Errorf("adopt %+v: err = %v", tc.adopt, err)
		}
	}
}

func TestIsItzgImage(t *testing.T) {
	for ref, want := range map[string]bool{
		"itzg/minecraft-server":                                   true,
		"itzg/minecraft-server:java21":                            true,
		"docker.io/itzg/minecraft-server:latest":                  true,
		"itzg/minecraft-server@sha256:" + strings.Repeat("a", 64): true,
		"itzg/minecraft-server-extra":                             false,
		"itzg/minecraft-bedrock-server":                           false,
		"ghcr.io/itzg/minecraft-server":                           false,
		"alpine:3.22":                                             false,
		"":                                                        false,
	} {
		if got := IsItzgImage(ref); got != want {
			t.Errorf("IsItzgImage(%q) = %v", ref, got)
		}
	}
}
