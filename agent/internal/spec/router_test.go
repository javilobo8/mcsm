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
		t.Fatal("empty fixture")
	}
	for _, h := range cases.Valid {
		if !ValidHostname(h) {
			t.Errorf("%q should be valid", h)
		}
	}
	for _, h := range cases.Invalid {
		if ValidHostname(h) {
			t.Errorf("%q should be invalid", h)
		}
	}
}

func TestRouterHostnameLengths(t *testing.T) {
	label63 := strings.Repeat("a", 63)
	if !ValidHostname(label63 + ".lan") {
		t.Error("a 63-character label is valid")
	}
	if ValidHostname(strings.Repeat("a", 64) + ".lan") {
		t.Error("a 64-character label is not valid")
	}
	// 4 labels of 63 + 3 dots = 255; trimmed to 253 it is still syntactically valid.
	long := strings.Join([]string{label63, label63, label63, label63}, ".")
	if ValidHostname(long) {
		t.Error("255 characters is not valid")
	}
	if !ValidHostname(long[:253]) {
		t.Error("253 characters is valid")
	}
	if ValidHostname(long[:254]) {
		t.Error("254 characters is not valid")
	}
}

func TestRouterValidate(t *testing.T) {
	cases := []struct {
		name string
		r    *Router
		ok   bool
	}{
		{"absent", nil, true},
		{"disabled without hostname", &Router{}, true},
		{"disabled with hostname", &Router{Hostname: "survival.lan"}, true},
		{"enabled", &Router{Enabled: true, Hostname: "survival.lan"}, true},
		{"enabled without hostname", &Router{Enabled: true}, false},
		{"disabled with invalid hostname", &Router{Hostname: "Survival.lan"}, false},
		{"enabled with invalid hostname", &Router{Enabled: true, Hostname: "a_b.lan"}, false},
	}
	for _, c := range cases {
		s := loadFixture(t)
		s.Router = c.r
		if err := s.Validate(); (err == nil) != c.ok {
			t.Errorf("%s: err = %v, expected ok %v", c.name, err, c.ok)
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
		t.Fatal("router enabled without hostname must fail")
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
			t.Errorf("router %+v: hash = %s, it must remain the golden", r, b.Hash)
		}
		if _, ok := b.Config.Labels[LabelRouterHost]; ok {
			t.Errorf("router %+v: must not carry %s", r, LabelRouterHost)
		}
	}
	on := build(&Router{Enabled: true, Hostname: "survival.lan"})
	if on.Config.Labels[LabelRouterHost] != "survival.lan" || on.Config.Labels[LabelRouterNetwork] != "mcsm" {
		t.Fatalf("labels = %v", on.Config.Labels)
	}
	if on.Hash == "09ff6e5490b40677" {
		t.Fatal("enabling the router must change the hash (it recreates with the labels)")
	}
	other := build(&Router{Enabled: true, Hostname: "creative.lan"})
	if other.Hash == on.Hash {
		t.Fatal("changing the hostname must change the hash")
	}
	// The server keeps publishing its own port: the router does not replace it.
	if len(on.HostConfig.PortBindings) != len(build(nil).HostConfig.PortBindings) {
		t.Fatal("the router does not change the published ports")
	}
}
