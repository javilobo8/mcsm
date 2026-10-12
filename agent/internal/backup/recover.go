package backup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Recovery es lo que hizo RecoverInterrupted.
type Recovery struct {
	Removed    []string // restos borrados (rutas)
	RolledBack string   // pre-restore devuelto a data (nombre), o "" si ninguno
	Warnings   []string // restos que no se pudieron borrar o leer (no impiden arrancar)
}

// RecoverInterrupted deja coherente el disco de un servidor tras un cierre o un crash del
// agente a mitad de una copia o una restauración. Se llama al arrancar, antes de reconciliar
// (o con el servidor reservado), cuando no hay ninguna copia ni restauración en curso:
//
//   - Borra en backupsDir las copias a medias (<copia>.partial, <copia>.json.partial) y los
//     .json huérfanos sin su .tar.zst, y junto a data los .json.partial de los pre-restore.
//   - Si data no existe y el pre-restore más reciente no tiene .json, lo devuelve a data con
//     un renombrado. Restore escribe ese .json después del intercambio, así que sin él el
//     intercambio no terminó (crash entre los dos renombrados, o ErrDataMissing): son los
//     datos originales, y sin ellos Docker crearía un data vacío al arrancar el contenedor y
//     el servidor generaría un mundo nuevo. Se vuelve a los datos originales y no a la copia
//     extraída porque el job queda FAILED («interrumpido»). Un pre-restore con .json es de
//     una restauración completada: si después falta data, no se toca nada.
//   - Con data en su sitio, borra los temporales de extracción data.restoring-*. Sin data se
//     dejan: pueden ser lo único que quede.
//
// Solo toca nombres que siguen las convenciones de este paquete. Si data no existe y no se
// pudo devolver, el error envuelve ErrDataMissing: el servidor no debe arrancarse.
func RecoverInterrupted(backupsDir, dataDir, slug string) (Recovery, error) {
	var rec Recovery
	rec.removeFiles(backupsDir, func(name string) bool { return backupLeftover(backupsDir, slug, name) })

	parent := filepath.Dir(dataDir)
	ents, err := os.ReadDir(parent)
	if errors.Is(err, fs.ErrNotExist) {
		return rec, nil // servidor sin directorio todavía
	}
	if err != nil {
		rec.warn("leer " + parent + ": " + err.Error())
		return rec, nil
	}
	var pres, staging []string
	base := filepath.Base(dataDir)
	for _, e := range ents {
		name := e.Name()
		switch {
		case e.Type().IsRegular() && preRestoreMetaPartial(dataDir, name):
			rec.remove(filepath.Join(parent, name), false)
		case e.IsDir() && ValidPreRestoreName(dataDir, name):
			pres = append(pres, name)
		case strings.HasPrefix(name, base+restoringInfix) && tsRe.MatchString(strings.TrimPrefix(name, base+restoringInfix)):
			staging = append(staging, name)
		}
	}

	cur, err := currentData(dataDir)
	if err != nil {
		rec.warn(err.Error()) // data existe y no es un directorio: no se toca nada más
		return rec, nil
	}
	if cur == nil {
		sort.Strings(pres) // la marca de tiempo ordena por fecha
		if len(pres) == 0 {
			return rec, nil
		}
		newest := pres[len(pres)-1]
		if _, err := os.Lstat(filepath.Join(parent, newest+MetaExt)); !errors.Is(err, fs.ErrNotExist) {
			return rec, nil // restauración completada (o .json ilegible): no es un intercambio a medias
		}
		prePath := filepath.Join(parent, newest)
		if err := rename(prePath, dataDir); err != nil {
			return rec, fmt.Errorf("%w: falta %s tras una restauración interrumpida y no se pudieron devolver los datos originales desde %s: %v",
				ErrDataMissing, dataDir, prePath, err)
		}
		_ = syncDir(parent)
		rec.RolledBack = newest
	}
	for _, name := range staging {
		rec.remove(filepath.Join(parent, name), true)
	}
	return rec, nil
}

// backupLeftover indica si name, en backupsDir, es un resto de una copia de slug: un
// .partial de una copia o de su .json, o un .json sin su .tar.zst.
func backupLeftover(backupsDir, slug, name string) bool {
	if base, ok := strings.CutSuffix(name, partialExt); ok {
		archive, _ := strings.CutSuffix(base, MetaExt)
		return ValidName(slug, archive)
	}
	if archive, ok := strings.CutSuffix(name, MetaExt); ok && ValidName(slug, archive) {
		_, err := os.Lstat(filepath.Join(backupsDir, archive))
		return errors.Is(err, fs.ErrNotExist)
	}
	return false
}

// preRestoreMetaPartial indica si name es el temporal del .json de un pre-restore de dataDir.
func preRestoreMetaPartial(dataDir, name string) bool {
	pre, ok := strings.CutSuffix(name, MetaExt+partialExt)
	return ok && ValidPreRestoreName(dataDir, pre)
}

// removeFiles borra los ficheros normales de dir que cumplen match.
func (r *Recovery) removeFiles(dir string, match func(name string) bool) {
	ents, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		r.warn("leer " + dir + ": " + err.Error())
		return
	}
	for _, e := range ents {
		if e.Type().IsRegular() && match(e.Name()) {
			r.remove(filepath.Join(dir, e.Name()), false)
		}
	}
}

func (r *Recovery) remove(p string, recursive bool) {
	var err error
	if recursive {
		err = removeAll(p)
	} else {
		err = os.Remove(p)
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		r.warn("no se pudo borrar " + p + ": " + err.Error())
		return
	}
	r.Removed = append(r.Removed, p)
}

func (r *Recovery) warn(msg string) { r.Warnings = append(r.Warnings, msg) }
