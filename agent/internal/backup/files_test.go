package backup

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestFilenameAndParse(t *testing.T) {
	at := time.Date(2026, 10, 12, 4, 0, 0, 123e6, time.FixedZone("CEST", 2*3600))
	name := Filename("survival", at, 7)
	if name != "survival-20261012T020000.123Z-7.tar.zst" {
		t.Fatalf("name = %s", name)
	}
	if !ValidName("survival", name) {
		t.Fatal("el nombre generado debe ser válido")
	}
	ts, v, ok := parseName("survival", name)
	if !ok || !ts.Equal(at) || v != 7 {
		t.Fatalf("parse = %v %d %v", ts, v, ok)
	}
}

func TestValidName(t *testing.T) {
	cases := map[string]bool{
		"survival-20261012T020000.123Z-7.tar.zst":           true,
		"survival-20261012T020000.123Z-7.tar.zst.json":      false,
		"survival-20261012T020000.123Z-7.tar.zst.partial":   false,
		"otro-20261012T020000.123Z-7.tar.zst":               false,
		"survival-x-20261012T020000.123Z-7.tar.zst":         false,
		"../survival-20261012T020000.123Z-7.tar.zst":        false,
		"survival-20261012T020000.123Z-7.tar.zst/../../etc": false,
		"survival-20261012T020000Z-7.tar.zst":               false,
	}
	for name, want := range cases {
		if got := ValidName("survival", name); got != want {
			t.Errorf("ValidName(%q) = %v", name, got)
		}
	}
	if ValidName("../x", "../x-20261012T020000.123Z-7.tar.zst") {
		t.Fatal("un slug inválido nunca da nombres válidos")
	}
}

func TestPreRestoreName(t *testing.T) {
	dataDir := "/srv/minecraft/survival/data"
	name := PreRestoreName(dataDir, time.Date(2026, 10, 12, 5, 0, 0, 0, time.UTC))
	if name != "data.pre-restore-20261012T050000.000Z" || !ValidPreRestoreName(dataDir, name) {
		t.Fatalf("name = %s", name)
	}
	for _, bad := range []string{"data", "data.pre-restore-", "data.pre-restore-../x", "backups", "data.restoring-20261012T050000.000Z"} {
		if ValidPreRestoreName(dataDir, bad) {
			t.Errorf("%q no debe ser válido", bad)
		}
	}
}

func TestListAndMeta(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "survival", "backups")
	t1 := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Hour)
	a := Filename("survival", t1, 3)
	b := Filename("survival", t2, 4)
	mustWrite(t, filepath.Join(dir, a), "AAAA", 0o640)
	if err := WriteMeta(dir, Meta{Filename: a, ServerID: "s1", Slug: "survival", SpecVersion: 3, Trigger: TriggerScheduled, SHA256: "abc", StartedAt: t1, FinishedAt: t1}); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, b), "BBBBBB", 0o640) // sin .json
	mustWrite(t, filepath.Join(dir, Filename("survival", t2.Add(time.Hour), 5)+".partial"), "x", 0o640)
	mustWrite(t, filepath.Join(dir, Filename("otro", t2, 1)), "x", 0o640)
	list, err := List(dir, "survival")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Filename != b || list[1].Filename != a {
		t.Fatalf("list = %+v", list)
	}
	if list[0].SizeBytes != 6 || list[0].SpecVersion != 4 || list[0].Trigger != TriggerManual || !list[0].StartedAt.Equal(t2) {
		t.Fatalf("deducida del nombre = %+v", list[0])
	}
	if list[1].SHA256 != "abc" || list[1].Trigger != TriggerScheduled || list[1].SizeBytes != 4 {
		t.Fatalf("con .json = %+v", list[1])
	}
	if got, err := List(filepath.Join(root, "nada"), "survival"); err != nil || got != nil {
		t.Fatalf("directorio inexistente = %v, %v", got, err)
	}
	info := list[1].Info("s1")
	if info.ServerId != "s1" || info.Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_SCHEDULED || info.SizeBytes != 4 || info.StartedUnixMs != t1.UnixMilli() {
		t.Fatalf("info = %+v", info)
	}
}

func TestListPreRestoreAndDelete(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "survival", "data")
	backupsDir := filepath.Join(root, "survival", "backups")
	mustWrite(t, filepath.Join(dataDir, "level.dat"), "actual", 0o644)
	pre := PreRestoreName(dataDir, time.Date(2026, 10, 12, 5, 0, 0, 0, time.UTC))
	mustWrite(t, filepath.Join(root, "survival", pre, "level.dat"), "antes", 0o644)
	if err := writeJSON(filepath.Join(root, "survival", pre+MetaExt), Meta{SizeBytes: 5}); err != nil {
		t.Fatal(err)
	}
	list, err := ListPreRestore(dataDir)
	if err != nil || len(list) != 1 || list[0].Filename != pre || list[0].Trigger != TriggerPreRestore || list[0].SizeBytes != 5 {
		t.Fatalf("pre-restore = %+v, %v", list, err)
	}
	name := Filename("survival", time.Now(), 1)
	mustWrite(t, filepath.Join(backupsDir, name), "x", 0o640)
	mustWrite(t, filepath.Join(backupsDir, name+MetaExt), "{}", 0o640)

	for _, bad := range []string{"data", "../data", "backups", "data.pre-restore-x", name + "/.."} {
		if err := Delete(backupsDir, dataDir, "survival", bad); err == nil {
			t.Errorf("Delete(%q) debe fallar", bad)
		}
	}
	if !exists(dataDir) || !exists(backupsDir) {
		t.Fatal("un nombre inválido no debe borrar nada")
	}
	if err := Delete(backupsDir, dataDir, "survival", name); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(backupsDir, name)) || exists(filepath.Join(backupsDir, name+MetaExt)) {
		t.Fatal("la copia y su .json deben borrarse")
	}
	if err := Delete(backupsDir, dataDir, "survival", name); err != nil {
		t.Fatalf("borrar dos veces es idempotente: %v", err)
	}
	if err := Delete(backupsDir, dataDir, "survival", pre); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(root, "survival", pre)) || exists(filepath.Join(root, "survival", pre+MetaExt)) || !exists(filepath.Join(dataDir, "level.dat")) {
		t.Fatal("solo debe borrarse el directorio pre-restore")
	}
	_ = os.RemoveAll(root)
}

func TestPrunePlan(t *testing.T) {
	now := time.Date(2026, 10, 20, 4, 0, 0, 0, time.UTC)
	m := func(name, trigger string, daysAgo int) Meta {
		return Meta{Filename: name, Trigger: trigger, StartedAt: now.Add(-time.Duration(daysAgo) * 24 * time.Hour)}
	}
	metas := []Meta{
		m("s0", TriggerScheduled, 0), m("s1", TriggerScheduled, 1), m("s2", TriggerScheduled, 2),
		m("s9", TriggerScheduled, 9), m("manual-old", TriggerManual, 30), m("pre", TriggerPreRestore, 30),
	}
	cases := []struct {
		days, count int
		want        []string
	}{
		{0, 0, nil},
		{0, 2, []string{"s2", "s9"}},
		{7, 0, []string{"s9"}},
		{7, 3, []string{"s9"}},
		{1, 10, []string{"s2", "s9"}},
	}
	for _, c := range cases {
		if got := PrunePlan(metas, c.days, c.count, now); !reflect.DeepEqual(got, c.want) {
			t.Errorf("keepDays=%d keepCount=%d: %v, want %v", c.days, c.count, got, c.want)
		}
	}
	old := []Meta{m("a", TriggerScheduled, 40), m("b", TriggerScheduled, 50)}
	if got := PrunePlan(old, 7, 0, now); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("la más reciente nunca se borra: %v", got)
	}
}

func TestTriggerConversion(t *testing.T) {
	for _, tr := range []string{TriggerManual, TriggerScheduled, TriggerPreMigration, TriggerPreRestore} {
		if TriggerFromProto(TriggerToProto(tr)) != tr {
			t.Errorf("ida y vuelta de %s", tr)
		}
	}
	if TriggerFromProto(mcsmv1.BackupTrigger_BACKUP_TRIGGER_UNSPECIFIED) != TriggerManual {
		t.Fatal("UNSPECIFIED cuenta como manual")
	}
}
