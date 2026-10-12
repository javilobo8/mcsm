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

// TestMain deja el volcado a disco sustituido por defecto: syncfs real solo en
// TestRestoreWithRealSyncfs. Los puntos de inyección son variables de paquete, así que
// los tests de este paquete no usan t.Parallel.
func TestMain(m *testing.M) {
	syncFS = func(string) error { return nil }
	os.Exit(m.Run())
}

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

func stubSync(t *testing.T, fn func(dir string) error) {
	t.Helper()
	old := syncFS
	syncFS = fn
	t.Cleanup(func() { syncFS = old })
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

// changedWorld hace una copia y luego cambia level.dat a LEVEL-2 (los datos «actuales»).
func changedWorld(t *testing.T) (dataDir, backupsDir string, m Meta) {
	t.Helper()
	dataDir, backupsDir = newWorld(t)
	m = makeBackup(t, dataDir, backupsDir)
	mustWrite(t, filepath.Join(dataDir, "world", "level.dat"), "LEVEL-2", 0o644)
	return dataDir, backupsDir, m
}

func TestRequiredSpaceMargin(t *testing.T) {
	const gib = int64(1) << 30
	for _, tc := range []struct {
		need int64
		want uint64
	}{
		{0, 256 << 20},
		{17, 17 + 256<<20},
		{gib, uint64(gib) + 256<<20},           // 5 % < 256 MiB
		{10 * gib, uint64(10*gib) + 512<<20},   // 5 % = 512 MiB
		{100 * gib, uint64(100*gib) + 5*1<<30}, // 5 % = 5 GiB
	} {
		if got := requiredSpace(tc.need); got != tc.want {
			t.Errorf("requiredSpace(%d) = %d, want %d", tc.need, got, tc.want)
		}
	}
}

func TestFreeBytesUsesFragmentSize(t *testing.T) {
	if got := freeBytes(10, 4096, 1<<20); got != 40960 {
		t.Fatalf("con f_frsize = %d; f_bavail va en unidades de f_frsize", got)
	}
	if got := freeBytes(10, 0, 4096); got != 40960 {
		t.Fatalf("sin f_frsize = %d; se usa f_bsize", got)
	}
	if free, err := statfsFree(t.TempDir()); err != nil || free == 0 {
		t.Fatalf("statfs real = %d, %v", free, err)
	}
}

func TestRestoreNotEnoughSpaceLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	var asked string
	stubFreeSpace(t, func(dir string) (uint64, error) { asked = dir; return requiredSpace(m.DataBytes) - 1, nil })
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "espacio") || !strings.Contains(err.Error(), "margen") {
		t.Fatalf("err = %v; debe explicar el espacio que falta y el margen", err)
	}
	if asked != filepath.Dir(dataDir) {
		t.Fatalf("espacio consultado en %q; debe ser donde se extrae (%q)", asked, filepath.Dir(dataDir))
	}
	assertUntouched(t, dataDir)
}

func TestRestoreSpaceCheckUsesUncompressedSize(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	stubFreeSpace(t, func(string) (uint64, error) { return requiredSpace(m.DataBytes), nil })
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err != nil {
		t.Fatalf("con el espacio justo debe restaurar: %v", err)
	}
}

func TestRestoreSpaceCheckWithoutMetaUsesArchiveSize(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	if err := os.Remove(filepath.Join(backupsDir, m.Filename+MetaExt)); err != nil {
		t.Fatal(err)
	}
	stubFreeSpace(t, func(string) (uint64, error) { return requiredSpace(m.SizeBytes) - 1, nil })
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

func TestRestoreUnreadableMetaIsNotMissingSHA(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	if err := os.WriteFile(filepath.Join(backupsDir, m.Filename+MetaExt), []byte("{roto"), 0o640); err != nil {
		t.Fatal(err)
	}
	var logs []string
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Restore(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(logs, "\n")
	if !strings.Contains(all, "ilegible") || strings.Contains(all, "no tiene sha256") {
		t.Fatalf("un .json ilegible no es una copia sin sha256: %v", logs)
	}
}

func TestRestoreSwapFailureRestoresOriginalData(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	stubRename(t, func(oldpath, newpath string) error {
		if newpath == dataDir && strings.Contains(oldpath, restoringInfix) {
			return errors.New("fallo simulado")
		}
		return os.Rename(oldpath, newpath)
	})
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "activar la copia") || errors.Is(err, ErrDataMissing) {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreRollbackFailureKeepsOriginalInPreRestore(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
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
	if !errors.Is(err, ErrDataMissing) || strings.Contains(err.Error(), "\n") {
		t.Fatalf("err = %q; debe envolver ErrDataMissing (en una sola línea)", err)
	}
	if mustRead(t, filepath.Join(filepath.Dir(dataDir), preName, "world", "level.dat")) != "LEVEL-2" {
		t.Fatal("los datos originales deben seguir íntegros en el pre-restore")
	}
}

func TestRestoreRefusesToReplaceExistingPreRestore(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
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

func TestRestoreRejectsSymlinkedData(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	target := filepath.Join(filepath.Dir(dataDir), "real-data")
	if err := os.Rename(dataDir, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err == nil {
		t.Fatal("data como enlace simbólico debe rechazarse (renombrar el enlace no apartaría los datos)")
	}
	if fi, err := os.Lstat(dataDir); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("el enlace no debe tocarse")
	}
	if mustRead(t, filepath.Join(target, "world", "level.dat")) != "LEVEL-2" || len(leftovers(t, dataDir)) != 0 {
		t.Fatal("los datos no deben tocarse ni quedar temporales")
	}
}

func TestRestoreRejectsNonRegularBackup(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	asDir := Filename("survival", t0.Add(time.Minute), 3)
	if err := os.Mkdir(filepath.Join(backupsDir, asDir), 0o755); err != nil {
		t.Fatal(err)
	}
	asLink := Filename("survival", t0.Add(2*time.Minute), 3)
	if err := os.Symlink(filepath.Join(backupsDir, m.Filename), filepath.Join(backupsDir, asLink)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{asDir, asLink} {
		_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, name, t0.Add(time.Hour)))
		if err == nil || !strings.Contains(err.Error(), "no es un fichero normal") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	assertUntouched(t, dataDir)
}

func TestRestoreLogsStagingCleanupFailure(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	p := filepath.Join(backupsDir, m.Filename)
	if err := os.Remove(p + MetaExt); err != nil {
		t.Fatal(err)
	}
	data := mustRead(t, p)
	if err := os.WriteFile(p, []byte(data[:len(data)/2]), 0o640); err != nil { // la extracción fallará
		t.Fatal(err)
	}
	old := removeAll
	removeAll = func(p string) error { _ = os.RemoveAll(p); return errors.New("fallo simulado") }
	t.Cleanup(func() { removeAll = old })
	var logs []string
	req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
	req.Log = func(l string) { logs = append(logs, l) }
	if _, err := Restore(context.Background(), req); err == nil {
		t.Fatal("una copia truncada debe fallar")
	}
	if all := strings.Join(logs, "\n"); !strings.Contains(all, restoringInfix) || !strings.Contains(all, "fallo simulado") {
		t.Fatalf("debe registrarse que no se pudo borrar el temporal: %v", logs)
	}
}

func TestRestoreCancelledLeavesDataUntouched(t *testing.T) {
	for _, at := range []uint32{10, 90} { // al empezar a extraer y al terminar de leer la copia
		t.Run(fmt.Sprint(at), func(t *testing.T) {
			dataDir, backupsDir, m := changedWorld(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))
			req.Progress = func(p uint32, _ string) {
				if p >= at {
					cancel()
				}
			}
			_, err := Restore(ctx, req)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("err = %v", err)
			}
			if strings.Contains(err.Error(), "dañada") {
				t.Fatalf("una cancelación no es una copia dañada: %v", err)
			}
			assertUntouched(t, dataDir)
		})
	}
}

// Una cancelación con la copia ya extraída (p. ej. el agente se está cerrando) tampoco
// llega a intercambiar nada.
func TestRestoreCancelledAfterExtractionLeavesDataUntouched(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var synced string
	stubSync(t, func(dir string) error { synced = dir; cancel(); return nil }) // se vuelca a disco justo tras extraer
	if _, err := Restore(ctx, restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(synced, restoringInfix) {
		t.Fatalf("syncfs sobre %q; debe ser el temporal extraído", synced)
	}
	assertUntouched(t, dataDir)
}

// Un syncfs que no vuelve (FS colgado) no bloquea la restauración para siempre: al
// cancelar se deja de esperar y no se intercambia nada.
func TestRestoreHungSyncIsAbandonedOnCancel(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	finished := make(chan struct{})
	stubSync(t, func(string) error {
		defer close(finished)
		cancel()
		<-release // colgado hasta que el test lo suelte
		return nil
	})
	if _, err := Restore(ctx, restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
	close(release)
	<-finished // la goroutine abandonada termina en cuanto el sync vuelve
}

func TestRestoreSyncFailureDoesNotSwap(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	stubSync(t, func(string) error { return errors.New("EIO simulado") })
	_, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour)))
	if err == nil || !strings.Contains(err.Error(), "EIO simulado") {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, dataDir)
}

func TestRestoreWithRealSyncfs(t *testing.T) {
	stubSync(t, syncFilesystem)
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, t0.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" {
		t.Fatal("datos no restaurados")
	}
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
