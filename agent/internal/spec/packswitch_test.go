package spec

import "testing"

func TestPackCleanupPlatform(t *testing.T) {
	mr := func(slug string) *Modpack { return &Modpack{Platform: PlatformModrinth, SlugOrURL: slug} }
	cf := func(slug string) *Modpack { return &Modpack{Platform: PlatformAutoCurseForge, SlugOrURL: slug} }
	ftb := &Modpack{Platform: PlatformFTBA, SlugOrURL: "126"}
	cases := []struct {
		name     string
		old, new *Modpack
		want     string
	}{
		{"no pack before", nil, mr("a"), ""},
		{"no pack at all", nil, nil, ""},
		{"uninstall Modrinth", mr("a"), nil, PlatformModrinth},
		{"uninstall CurseForge", cf("a"), nil, PlatformAutoCurseForge},
		{"Modrinth → CurseForge", mr("a"), cf("b"), PlatformModrinth},
		{"CurseForge → Modrinth", cf("a"), mr("b"), PlatformAutoCurseForge},
		{"version change", &Modpack{Platform: PlatformModrinth, SlugOrURL: "a", VersionID: "x"}, &Modpack{Platform: PlatformModrinth, SlugOrURL: "a", VersionID: "y"}, ""},
		{"same-platform switch [F4]", mr("a"), mr("b"), ""},
		{"same-platform switch [F5]", cf("a"), cf("b"), ""},
		{"FTB is not handled", ftb, nil, ""},
		{"FTB → Modrinth", ftb, mr("a"), ""},
		{"Modrinth → FTB", mr("a"), ftb, PlatformModrinth},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := PackCleanupPlatform(c.old, c.new); got != c.want {
				t.Fatalf("PackCleanupPlatform = %q, want %q", got, c.want)
			}
		})
	}
}

func TestModpackOfIsLenient(t *testing.T) {
	if mp := ModpackOf([]byte(`{not json`)); mp != nil {
		t.Fatalf("invalid JSON: %+v", mp)
	}
	if mp := ModpackOf(nil); mp != nil {
		t.Fatalf("nil: %+v", mp)
	}
	if mp := ModpackOf([]byte(`{"type":"PAPER","version":"1.21.4"}`)); mp != nil {
		t.Fatalf("no modpack: %+v", mp)
	}
	// Otherwise invalid spec (no memory, no rconPassword, type mismatch): the modpack is still read.
	mp := ModpackOf([]byte(`{"type":"PAPER","modpack":{"platform":"MODRINTH","slugOrUrl":"a"}}`))
	if mp == nil || mp.Platform != PlatformModrinth || mp.SlugOrURL != "a" {
		t.Fatalf("modpack = %+v", mp)
	}
	if mp := ModpackOf([]byte(`{"modpack":"weird"}`)); mp != nil {
		t.Fatalf("a modpack of the wrong JSON type: %+v", mp)
	}
}
