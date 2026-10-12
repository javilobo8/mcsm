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

// Topes de tamaño (auditoría L1), iguales a los de zod (spec-limits.ts): listas ≤ 1000
// elementos, cadenas ≤ 4 KiB (en bytes UTF-8) y env generado ≤ 96 KiB.
func TestLimitsLists(t *testing.T) {
	cases := map[string]func(s *Spec, n int){
		"ops":                     func(s *Spec, n int) { s.Ops = names(n) },
		"whitelist.players":       func(s *Spec, n int) { s.Whitelist = &Whitelist{Players: names(n)} },
		"mods.modrinthProjects":   func(s *Spec, n int) { s.Mods = &ModSources{ModrinthProjects: names(n)} },
		"mods.curseforgeFiles":    func(s *Spec, n int) { s.Mods = &ModSources{CurseforgeFiles: names(n)} },
		"plugins.spigetResources": func(s *Spec, n int) { s.Plugins = &PluginSources{SpigetResources: digits(n)} },
		"plugins.urls":            func(s *Spec, n int) { s.Plugins = &PluginSources{URLs: urls(n)} },
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
			t.Errorf("%s con 1000 elementos debía aceptarse: %v", name, err)
		}
		s = loadFixture(t)
		set(&s, 1001)
		if err := s.Validate(); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s con 1001 elementos: err = %v", name, err)
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
	multi := strings.Repeat("ñ", 2049) // 4098 bytes en UTF-8 (2049 caracteres)
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
			t.Errorf("%s de 4096 bytes debía aceptarse: %v", name, err)
		}
		for _, bad := range []string{long, multi} {
			s = loadFixture(t)
			set(&s, bad)
			if err := s.Validate(); err == nil || !strings.Contains(err.Error(), name) {
				t.Errorf("%s de %d bytes: err = %v", name, len(bad), err)
			}
		}
	}
	s := loadFixture(t)
	s.Env = map[string]string{strings.Repeat("K", 4097): "v"}
	if err := s.Validate(); err == nil {
		t.Error("un nombre de variable de más de 4 KiB debía rechazarse")
	}
}

func TestLimitsGeneratedEnv(t *testing.T) {
	s := loadFixture(t)
	s.Env = map[string]string{}
	for i := 0; i < 23; i++ { // 23 × ~4 KiB ≈ 92 KiB más lo generado: por debajo de 96 KiB
		s.Env[fmt.Sprintf("V%02d", i)] = strings.Repeat("x", 4090)
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("debía aceptarse: %v", err)
	}
	s.Env["V23"] = strings.Repeat("x", 4090)
	err := s.Validate()
	if err == nil || !strings.Contains(err.Error(), "96 KiB") {
		t.Fatalf("err = %v", err)
	}
	// Las secciones también cuentan: 1000 URLs de ~1000 bytes no caben en el env.
	s = loadFixture(t)
	big := make([]string, 120)
	for i := range big {
		big[i] = fmt.Sprintf("https://example.com/%04d/%s.jar", i, strings.Repeat("m", 960))
	}
	s.Mods = &ModSources{URLs: big}
	if err := s.Validate(); err == nil || !strings.Contains(err.Error(), "96 KiB") {
		t.Fatalf("mods enormes: err = %v", err)
	}
}
