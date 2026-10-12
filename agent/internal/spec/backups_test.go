package spec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidCronFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "proto", "fixtures", "cron-cases.json"))
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
	for _, e := range cases.Valid {
		if err := ValidCron(e); err != nil {
			t.Errorf("%q debería ser válida: %v", e, err)
		}
	}
	for _, e := range cases.Invalid {
		if err := ValidCron(e); err == nil {
			t.Errorf("%q debería ser inválida", e)
		}
	}
}

func TestBackupsValidate(t *testing.T) {
	ok := &Backups{Enabled: true, Cron: "0 4 * * *", KeepDays: 7, KeepCount: 10, Excludes: []string{"logs", "*.tmp", "world/session.lock"}, OnlyIfPlayersSince: true}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (*Backups)(nil).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (&Backups{}).Validate(); err != nil {
		t.Fatalf("desactivado y sin cron debe valer: %v", err)
	}
	bad := []Backups{
		{Enabled: true, Cron: ""},
		{Enabled: true, Cron: "0 4 * * MON"},
		{Cron: "0 4 * *"},
		{Cron: "0 4 * * *", KeepDays: -1},
		{Cron: "0 4 * * *", KeepCount: MaxBackupKeepCount + 1},
		{Cron: "0 4 * * *", Excludes: []string{"/etc"}},
		{Cron: "0 4 * * *", Excludes: []string{"../world"}},
		{Cron: "0 4 * * *", Excludes: []string{"[abc]"}},
		{Cron: "0 4 * * *", Excludes: []string{`a\b`}},
		{Cron: "0 4 * * *", Excludes: []string{""}},
	}
	for i, b := range bad {
		if err := b.Validate(); err == nil {
			t.Errorf("caso %d %+v debería fallar", i, b)
		}
	}
}

func TestSpecWithBackups(t *testing.T) {
	s := loadFixture(t)
	if s.Backups != nil {
		t.Fatal("la fixture no trae backups")
	}
	if got := strings.Join(s.BackupExcludes(), ","); got != "logs,cache,*.tmp" {
		t.Fatalf("exclusiones por defecto = %s", got)
	}
	before, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	s.Backups = &Backups{Enabled: true, Cron: "*/5 * * * *", KeepCount: 3, Excludes: []string{}}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(s.BackupExcludes()) != 0 {
		t.Fatal("una lista de exclusiones vacía explícita se respeta")
	}
	after, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if before.Hash != after.Hash {
		t.Fatal("cambiar la programación de copias no debe recrear el contenedor")
	}
	s.Backups.Cron = "0 4 * * SUN"
	if err := s.Validate(); err == nil || !strings.Contains(err.Error(), "backups.cron") {
		t.Fatalf("Validate debe validar backups: %v", err)
	}
	raw := []byte(`{"type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"rconPassword":"abcdefgh",
		"backups":{"enabled":true,"cron":"0 4 * * *","keepDays":7,"keepCount":10,"excludes":["logs"],"onlyIfPlayersSince":true}}`)
	p, err := Parse(raw)
	if err != nil || p.Backups == nil || !p.Backups.OnlyIfPlayersSince || p.Backups.KeepCount != 10 || p.Backups.Cron != "0 4 * * *" {
		t.Fatalf("parse = %+v, %v", p.Backups, err)
	}
}

func TestBackupsDoNotChangeHashGolden(t *testing.T) {
	s := loadFixture(t)
	s.Backups = &Backups{Enabled: true, Cron: "0 4 * * *", KeepDays: 7, KeepCount: 10, Excludes: []string{"logs"}, OnlyIfPlayersSince: true}
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	if b.Hash != "09ff6e5490b40677" {
		t.Fatalf("hash con backups = %s, debe seguir siendo el golden", b.Hash)
	}
}
