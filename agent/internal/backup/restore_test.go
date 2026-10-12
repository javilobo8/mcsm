package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func makeBackup(t *testing.T, dataDir, backupsDir string) Meta {
	t.Helper()
	m, err := Create(context.Background(), baseReq(dataDir, backupsDir))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func restoreReq(dataDir, backupsDir, name string, at time.Time) RestoreRequest {
	return RestoreRequest{ServerID: "srv-1", Slug: "survival", Filename: name, DataDir: dataDir, BackupsDir: backupsDir, Now: func() time.Time { return at }}
}

// leftovers lista los directorios temporales .restoring-* que hayan quedado.
func leftovers(t *testing.T, dataDir string) []string {
	t.Helper()
	ents, _ := os.ReadDir(filepath.Dir(dataDir))
	var out []string
	for _, e := range ents {
		if strings.Contains(e.Name(), restoringInfix) {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestRestoreSwapsAndKeepsPrevious(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	mustWrite(t, filepath.Join(dataDir, "nuevo.txt"), "x", 0o644)
	pre, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" || exists(filepath.Join(dataDir, "nuevo.txt")) {
		t.Fatal("los datos no son los de la copia")
	}
	if pre.Filename != "data.pre-restore-20261012T050000.000Z" || pre.Trigger != TriggerPreRestore || pre.SizeBytes == 0 {
		t.Fatalf("pre = %+v", pre)
	}
	prePath := filepath.Join(filepath.Dir(dataDir), pre.Filename)
	if mustRead(t, filepath.Join(prePath, "world", "level.dat")) != "LEVEL-2" || !exists(filepath.Join(prePath, "nuevo.txt")) {
		t.Fatal("los datos anteriores deben conservarse íntegros")
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 1 || list[0].SizeBytes != pre.SizeBytes {
		t.Fatalf("ListPreRestore = %+v", list)
	}
	if l := leftovers(t, dataDir); len(l) != 0 {
		t.Fatalf("restos: %v", l)
	}
}

func TestRestoreTwiceKeepsBothPrevious(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	for i, at := range []time.Time{t0.Add(time.Hour), t0.Add(2 * time.Hour)} {
		if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); err != nil {
			t.Fatalf("restauración %d: %v", i, err)
		}
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 2 {
		t.Fatalf("nunca se borra un pre-restore anterior: %+v", list)
	}
}

func TestRestoreCorruptBackupLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	p := filepath.Join(backupsDir, m.Filename)
	data := []byte(mustRead(t, p))
	data[len(data)/2] ^= 0xff
	if err := os.WriteFile(p, data, 0o640); err != nil {
		t.Fatal(err)
	}
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "dañada") {
		t.Fatalf("err = %v", err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" {
		t.Fatal("los datos actuales no deben tocarse")
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 0 || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("no deben quedar directorios pre-restore ni temporales")
	}
}

func TestRestoreUnreadableArchiveLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	if err := os.Remove(filepath.Join(backupsDir, m.Filename+MetaExt)); err != nil { // sin sha256 que verificar
		t.Fatal(err)
	}
	p := filepath.Join(backupsDir, m.Filename)
	data := mustRead(t, p)
	if err := os.WriteFile(p, []byte(data[:len(data)/2]), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err == nil {
		t.Fatal("una copia truncada debe fallar")
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("los datos actuales no deben tocarse ni quedar temporales")
	}
}

func TestRestoreRejectsBadNames(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	for _, name := range []string{"../../etc/passwd", "otro-20261012T040000.000Z-3.tar.zst", "data.pre-restore-20261012T040000.000Z"} {
		if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, name, t0)); err == nil {
			t.Errorf("%q debe rechazarse", name)
		}
	}
}

func TestRestoreWithoutPreviousData(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	if err := os.RemoveAll(dataDir); err != nil {
		t.Fatal(err)
	}
	pre, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err != nil || pre.Filename != "" {
		t.Fatalf("pre = %+v, %v", pre, err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" {
		t.Fatal("datos no restaurados")
	}
}

// ── Más allá del brief: espacio libre, intercambio atómico ante fallos, cancelación ──

func stubFreeSpace(t *testing.T, fn func(dir string) (uint64, error)) {
	t.Helper()
	old := freeSpace
	freeSpace = fn
	t.Cleanup(func() { freeSpace = old })
}

func stubRename(t *testing.T, fn func(oldpath, newpath string) error) {
	t.Helper()
	old := rename
	rename = fn
	t.Cleanup(func() { rename = old })
}

// assertUntouched comprueba que una restauración fallida no cambió nada: data con LEVEL-2,
// sin pre-restore y sin temporales.
func assertUntouched(t *testing.T, dataDir string) {
	t.Helper()
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" {
		t.Fatal("los datos actuales no deben tocarse")
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 0 {
		t.Fatalf("no debe quedar pre-restore: %+v", list)
	}
	if l := leftovers(t, dataDir); len(l) != 0 {
		t.Fatalf("restos: %v", l)
	}
}

func TestRestoreNotEnoughSpaceLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	var asked string
	stubFreeSpace(t, func(dir string) (uint64, error) { asked = dir; return uint64(m.DataBytes) - 1, nil })
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "espacio") {
		t.Fatalf("err = %v", err)
	}
	if asked != filepath.Dir(dataDir) {
		t.Fatalf("espacio consultado en %q; debe ser donde se extrae (%q)", asked, filepath.Dir(dataDir))
	}
	assertUntouched(t, dataDir)
}

func TestRestoreSpaceCheckUsesUncompressedSize(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	stubFreeSpace(t, func(string) (uint64, error) { return uint64(m.DataBytes), nil })
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err != nil {
		t.Fatalf("con el espacio justo debe restaurar: %v", err)
	}
}

func TestRestoreSpaceCheckWithoutMetaUsesArchiveSize(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	if err := os.Remove(filepath.Join(backupsDir, m.Filename+MetaExt)); err != nil {
		t.Fatal(err)
	}
	stubFreeSpace(t, func(string) (uint64, error) { return uint64(m.SizeBytes) - 1, nil })
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err == nil || !strings.Contains(err.Error(), "espacio") {
		t.Fatalf("sin .json el mínimo es el tamaño de la copia: err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreSpaceUnknownStillRestores(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	stubFreeSpace(t, func(string) (uint64, error) { return 0, errors.New("statfs: no soportado") })
	var logs []string
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Restore(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "espacio libre") {
		t.Fatalf("debe avisar de que no pudo comprobar el espacio: %v", logs)
	}
}

func TestRestoreSwapFailureRestoresOriginalData(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	stubRename(t, func(oldpath, newpath string) error {
		if newpath == dataDir && strings.Contains(oldpath, restoringInfix) {
			return errors.New("fallo simulado")
		}
		return os.Rename(oldpath, newpath)
	})
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "activar la copia") {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreRollbackFailureKeepsOriginalInPreRestore(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	stubRename(t, func(oldpath, newpath string) error {
		if newpath == dataDir {
			return errors.New("fallo simulado")
		}
		return os.Rename(oldpath, newpath)
	})
	at := t0.Add(time.Hour)
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at))
	preName := PreRestoreName(dataDir, at)
	if err == nil || !strings.Contains(err.Error(), preName) {
		t.Fatalf("el error debe decir dónde quedaron los datos originales: %v", err)
	}
	if mustRead(t, filepath.Join(filepath.Dir(dataDir), preName, "world", "level.dat")) != "LEVEL-2" {
		t.Fatal("los datos originales deben seguir íntegros en el pre-restore")
	}
}

func TestRestoreRefusesToReplaceExistingPreRestore(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	at := t0.Add(time.Hour)
	// rename(2) sustituye en silencio un directorio vacío: no debe llegar a intentarse.
	existing := filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, at))
	if err := os.Mkdir(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); err == nil {
		t.Fatal("debe fallar si el pre-restore ya existe")
	}
	if !exists(existing) {
		t.Fatal("un pre-restore existente nunca se toca")
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("los datos actuales no deben tocarse ni quedar temporales")
	}
}

func TestRestoreCancelledLeavesDataUntouched(t *testing.T) {
	for _, at := range []uint32{10, 90} { // al empezar a extraer y al terminar de leer la copia
		t.Run(fmt.Sprint(at), func(t *testing.T) {
			dataDir, backupsDir := newWorld(t)
			m := makeBackup(t, dataDir, backupsDir)
			mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
			req.Progress = func(p uint32, _ string) {
				if p >= at {
					cancel()
				}
			}
			if _, err := Restore(ctx, req); !errors.Is(err, context.Canceled) {
				t.Fatalf("err = %v", err)
			}
			assertUntouched(t, dataDir)
		})
	}
}

// Una cancelación con la copia ya extraída (p. ej. el agente se está cerrando) tampoco
// llega a intercambiar nada.
func TestRestoreCancelledAfterExtractionLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	old := syncFS
	syncFS = cancel // se vuelca a disco justo tras extraer
	t.Cleanup(func() { syncFS = old })
	if _, err := Restore(ctx, restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreProgress(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	var pcts []uint32
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Progress = func(p uint32, _ string) { pcts = append(pcts, p) }
	if _, err := Restore(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if len(pcts) < 3 || pcts[0] != 2 || pcts[1] != 10 || pcts[len(pcts)-1] != 92 {
		t.Fatalf("avance = %v; esperado 2 (verificar), 10–90 (extraer), 92 (apartar)", pcts)
	}
	for i := 1; i < len(pcts); i++ {
		if pcts[i] < pcts[i-1] || pcts[i] > 92 {
			t.Fatalf("avance fuera de orden o de rango: %v", pcts)
		}
	}
}
