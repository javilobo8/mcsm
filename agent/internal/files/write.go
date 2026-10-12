package files

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"syscall"
)

// writeTarget es el destino ya validado de una escritura.
type writeTarget struct {
	real  string      // ruta real relativa a la raíz
	mode  fs.FileMode // permisos a conservar (0o644 si es nuevo)
	owner fs.FileInfo // de quién copiar uid/gid: el fichero reemplazado o su carpeta
}

// prepareWrite valida el destino de una escritura: la carpeta existe y está dentro, el destino
// no es una carpeta y, si es un enlace que queda dentro, se escribe en su destino real.
func (f *FS) prepareWrite(r *os.Root, rel string) (writeTarget, error) {
	target, err := f.resolveEntry(rel)
	if err != nil {
		return writeTarget{}, err
	}
	li, err := r.Lstat(target)
	switch {
	case err == nil:
		if li.Mode()&fs.ModeSymlink != 0 {
			if target, err = f.resolve(target); err != nil {
				return writeTarget{}, err
			}
			if li, err = r.Stat(target); err != nil {
				return writeTarget{}, mapErr(err, rel)
			}
		}
		if li.IsDir() {
			return writeTarget{}, fmt.Errorf("%w: %s", ErrIsDir, display(rel))
		}
		if !li.Mode().IsRegular() {
			return writeTarget{}, fmt.Errorf("%w: %s no es un fichero normal", ErrInvalidPath, display(rel))
		}
		return writeTarget{real: target, mode: li.Mode().Perm(), owner: li}, nil
	case errors.Is(err, fs.ErrNotExist):
		pi, err := r.Stat(path.Dir(target))
		if err != nil {
			return writeTarget{}, mapErr(err, path.Dir(rel))
		}
		if !pi.IsDir() {
			return writeTarget{}, fmt.Errorf("%w: %s", ErrNotDir, display(path.Dir(rel)))
		}
		return writeTarget{real: target, mode: 0o644, owner: pi}, nil
	default:
		return writeTarget{}, mapErr(err, rel)
	}
}

// CheckWrite valida que p se puede escribir sin tocar nada. Sirve para fallar antes de
// empezar una transferencia; WriteFrom vuelve a validar al escribir.
func (f *FS) CheckWrite(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	_, err = f.prepareWrite(r, rel)
	return err
}

// readErr marca los errores que vienen del origen (la transferencia), no del disco.
type readErr struct{ error }

func (e readErr) Unwrap() error { return e.error }

type tagReader struct{ r io.Reader }

func (t tagReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && err != io.EOF {
		err = readErr{err}
	}
	return n, err
}

func randHex() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// WriteFrom escribe src en p de forma atómica: temporal en la misma carpeta, fsync y rename.
// Si algo falla, el fichero anterior queda intacto y el temporal se borra. expected >= 0 exige
// ese número exacto de bytes (una transferencia truncada nunca reemplaza el fichero) y no lee
// más de expected+1 del origen; con expected < 0 no hay tope. Conserva
// permisos y dueño del fichero reemplazado; uno nuevo hereda el dueño de su carpeta, para que
// el servidor (uid 1000 en itzg) pueda seguir reescribiéndolo aunque el agente sea root.
// Copia en streaming: la memoria usada no depende del tamaño.
func (f *FS) WriteFrom(p string, src io.Reader, expected int64) (int64, error) {
	rel, err := Clean(p)
	if err != nil {
		return 0, err
	}
	r, err := f.open()
	if err != nil {
		return 0, err
	}
	defer r.Close()
	wt, err := f.prepareWrite(r, rel)
	if err != nil {
		return 0, err
	}
	tmp := path.Join(path.Dir(wt.real), tmpPrefix+randHex())
	fh, err := r.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, wt.mode)
	if err != nil {
		return 0, mapErr(err, rel)
	}
	closed, renamed := false, false
	defer func() {
		if !closed {
			fh.Close()
		}
		if !renamed {
			_ = r.Remove(tmp)
		}
	}()
	if expected >= 0 && expected < math.MaxInt64 {
		src = io.LimitReader(src, expected+1) // un origen que envía de más no llena el disco
	}
	n, err := io.Copy(fh, tagReader{src})
	if err != nil {
		var re readErr
		if errors.As(err, &re) {
			return n, fmt.Errorf("%w: %v", ErrTransfer, re.error)
		}
		return n, mapErr(err, rel)
	}
	switch {
	case expected >= 0 && n > expected:
		return n, fmt.Errorf("%w: el origen envía más de %d bytes", ErrTransfer, expected)
	case expected >= 0 && n < expected:
		return n, fmt.Errorf("%w: recibidos %d de %d bytes", ErrTransfer, n, expected)
	}
	if err := fh.Chmod(wt.mode); err != nil { // el umask pudo recortar los permisos al crear
		return n, mapErr(err, rel)
	}
	chownLike(fh, wt.owner)
	if err := fh.Sync(); err != nil {
		return n, mapErr(err, rel)
	}
	closed = true
	if err := fh.Close(); err != nil {
		return n, mapErr(err, rel)
	}
	if err := r.Rename(tmp, wt.real); err != nil {
		return n, mapErr(err, rel)
	}
	renamed = true
	if d, err := r.Open(path.Dir(wt.real)); err == nil { // que el rename sobreviva a un corte de luz
		_ = d.Sync()
		d.Close()
	}
	return n, nil
}

// Write es la escritura inline (editor): como máximo InlineMax bytes.
func (f *FS) Write(p string, data []byte) error {
	if len(data) > InlineMax {
		return fmt.Errorf("%w: %d bytes", ErrTooLarge, len(data))
	}
	_, err := f.WriteFrom(p, bytes.NewReader(data), int64(len(data)))
	return err
}

// chownLike copia uid/gid de ref. Sin privilegios falla con EPERM y se ignora: el fichero
// queda del usuario del agente, que es el mismo que el de la carpeta en ese caso.
func chownLike(fh *os.File, ref fs.FileInfo) {
	if st, ok := ref.Sys().(*syscall.Stat_t); ok {
		_ = fh.Chown(int(st.Uid), int(st.Gid))
	}
}

// Mkdir crea una carpeta (su padre debe existir) con el dueño de la carpeta padre.
func (f *FS) Mkdir(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	target, err := f.resolveEntry(rel)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	pi, err := r.Stat(path.Dir(target))
	if err != nil {
		return mapErr(err, path.Dir(rel))
	}
	if err := r.Mkdir(target, 0o755); err != nil {
		return mapErr(err, rel)
	}
	if st, ok := pi.Sys().(*syscall.Stat_t); ok {
		_ = r.Lchown(target, int(st.Uid), int(st.Gid))
	}
	return nil
}

// Rename mueve o renombra sin sobrescribir: si el destino existe devuelve ErrExists.
// Renombrar un enlace mueve el enlace, no su destino.
func (f *FS) Rename(from, to string) error {
	src, err := Clean(from)
	if err != nil {
		return err
	}
	dst, err := Clean(to)
	if err != nil {
		return err
	}
	s, err := f.resolveEntry(src)
	if err != nil {
		return err
	}
	d, err := f.resolveEntry(dst)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	if _, err := r.Lstat(s); err != nil {
		return mapErr(err, src)
	}
	if _, err := r.Lstat(d); err == nil {
		return fmt.Errorf("%w: %s", ErrExists, display(dst))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return mapErr(err, dst)
	}
	if err := r.Rename(s, d); err != nil {
		return mapErr(err, dst)
	}
	return nil
}

// Delete borra un fichero, un enlace (no su destino) o una carpeta con todo su contenido.
func (f *FS) Delete(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	target, err := f.resolveEntry(rel)
	if err != nil {
		return err
	}
	r, err := f.open()
	if err != nil {
		return err
	}
	defer r.Close()
	li, err := r.Lstat(target)
	if err != nil {
		return mapErr(err, rel)
	}
	if li.IsDir() {
		return mapErr(r.RemoveAll(target), rel)
	}
	return mapErr(r.Remove(target), rel)
}
