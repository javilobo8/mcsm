package files

import (
	"context"
	"io/fs"
	"time"
)

// SweepTemps borra los temporales de escrituras atómicas que quedaron huérfanos (el agente murió
// o se cerró a mitad de una subida) y llevan más de olderThan sin modificarse: los de una
// escritura en curso cambian con cada trozo, y una transferencia parada más de un minuto se
// corta. Recorre la raíz con os.Root, sin seguir enlaces ni salir de ella, y solo borra ficheros
// normales con el nombre exacto de un temporal. Una carpeta ilegible no detiene el barrido; el
// contexto sí. Devuelve cuántos borró.
func (f *FS) SweepTemps(ctx context.Context, olderThan time.Duration, now time.Time) (int, error) {
	r, err := f.open()
	if err != nil {
		return 0, err
	}
	defer r.Close()
	n := 0
	err = fs.WalkDir(r.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil || d.IsDir() || !IsTempName(d.Name()) {
			return nil
		}
		info, err := r.Lstat(p)
		if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) <= olderThan {
			return nil
		}
		if r.Remove(p) == nil {
			n++
		}
		return nil
	})
	return n, err
}
