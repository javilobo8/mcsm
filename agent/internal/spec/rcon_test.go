package spec

import (
	"encoding/json"
	"os"
	"testing"
)

func TestRconPortCasesSharedWithZod(t *testing.T) {
	raw, err := os.ReadFile(fixturePath("rcon-port-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string `json:"name"`
		Ports struct {
			Game  int           `json:"game"`
			Extra []PortMapping `json:"extra"`
			// *int tells an explicit 0 from an absent key.
			Rcon *int `json:"rcon"`
		} `json:"ports"`
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 11 {
		t.Fatalf("only %d cases: truncated fixture?", len(cases))
	}
	for _, c := range cases {
		s := loadFixture(t)
		s.Ports.Game, s.Ports.Extra = c.Ports.Game, c.Ports.Extra
		s.Ports.Rcon = 0
		if c.Ports.Rcon != nil {
			s.Ports.Rcon = *c.Ports.Rcon
		}
		want := c.OK
		if c.Ports.Rcon != nil && *c.Ports.Rcon == 0 {
			// The panel rejects an explicit 0 on input; the agent's int with omitempty
			// cannot tell it from "absent", so for it 0 means "not published" and is valid.
			want = true
		}
		if err := s.Validate(); (err == nil) != want {
			t.Errorf("%s: Validate() = %v; expected ok %v", c.Name, err, want)
		}
	}
}

func TestRconNegativeRejected(t *testing.T) {
	s := loadFixture(t)
	s.Ports.Rcon = -1
	if err := s.Validate(); err == nil {
		t.Fatal("negative rcon port accepted")
	}
}

func TestBuildContainerPublishesRconOnlyWhenAsked(t *testing.T) {
	s := loadFixture(t)
	without, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	rcon := mustPort("25575/tcp")
	if _, ok := without.HostConfig.PortBindings[rcon]; ok {
		t.Fatal("RCON published without ports.rcon")
	}
	s.Ports.Rcon = 25999
	with, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	b := with.HostConfig.PortBindings[rcon]
	if len(b) != 1 || b[0].HostPort != "25999" {
		t.Fatalf("rcon binding = %v", b)
	}
	if _, ok := with.Config.ExposedPorts[rcon]; !ok {
		t.Error("25575/tcp not exposed")
	}
	if with.Hash == without.Hash {
		t.Error("hash does not change when publishing RCON")
	}
	if len(with.HostConfig.PortBindings) != len(without.HostConfig.PortBindings)+1 {
		t.Error("other bindings changed")
	}
}
