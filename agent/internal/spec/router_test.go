package spec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRouterHostnameFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "proto", "fixtures", "router-hostname-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases struct{ Valid, Invalid []string }
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Valid) == 0 || len(cases.Invalid) == 0 {
		t.Fatal("fixture vacía")
	}
	for _, h := range cases.Valid {
		if !ValidHostname(h) {
			t.Errorf("%q debería ser válido", h)
		}
	}
	for _, h := range cases.Invalid {
		if ValidHostname(h) {
			t.Errorf("%q debería ser inválido", h)
		}
	}
}

func TestRouterHostnameLengths(t *testing.T) {
	label63 := strings.Repeat("a", 63)
	if !ValidHostname(label63 + ".lan") {
		t.Error("una etiqueta de 63 caracteres es válida")
	}
	if ValidHostname(strings.Repeat("a", 64) + ".lan") {
		t.Error("una etiqueta de 64 caracteres no es válida")
	}
	// 4 etiquetas de 63 + 3 puntos = 255; recortada a 253 sigue siendo sintácticamente válida.
	long := strings.Join([]string{label63, label63, label63, label63}, ".")
	if ValidHostname(long) {
		t.Error("255 caracteres no es válido")
	}
	if !ValidHostname(long[:253]) {
		t.Error("253 caracteres es válido")
	}
	if ValidHostname(long[:254]) {
		t.Error("254 caracteres no es válido")
	}
}

func TestRouterValidate(t *testing.T) {
	cases := []struct {
		name string
		r    *Router
		ok   bool
	}{
		{"ausente", nil, true},
		{"desactivado sin hostname", &Router{}, true},
		{"desactivado con hostname", &Router{Hostname: "survival.lan"}, true},
		{"activado", &Router{Enabled: true, Hostname: "survival.lan"}, true},
		{"activado sin hostname", &Router{Enabled: true}, false},
		{"desactivado con hostname inválido", &Router{Hostname: "Survival.lan"}, false},
		{"activado con hostname inválido", &Router{Enabled: true, Hostname: "a_b.lan"}, false},
	}
	for _, c := range cases {
		s := loadFixture(t)
		s.Router = c.r
		if err := s.Validate(); (err == nil) != c.ok {
			t.Errorf("%s: err = %v, ok esperado %v", c.name, err, c.ok)
		}
	}
}

func TestRouterParse(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "proto", "fixtures", "spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	m["router"] = map[string]any{"enabled": true, "hostname": "survival.lan"}
	b, _ := json.Marshal(m)
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Router.Active() || s.Router.Hostname != "survival.lan" {
		t.Fatalf("router = %+v", s.Router)
	}
	m["router"] = map[string]any{"enabled": true, "hostname": ""}
	b, _ = json.Marshal(m)
	if _, err := Parse(b); err == nil {
		t.Fatal("router activado sin hostname debe fallar")
	}
}

func TestRouterLabelsAndHash(t *testing.T) {
	build := func(r *Router) *Build {
		t.Helper()
		s := loadFixture(t)
		s.Router = r
		b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, r := range []*Router{nil, {}, {Hostname: "survival.lan"}} {
		b := build(r)
		if b.Hash != "09ff6e5490b40677" {
			t.Errorf("router %+v: hash = %s, debe seguir siendo el golden", r, b.Hash)
		}
		if _, ok := b.Config.Labels[LabelRouterHost]; ok {
			t.Errorf("router %+v: no debe llevar %s", r, LabelRouterHost)
		}
	}
	on := build(&Router{Enabled: true, Hostname: "survival.lan"})
	if on.Config.Labels[LabelRouterHost] != "survival.lan" || on.Config.Labels[LabelRouterNetwork] != "mcsm" {
		t.Fatalf("etiquetas = %v", on.Config.Labels)
	}
	if on.Hash == "09ff6e5490b40677" {
		t.Fatal("activar el router debe cambiar el hash (recrea con las etiquetas)")
	}
	other := build(&Router{Enabled: true, Hostname: "creativo.lan"})
	if other.Hash == on.Hash {
		t.Fatal("cambiar el hostname debe cambiar el hash")
	}
	// El servidor sigue publicando su propio puerto: el router no lo sustituye.
	if len(on.HostConfig.PortBindings) != len(build(nil).HostConfig.PortBindings) {
		t.Fatal("el router no cambia los puertos publicados")
	}
}
