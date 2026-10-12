package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Sin espacio para la copia, Create falla ANTES de save-off (el servidor ni se entera) y
// dice cuánto falta. Primera copia: la estimación es lo que ocupan los datos sin comprimir.
func TestCreateRefusesWithoutSpaceBeforeSaveOff(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	data := int64(len("motd=hola\n") + len("LEVEL-1")) // logs está excluido
	need := requiredSpace(data)
	stubFreeSpace(t, func(string) (uint64, error) { return need - 1, nil })
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "faltan 1 B") {
		t.Fatalf("err = %v", err)
	}
	if len(rc.cmds) != 0 {
		t.Fatalf("sin espacio no se toca el servidor: %v", rc.cmds)
	}
	assertNoArchives(t, backupsDir)

	stubFreeSpace(t, func(string) (uint64, error) { return need, nil })
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatalf("con el espacio justo: %v", err)
	}
}

// Con copias previas, la estimación es la última copia ×1,2 (no los datos sin comprimir).
func TestCreateEstimatesFromLastBackup(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	last := makeBackup(t, dataDir, backupsDir)
	need := requiredSpace(last.SizeBytes + last.SizeBytes/5)
	req := baseReq(dataDir, backupsDir)
	req.Now = func() time.Time { return t0.Add(time.Minute) }
	stubFreeSpace(t, func(string) (uint64, error) { return need - 1, nil })
	if _, err := Create(context.Background(), req); !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "la última copia") {
		t.Fatalf("err = %v", err)
	}
	stubFreeSpace(t, func(string) (uint64, error) { return need, nil })
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatal(err)
	}
}

// Si durante el tar el espacio libre baja del margen (otra copia u otro servidor llenan el
// disco), la copia se cancela sin dejar .partial y save-on sale igual.
func TestCreateAbortsWhenSpaceRunsOut(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	var mu sync.Mutex
	calls := 0
	stubFreeSpace(t, func(string) (uint64, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			return 1 << 40, nil // la comprobación previa pasa
		}
		return 0, nil
	})
	rc := &fakeRcon{}
	req := baseReq(dataDir, backupsDir)
	req.Rcon = rc.run
	_, err := Create(context.Background(), req)
	if !errors.Is(err, ErrNoSpace) || !strings.Contains(err.Error(), "durante la copia") {
		t.Fatalf("err = %v", err)
	}
	if got := strings.Join(rc.cmds, ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("RCON = %s", got)
	}
	assertNoArchives(t, backupsDir)
}

func TestCreateUnknownFreeSpaceStillCopies(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	stubFreeSpace(t, func(string) (uint64, error) { return 0, errors.New("statfs no disponible") })
	req := baseReq(dataDir, backupsDir)
	var logs []string
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Create(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "no se pudo comprobar el espacio libre") {
		t.Fatalf("log = %v", logs)
	}
}

// S2: la extracción se acota al espacio libre menos el margen, no solo a 256 GiB. Una copia
// sin .json (need = tamaño comprimido) muy compresible pasaría checkSpace y llenaría el disco.
func TestRestoreExtractionLimitedByFreeSpace(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	mustWrite(t, filepath.Join(dataDir, "world", "region.mca"), strings.Repeat("\x00", 1<<20), 0o644)
	m := makeBackup(t, dataDir, backupsDir)
	if err := os.Remove(filepath.Join(backupsDir, m.Filename+MetaExt)); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	compressed := m.SizeBytes
	free := requiredSpace(compressed) + 10<<10 // pasa checkSpace; caben ~10 KiB más que la copia comprimida
	stubFreeSpace(t, func(string) (uint64, error) { return free, nil })
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if !errors.Is(err, ErrNoSpace) {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)

	stubFreeSpace(t, func(string) (uint64, error) { return 1 << 40, nil })
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(2*time.Hour))); err != nil {
		t.Fatalf("con espacio: %v", err)
	}
}
