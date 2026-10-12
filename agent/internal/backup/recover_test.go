package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// crashedSwap deja el disco como un crash entre los dos renombrados de Restore: sin data,
// con los datos originales en el pre-restore (aún sin .json) y la copia extraída en el
// temporal, ambos con la misma marca de tiempo.
func crashedSwap(t *testing.T, at time.Time) (dataDir, backupsDir, pre, staging string) {
	t.Helper()
	root := t.TempDir()
	dataDir = filepath.Join(root, "survival", "data")
	backupsDir = filepath.Join(root, "survival", "backups")
	pre = filepath.Join(root, "survival", PreRestoreName(dataDir, at))
	staging = dataDir + restoringInfix + at.UTC().Format(tsLayout)
	mustWrite(t, filepath.Join(pre, "world", "level.dat"), "ORIGINAL", 0o644)
	mustWrite(t, filepath.Join(staging, "world", "level.dat"), "COPIA", 0o644)
	return dataDir, backupsDir, pre, staging
}

func TestRecoverRemovesPartialsAndOrphanMeta(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	m := makeBackup(t, dataDir, backupsDir)
	cut := Filename("survival", t0.Add(time.Minute), 3)      // copia cortada a medias
	orphan := Filename("survival", t0.Add(2*time.Minute), 3) // .json sin su .tar.zst
	gone := []string{cut + partialExt, cut + MetaExt + partialExt, orphan + MetaExt}
	foreign := []string{"notas.txt", "otro-20261012T040000.000Z-1.tar.zst.partial", "survival-mal.tar.zst.partial"}
	for _, n := range append(append([]string{}, gone...), foreign...) {
		mustWrite(t, filepath.Join(backupsDir, n), "x", 0o640)
	}
	preMetaTmp := filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, t0)+MetaExt+partialExt)
	mustWrite(t, preMetaTmp, "{", 0o640)

	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range gone {
		if exists(filepath.Join(backupsDir, n)) {
			t.Errorf("%s debe borrarse", n)
		}
		if !slices.Contains(rec.Removed, filepath.Join(backupsDir, n)) {
			t.Errorf("Removed no incluye %s: %v", n, rec.Removed)
		}
	}
	if exists(preMetaTmp) {
		t.Error("el .json.partial de un pre-restore debe borrarse")
	}
	for _, n := range append([]string{m.Filename, m.Filename + MetaExt}, foreign...) {
		if !exists(filepath.Join(backupsDir, n)) {
			t.Errorf("%s no es un resto de este servidor: no se toca", n)
		}
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-1" || rec.RolledBack != "" {
		t.Fatalf("los datos no se tocan: %+v", rec)
	}
}

// Crash entre los dos renombrados: se vuelve a los datos originales (el job queda FAILED
// «interrumpido», así que la restauración no se completa) y el temporal sobra.
func TestRecoverRollsBackInterruptedSwap(t *testing.T) {
	dataDir, backupsDir, pre, staging := crashedSwap(t, t0)
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil {
		t.Fatal(err)
	}
	if rec.RolledBack != filepath.Base(pre) {
		t.Fatalf("RolledBack = %q", rec.RolledBack)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "ORIGINAL" {
		t.Fatal("data debe volver a tener los datos originales")
	}
	if exists(pre) || exists(staging) {
		t.Fatalf("no deben quedar pre-restore ni temporal: pre=%v staging=%v", exists(pre), exists(staging))
	}
	if !slices.Contains(rec.Removed, staging) {
		t.Fatalf("Removed = %v", rec.Removed)
	}
}

// Tras un ErrDataMissing (fallan los dos renombrados y Restore ya borró el temporal), el
// siguiente arranque devuelve los datos originales a su sitio.
func TestRecoverRollsBackAfterDataMissing(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	at := t0.Add(time.Hour)
	stubRename(t, func(oldpath, newpath string) error {
		if newpath == dataDir {
			return errors.New("fallo simulado")
		}
		return os.Rename(oldpath, newpath)
	})
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); !errors.Is(err, ErrDataMissing) {
		t.Fatalf("preparación: %v", err)
	}
	rename = os.Rename
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil {
		t.Fatal(err)
	}
	if rec.RolledBack != PreRestoreName(dataDir, at) || mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "LEVEL-2" {
		t.Fatalf("rec = %+v", rec)
	}
	if list, _ := ListPreRestore(dataDir); len(list) != 0 {
		t.Fatalf("el pre-restore vuelve a ser data: %+v", list)
	}
}

// Una restauración completada deja el .json del pre-restore. Si después alguien borra data,
// no es un intercambio a medias: el pre-restore no se toca (un mundo nuevo es decisión suya).
func TestRecoverLeavesCompletedRestoreAlone(t *testing.T) {
	dataDir, backupsDir, m := changedWorld(t)
	at := t0.Add(time.Hour)
	if _, err := Restore(context.Background(), restoreReq(dataDir, backupsDir, m.Filename, at)); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dataDir); err != nil {
		t.Fatal(err)
	}
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil || rec.RolledBack != "" {
		t.Fatalf("rec = %+v, err = %v", rec, err)
	}
	if exists(dataDir) || !exists(filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, at))) {
		t.Fatal("ni data ni el pre-restore deben cambiar")
	}
}

func TestRecoverRemovesStagingOnlyWithData(t *testing.T) {
	dataDir, backupsDir := newWorld(t)
	staging := dataDir + restoringInfix + t0.UTC().Format(tsLayout)
	mustWrite(t, filepath.Join(staging, "world", "level.dat"), "A MEDIAS", 0o644)
	if _, err := RecoverInterrupted(backupsDir, dataDir, "survival"); err != nil {
		t.Fatal(err)
	}
	if exists(staging) {
		t.Fatal("con data en su sitio el temporal sobra")
	}

	// Primera restauración de un servidor sin datos, cortada antes de activar la copia: sin
	// data ni pre-restore, el temporal no se toca.
	root := t.TempDir()
	dataDir = filepath.Join(root, "survival", "data")
	staging = dataDir + restoringInfix + t0.UTC().Format(tsLayout)
	mustWrite(t, filepath.Join(staging, "world", "level.dat"), "COPIA", 0o644)
	rec, err := RecoverInterrupted(filepath.Join(root, "survival", "backups"), dataDir, "survival")
	if err != nil || rec.RolledBack != "" || !exists(staging) || exists(dataDir) {
		t.Fatalf("rec = %+v, err = %v, staging=%v data=%v", rec, err, exists(staging), exists(dataDir))
	}
}

func TestRecoverRollbackFailureIsDataMissing(t *testing.T) {
	dataDir, backupsDir, pre, staging := crashedSwap(t, t0)
	stubRename(t, func(oldpath, newpath string) error { return errors.New("fallo simulado") })
	_, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if !errors.Is(err, ErrDataMissing) || !strings.Contains(err.Error(), pre) || strings.Contains(err.Error(), "\n") {
		t.Fatalf("err = %q; debe envolver ErrDataMissing y decir dónde están los datos", err)
	}
	if mustRead(t, filepath.Join(pre, "world", "level.dat")) != "ORIGINAL" || !exists(staging) || exists(dataDir) {
		t.Fatal("sin data no se borra nada")
	}
}

// Con varios pre-restore sin .json (uno antiguo cuyo .json no se pudo escribir), se
// devuelve el más reciente: el del intercambio a medias.
func TestRecoverPicksNewestPreRestore(t *testing.T) {
	dataDir, backupsDir, pre, _ := crashedSwap(t, t0.Add(time.Hour))
	old := filepath.Join(filepath.Dir(dataDir), PreRestoreName(dataDir, t0))
	mustWrite(t, filepath.Join(old, "world", "level.dat"), "ANTIGUO", 0o644)
	rec, err := RecoverInterrupted(backupsDir, dataDir, "survival")
	if err != nil || rec.RolledBack != filepath.Base(pre) {
		t.Fatalf("rec = %+v, err = %v", rec, err)
	}
	if mustRead(t, filepath.Join(dataDir, "world", "level.dat")) != "ORIGINAL" || !exists(old) {
		t.Fatal("se devuelve el más reciente y el antiguo se conserva")
	}
}
