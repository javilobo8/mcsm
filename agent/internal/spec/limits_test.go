package spec

import (
	"fmt"
	"strings"
	"testing"
)

func names(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("p%d", i)
	}
	return out
}

// Size caps (audit L1), equal to zod's (spec-limits.ts): lists ≤ 1000
// elements, strings ≤ 4 KiB (in UTF-8 bytes) and generated env ≤ 96 KiB.
func TestLimitsLists(t *testing.T) {
	cases := map[string]func(s *Spec, n int){
		"ops":                     func(s *Spec, n int) { s.Ops = names(n) },
		"whitelist.players":       func(s *Spec, n int) { s.Whitelist = &Whitelist{Players: names(n)} },
		"mods.modrinthProjects":   func(s *Spec, n int) { s.Mods = &ModSources{ModrinthProjects: names(n)} },
		"mods.curseforgeFiles":    func(s *Spec, n int) { s.Mods = &ModSources{CurseforgeFiles: names(n)} },
		"plugins.spigetResources": func(s *Spec, n int) { s.Plugins = &PluginSources{SpigetResources: digits(n)} },
		"plugins.urls":            func(s *Spec, n int) { s.Plugins = &PluginSources{URLs: urls(n)} },
		"plugins.curseforgeFiles": func(s *Spec, n int) { s.Plugins = &PluginSources{CurseforgeFiles: names(n)} },
		"datapacks.modrinthProjects": func(s *Spec, n int) {
			s.Datapacks = &DatapackSources{ModrinthProjects: names(n)}
		},
		"ports.extra": func(s *Spec, n int) {
			s.Ports.Extra = make([]PortMapping, n)
			for i := range s.Ports.Extra {
				s.Ports.Extra[i] = PortMapping{Host: 30000 + i, Container: 30000 + i, Proto: "tcp"}
			}
		},
	}
	for name, set := range cases {
		s := loadFixture(t)
		set(&s, 1000)
		if err := s.Validate(); err != nil {
			t.Errorf("%s with 1000 elements should have been accepted: %v", name, err)
		}
		s = loadFixture(t)
		set(&s, 1001)
		if err := s.Validate(); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s with 1001 elements: err = %v", name, err)
		}
	}
}

func digits(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprint(i + 1)
	}
	return out
}

func urls(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("https://example.com/%d.jar", i)
	}
	return out
}

func TestLimitsStrings(t *testing.T) {
	ok := strings.Repeat("a", 4096)
	long := strings.Repeat("a", 4097)
	multi := strings.Repeat("ñ", 2049) // 4098 bytes in UTF-8 (2049 characters)
	cases := map[string]func(s *Spec, v string){
		"env.X":               func(s *Spec, v string) { s.Env = map[string]string{"X": v} },
		"properties.motd":     func(s *Spec, v string) { s.Properties = map[string]string{"motd": v} },
		"version":             func(s *Spec, v string) { s.Version = v },
		"type":                func(s *Spec, v string) { s.Type = v },
		"ports.extra.0.label": func(s *Spec, v string) { s.Ports.Extra[0].Label = v },
	}
	for name, set := range cases {
		s := loadFixture(t)
		set(&s, ok)
		if err := s.Validate(); err != nil {
			t.Errorf("%s of 4096 bytes should have been accepted: %v", name, err)
		}
		for _, bad := range []string{long, multi} {
			s = loadFixture(t)
			set(&s, bad)
			if err := s.Validate(); err == nil || !strings.Contains(err.Error(), name) {
				t.Errorf("%s of %d bytes: err = %v", name, len(bad), err)
			}
		}
	}
	s := loadFixture(t)
	s.Env = map[string]string{strings.Repeat("K", 4097): "v"}
	if err := s.Validate(); err == nil {
		t.Error("a variable name over 4 KiB should have been rejected")
	}
}

func TestLimitsGeneratedEnv(t *testing.T) {
	s := loadFixture(t)
	s.Env = map[string]string{}
	for i := 0; i < 23; i++ { // 23 × ~4 KiB ≈ 92 KiB plus what is generated: below 96 KiB
		s.Env[fmt.Sprintf("V%02d", i)] = strings.Repeat("x", 4090)
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("should have been accepted: %v", err)
	}
	s.Env["V23"] = strings.Repeat("x", 4090)
	err := s.Validate()
	if err == nil || !strings.Contains(err.Error(), "96 KiB") {
		t.Fatalf("err = %v", err)
	}
	// Sections also count: 1000 URLs of ~1000 bytes do not fit in the env.
	s = loadFixture(t)
	big := make([]string, 120)
	for i := range big {
		big[i] = fmt.Sprintf("https://example.com/%04d/%s.jar", i, strings.Repeat("m", 960))
	}
	s.Mods = &ModSources{URLs: big}
	if err := s.Validate(); err == nil || !strings.Contains(err.Error(), "96 KiB") {
		t.Fatalf("huge mods: err = %v", err)
	}
}

func TestLimitsDatapacksMessage(t *testing.T) {
	s := loadFixture(t)
	s.Datapacks = &DatapackSources{ModrinthProjects: names(1001)}
	want := "the datapacks.modrinthProjects list has 1001 elements (max. 1000)"
	if err := s.Validate(); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want it to contain %q", err, want)
	}
}
