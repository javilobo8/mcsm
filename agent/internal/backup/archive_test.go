package backup

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// mustWrite crea p (y sus directorios) con body y permisos mode.
func mustWrite(t *testing.T, p, body string, mode fs.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil { // sin umask
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

type tarEntry struct {
	hdr  tar.Header
	body string
}

// makeArchive construye un tar.zst a mano (para probar entradas maliciosas).
func makeArchive(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	for _, e := range entries {
		h := e.hdr
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(e.body))
		}
		if h.Mode == 0 && h.Typeflag != tar.TypeXGlobalHeader { // la global solo admite PAXRecords
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if e.body != "" {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// assertEmpty comprueba que dir existe y no contiene nada (una extracción fallida no deja restos).
func assertEmpty(t *testing.T, dir string) {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(des) != 0 {
		names := make([]string, 0, len(des))
		for _, d := range des {
			names = append(names, d.Name())
		}
		t.Fatalf("%s debía quedar vacío; contiene %v", dir, names)
	}
}

func TestExcluder(t *testing.T) {
	e, err := NewExcluder([]string{"logs", "*.tmp", "world/session.lock", "cache/"})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]bool{
		"logs": true, "plugins/foo/logs": true, "a/b.tmp": true, "x.tmp": true,
		"world/session.lock": true, "other/session.lock": false, "cache": true,
		"cache2": false, "world/level.dat": false, "logs.txt": false,
	}
	for rel, want := range cases {
		if got := e.Excluded(rel); got != want {
			t.Errorf("Excluded(%q) = %v, want %v", rel, got, want)
		}
	}
	if _, err := NewExcluder([]string{"[abc"}); err == nil {
		t.Fatal("un patrón mal formado debe rechazarse")
	}
	if (*Excluder)(nil).Excluded("x") {
		t.Fatal("sin exclusiones no se excluye nada")
	}
	// m-l: un Excluder nil excluye igualmente los temporales de las subidas (WriteArchive(…, nil, …)).
	if !(*Excluder)(nil).Excluded("mods/.mcsm-tmp-0123456789abcdef") {
		t.Fatal("un Excluder nil debe excluir los temporales de las escrituras atómicas")
	}
}

// Los temporales de las escrituras atómicas de archivos (Plan 5) nunca entran en una copia,
// sin que el usuario tenga que excluirlos: una copia durante una subida metería el temporal a
// medias (hasta 4 GiB) y, al restaurarla, quedaría oculto e imposible de borrar desde la web.
func TestExcluderAlwaysSkipsUploadTemps(t *testing.T) {
	for _, patterns := range [][]string{nil, {"logs"}} {
		e, err := NewExcluder(patterns)
		if err != nil {
			t.Fatal(err)
		}
		for _, rel := range []string{".mcsm-tmp-0123456789abcdef", "plugins/foo/.mcsm-tmp-0123456789abcdef"} {
			if !e.Excluded(rel) {
				t.Errorf("%v: Excluded(%q) = false", patterns, rel)
			}
		}
		// Un fichero del usuario que solo empieza como un temporal sí entra (m-k).
		if e.Excluded("world/level.dat") || e.Excluded("mcsm-tmp-notas.txt") || e.Excluded(".mcsm-tmp-x") || e.Excluded("plugins/.mcsm-tmp-notas.txt") {
			t.Errorf("%v: excluye de más", patterns)
		}
	}
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "server.properties"), "motd=hola\n", 0o644)
	mustWrite(t, filepath.Join(src, "mods", ".mcsm-tmp-0123456789abcdef"), "a medias", 0o600)
	excl, err := NewExcluder(nil)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	st, err := WriteArchive(context.Background(), src, &buf, excl, nil)
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 1 {
		t.Fatalf("ficheros = %d; el temporal no debe copiarse", st.Files)
	}
	// Sin Excluder (nil), igual: ningún llamador futuro (migración) puede meter temporales.
	buf.Reset()
	if st, err = WriteArchive(context.Background(), src, &buf, nil, nil); err != nil || st.Files != 1 {
		t.Fatalf("WriteArchive sin Excluder: ficheros = %d, err = %v; el temporal no debe copiarse", st.Files, err)
	}
}

func TestArchiveRoundTrip(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "server.properties"), "motd=hola\n", 0o644)
	mustWrite(t, filepath.Join(src, "world", "level.dat"), "LEVEL", 0o640)
	mustWrite(t, filepath.Join(src, "world", "region", "r.0.0.mca"), strings.Repeat("x", 200_000), 0o644)
	mustWrite(t, filepath.Join(src, "world", "session.lock"), "lock", 0o644)
	mustWrite(t, filepath.Join(src, "logs", "latest.log"), "log", 0o644)
	mustWrite(t, filepath.Join(src, "plugins", "foo", "logs", "a.log"), "log anidado", 0o644)
	mustWrite(t, filepath.Join(src, "tmp", "file.tmp"), "tmp", 0o644)
	mustWrite(t, filepath.Join(src, "empty.txt"), "", 0o644)
	if err := os.Mkdir(filepath.Join(src, "emptydir"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(src, "emptydir"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("server.properties", filepath.Join(src, "link.properties")); err != nil {
		t.Fatal(err)
	}
	mtime := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(src, "world", "level.dat"), mtime, mtime); err != nil {
		t.Fatal(err)
	}

	excl, err := NewExcluder([]string{"logs", "*.tmp", "world/session.lock"})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	var lastDone, lastTotal int64
	st, err := WriteArchive(context.Background(), src, &buf, excl, func(d, tot int64) { lastDone, lastTotal = d, tot })
	if err != nil {
		t.Fatal(err)
	}
	wantBytes := int64(len("motd=hola\n") + len("LEVEL") + 200_000)
	if lastTotal != wantBytes || lastDone != wantBytes || st.Bytes != wantBytes {
		t.Fatalf("progreso %d/%d, bytes %d; esperaba %d", lastDone, lastTotal, st.Bytes, wantBytes)
	}
	if st.Files != 4 { // server.properties, level.dat, r.0.0.mca, empty.txt
		t.Fatalf("ficheros = %d", st.Files)
	}

	dst := filepath.Join(t.TempDir(), "out")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	var warns []string
	if err := ExtractArchive(context.Background(), &buf, dst, func(w string) { warns = append(warns, w) }); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dst, "world", "level.dat")) != "LEVEL" || len(mustRead(t, filepath.Join(dst, "world", "region", "r.0.0.mca"))) != 200_000 {
		t.Fatal("contenido distinto tras extraer")
	}
	for _, gone := range []string{"logs", "plugins/foo/logs", "tmp/file.tmp", "world/session.lock", "link.properties"} {
		if exists(filepath.Join(dst, gone)) {
			t.Errorf("%s no debía restaurarse", gone)
		}
	}
	if !exists(filepath.Join(dst, "tmp")) || !exists(filepath.Join(dst, "empty.txt")) {
		t.Fatal("el directorio tmp (vacío) y empty.txt deben existir")
	}
	if fi, _ := os.Stat(filepath.Join(dst, "world", "level.dat")); fi.Mode().Perm() != 0o640 || !fi.ModTime().Equal(mtime) {
		t.Fatalf("level.dat: modo %v, mtime %v", fi.Mode().Perm(), fi.ModTime())
	}
	if fi, _ := os.Stat(filepath.Join(dst, "emptydir")); fi.Mode().Perm() != 0o750 {
		t.Fatalf("emptydir: modo %v", fi.Mode().Perm())
	}
	if len(warns) != 1 || !strings.Contains(warns[0], "link.properties") {
		t.Fatalf("avisos = %v", warns)
	}
}

func TestWriteArchiveHeaders(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "world", "level.dat"), "L", 0o640)
	if err := os.Symlink("world/level.dat", filepath.Join(src, "lnk")); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := WriteArchive(context.Background(), src, &buf, nil, nil); err != nil {
		t.Fatal(err)
	}
	dec, err := zstd.NewReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	defer dec.Close()
	tr := tar.NewReader(dec)
	got := map[string]*tar.Header{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got[h.Name] = h
	}
	if len(got) != 3 {
		t.Fatalf("entradas = %v", got)
	}
	if h := got["world/"]; h == nil || h.Typeflag != tar.TypeDir {
		t.Fatalf("world/: %+v", h)
	}
	h := got["world/level.dat"]
	if h == nil || h.Typeflag != tar.TypeReg || h.Uid != os.Getuid() || h.Gid != os.Getgid() || h.Uname != "" || h.Mode&0o777 != 0o640 {
		t.Fatalf("world/level.dat: %+v", h)
	}
	if h := got["lnk"]; h == nil || h.Typeflag != tar.TypeSymlink || h.Linkname != "world/level.dat" {
		t.Fatalf("lnk: %+v", h)
	}
}

func TestExtractRejectsPathsOutsideDestination(t *testing.T) {
	for _, name := range []string{"../evil.txt", "a/../../evil.txt", "ABS", "a/../evil.txt"} {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			dst := filepath.Join(base, "dst")
			if err := os.Mkdir(dst, 0o755); err != nil {
				t.Fatal(err)
			}
			n := name
			if n == "ABS" {
				n = filepath.Join(base, "evil.txt") // ruta absoluta
			}
			data := makeArchive(t, []tarEntry{
				{hdr: tar.Header{Name: "ok.txt", Typeflag: tar.TypeReg}, body: "ok"},
				{hdr: tar.Header{Name: n, Typeflag: tar.TypeReg}, body: "pwned"},
			})
			err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil)
			if err == nil {
				t.Fatal("debe rechazar la copia")
			}
			if exists(filepath.Join(base, "evil.txt")) {
				t.Fatal("se escribió fuera del destino")
			}
			assertEmpty(t, dst) // ok.txt, ya extraído, se borra al rechazar la copia
		})
	}
}

func TestExtractNeverFollowsLinks(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	dst := filepath.Join(base, "dst")
	for _, d := range []string{outside, dst} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: outside}},
		{hdr: tar.Header{Name: "link/pwned.txt", Typeflag: tar.TypeReg}, body: "pwned"},
		{hdr: tar.Header{Name: "hard", Typeflag: tar.TypeLink, Linkname: "/etc/passwd"}},
	})
	var warns []string
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, func(w string) { warns = append(warns, w) }); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(outside, "pwned.txt")) {
		t.Fatal("se escribió a través de un enlace simbólico")
	}
	if fi, err := os.Lstat(filepath.Join(dst, "link")); err != nil || fi.Mode()&fs.ModeSymlink != 0 || !fi.IsDir() {
		t.Fatalf("link debe ser un directorio real dentro del destino: %v %v", fi, err)
	}
	if mustRead(t, filepath.Join(dst, "link", "pwned.txt")) != "pwned" || exists(filepath.Join(dst, "hard")) {
		t.Fatal("contenido inesperado")
	}
	if len(warns) != 2 {
		t.Fatalf("avisos = %v", warns)
	}
}

func TestExtractSkipsSpecialFiles(t *testing.T) {
	dst := t.TempDir()
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "pax_global_header", Typeflag: tar.TypeXGlobalHeader, PAXRecords: map[string]string{"comment": "git archive"}}}, // metadatos: se ignora sin avisar
		{hdr: tar.Header{Name: "fifo", Typeflag: tar.TypeFifo}},
		{hdr: tar.Header{Name: "null", Typeflag: tar.TypeChar, Devmajor: 1, Devminor: 3}},
		{hdr: tar.Header{Name: "sda", Typeflag: tar.TypeBlock, Devmajor: 8}},
		{hdr: tar.Header{Name: "ok.txt", Typeflag: tar.TypeReg}, body: "ok"},
	})
	var warns []string
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, func(w string) { warns = append(warns, w) }); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"fifo", "null", "sda"} {
		if exists(filepath.Join(dst, n)) {
			t.Errorf("%s no debía crearse", n)
		}
	}
	if mustRead(t, filepath.Join(dst, "ok.txt")) != "ok" || len(warns) != 3 {
		t.Fatalf("avisos = %v", warns)
	}
}

// Un tipo que archive/tar no trata como solo cabecera (GNU sparse, desconocidos…) conserva
// su Size y Next() descartaría ese contenido descomprimiéndolo entero, sin límite ni ctx.
func TestExtractRejectsUnsupportedTypeWithContent(t *testing.T) {
	const unknown = 'Z'
	cases := map[string]struct {
		body string
		lim  ExtractLimits
		want string
	}{
		"bomba de ceros": {strings.Repeat("\x00", 16<<20), ExtractLimits{MaxBytes: 1 << 20}, "límite"}, // 16 MiB que comprimen a nada
		"tipo con datos": {"x", ExtractLimits{}, "no admitido"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			enc, err := zstd.NewWriter(&buf)
			if err != nil {
				t.Fatal(err)
			}
			tw := tar.NewWriter(enc)
			if err := tw.WriteHeader(&tar.Header{Name: "raro", Typeflag: unknown, Mode: 0o644, Size: int64(len(c.body))}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte(c.body)); err != nil {
				t.Fatal(err)
			}
			if err := tw.WriteHeader(&tar.Header{Name: "ok.txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: 2}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte("ok")); err != nil {
				t.Fatal(err)
			}
			if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			if err := enc.Close(); err != nil {
				t.Fatal(err)
			}
			dst := t.TempDir()
			if err := ExtractArchiveLimits(context.Background(), &buf, dst, nil, c.lim); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v; esperaba %q", err, c.want)
			}
			assertEmpty(t, dst)
		})
	}
}

func TestExtractDropsSetuidSetgidSticky(t *testing.T) {
	dst := t.TempDir()
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o7755}},
		{hdr: tar.Header{Name: "bin/su", Typeflag: tar.TypeReg, Mode: 0o6755}, body: "#!/bin/sh\n"},
	})
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err != nil {
		t.Fatal(err)
	}
	const special = fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky
	for _, p := range []string{"bin", "bin/su"} {
		fi, err := os.Stat(filepath.Join(dst, p))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode()&special != 0 || fi.Mode().Perm() != 0o755 {
			t.Errorf("%s: modo %v", p, fi.Mode())
		}
	}
}

func TestExtractAcceptsDotSlashNames(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "dst")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	data := makeArchive(t, []tarEntry{ // como `tar -C data -c .`
		{hdr: tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0o700}},
		{hdr: tar.Header{Name: "./world/", Typeflag: tar.TypeDir, Mode: 0o755}},
		{hdr: tar.Header{Name: "./world//level.dat", Typeflag: tar.TypeReg}, body: "L"},
	})
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, filepath.Join(dst, "world", "level.dat")) != "L" {
		t.Fatal("contenido inesperado")
	}
	if fi, _ := os.Stat(dst); fi.Mode().Perm() != 0o755 {
		t.Fatalf("la entrada ./ no debe tocar el propio destino: %v", fi.Mode())
	}
}

func TestExtractLimits(t *testing.T) {
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "d/", Typeflag: tar.TypeDir, Mode: 0o755}},
		{hdr: tar.Header{Name: "d/a.txt", Typeflag: tar.TypeReg}, body: "123456"},
		{hdr: tar.Header{Name: "d/b.txt", Typeflag: tar.TypeReg}, body: "123456"},
	})
	for name, lim := range map[string]ExtractLimits{"bytes": {MaxBytes: 11}, "entradas": {MaxEntries: 2}} {
		t.Run(name, func(t *testing.T) {
			dst := t.TempDir()
			if err := ExtractArchiveLimits(context.Background(), bytes.NewReader(data), dst, nil, lim); err == nil {
				t.Fatal("debe superar el límite")
			}
			assertEmpty(t, dst)
		})
	}
	if err := ExtractArchiveLimits(context.Background(), bytes.NewReader(data), t.TempDir(), nil, ExtractLimits{MaxBytes: 12, MaxEntries: 3}); err != nil {
		t.Fatalf("justo en el límite se acepta: %v", err)
	}
}

func TestExtractRejectsHugeDeclaredSizeBeforeWriting(t *testing.T) {
	// Cabecera que anuncia 1 TiB sin el contenido detrás: el límite salta al leer la
	// cabecera, sin descomprimir ni escribir nada.
	var buf bytes.Buffer
	enc, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	if err := tw.WriteHeader(&tar.Header{Name: "bomb.bin", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1 << 40}); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	err = ExtractArchive(context.Background(), &buf, dst, nil)
	if err == nil || !strings.Contains(err.Error(), "límite") {
		t.Fatalf("err = %v", err)
	}
	assertEmpty(t, dst)
}

func TestExtractRequiresEmptyExistingDir(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "nuevo"}})
	dst := t.TempDir()
	mustWrite(t, filepath.Join(dst, "a.txt"), "previo", 0o644)
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
		t.Fatal("un destino con contenido debe rechazarse")
	}
	if mustRead(t, filepath.Join(dst, "a.txt")) != "previo" {
		t.Fatal("no debe tocar lo que ya había")
	}
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), filepath.Join(dst, "no-existe"), nil); err == nil {
		t.Fatal("un destino inexistente debe rechazarse")
	}
}

func TestExtractCorruptArchive(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: strings.Repeat("a", 100_000)}})
	dst := t.TempDir()
	err := ExtractArchive(context.Background(), bytes.NewReader(data[:len(data)/2]), dst, nil)
	if err == nil {
		t.Fatal("una copia truncada debe dar error")
	}
	assertEmpty(t, dst) // el fichero a medias se borra
}

func TestExtractRejectsEmptyOrUnterminated(t *testing.T) {
	// Trama zstd completa con un tar sin sus bloques finales (cortado en el límite de una
	// entrada, como si tar hubiera muerto a mitad): archive/tar lo daría por terminado.
	var cut bytes.Buffer
	enc, err := zstd.NewWriter(&cut)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	if err := tw.WriteHeader(&tar.Header{Name: "a.txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"vacía": nil, "sin final": cut.Bytes()} {
		dst := t.TempDir()
		if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
			t.Errorf("%s: debe rechazarse", name)
		}
		assertEmpty(t, dst)
	}
}

func TestExtractVerifiesZstdChecksum(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "contenido"}})
	data[len(data)-1] ^= 0xff // la suma de la trama ocupa los últimos 4 bytes
	dst := t.TempDir()
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
		t.Fatal("una suma de verificación incorrecta debe dar error")
	}
	assertEmpty(t, dst)
}

func TestExtractReadsTheWholeStream(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "a"}})
	data = append(data, "basura tras la trama"...)
	dst := t.TempDir()
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, nil); err == nil {
		t.Fatal("los datos tras el final deben leerse y rechazarse")
	}
	assertEmpty(t, dst)
}

func TestExtractCancelled(t *testing.T) {
	data := makeArchive(t, []tarEntry{{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "a"}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dst := t.TempDir()
	if err := ExtractArchive(ctx, bytes.NewReader(data), dst, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	assertEmpty(t, dst)
}

func TestExtractRestoresOwnerAsRoot(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	if uid != 0 { // sin root se simula: chown al propio usuario funciona, a otro falla
		old := geteuid
		geteuid = func() int { return 0 }
		t.Cleanup(func() { geteuid = old })
	}
	owner := uid
	if uid == 0 {
		owner = 1000 // uid de la imagen itzg
	}
	data := makeArchive(t, []tarEntry{
		{hdr: tar.Header{Name: "world/", Typeflag: tar.TypeDir, Mode: 0o755, Uid: owner, Gid: gid}},
		{hdr: tar.Header{Name: "world/level.dat", Typeflag: tar.TypeReg, Uid: owner, Gid: gid}, body: "L"},
	})
	dst := t.TempDir()
	var warns []string
	if err := ExtractArchive(context.Background(), bytes.NewReader(data), dst, func(w string) { warns = append(warns, w) }); err != nil || len(warns) != 0 {
		t.Fatalf("err = %v, avisos = %v", err, warns)
	}
	for _, p := range []string{"world", "world/level.dat"} {
		fi, err := os.Lstat(filepath.Join(dst, p))
		if err != nil {
			t.Fatal(err)
		}
		if st := fi.Sys().(*syscall.Stat_t); int(st.Uid) != owner {
			t.Errorf("%s: uid %d, esperaba %d", p, st.Uid, owner)
		}
	}
	if uid == 0 {
		return
	}
	// Sin privilegios, el chown a root (uid 0) falla: prueba que se intenta en ficheros y en
	// directorios, que se avisa una sola vez y que la extracción sigue.
	for name, entries := range map[string][]tarEntry{
		"ficheros": {
			{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "a"},
			{hdr: tar.Header{Name: "b.txt", Typeflag: tar.TypeReg}, body: "b"},
		},
		"directorio": {{hdr: tar.Header{Name: "d/", Typeflag: tar.TypeDir, Mode: 0o755}}},
	} {
		dst := t.TempDir()
		var warns []string
		if err := ExtractArchive(context.Background(), bytes.NewReader(makeArchive(t, entries)), dst, func(w string) { warns = append(warns, w) }); err != nil {
			t.Fatal(err)
		}
		if len(warns) != 1 || !strings.Contains(warns[0], "propietario") || !exists(filepath.Join(dst, strings.TrimSuffix(entries[0].hdr.Name, "/"))) {
			t.Fatalf("%s: avisos = %v", name, warns)
		}
	}
}

// failingReader entrega body y después falla, como un tar cortado a mitad de un fichero.
type failingReader struct{ body *strings.Reader }

func (f failingReader) Read(p []byte) (int, error) {
	if f.body.Len() == 0 {
		return 0, io.ErrUnexpectedEOF
	}
	return f.body.Read(p)
}

func TestExtractFileRemovesPartialOnError(t *testing.T) {
	dst := t.TempDir()
	root, err := os.OpenRoot(dst)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	x := &extractor{ctx: context.Background(), root: root, warn: func(string) {}, buf: make([]byte, 4)}
	hdr := &tar.Header{Name: "a.txt", Typeflag: tar.TypeReg, Size: 100}
	if err := x.file("a.txt", failingReader{strings.NewReader("mitad")}, hdr, 0o644); err == nil {
		t.Fatal("debe fallar")
	}
	assertEmpty(t, dst)
}

func TestWriteArchiveCancelled(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "a.txt"), "a", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := WriteArchive(ctx, src, io.Discard, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

// Una copia cancelada a mitad no debe quedar como un tar.zst válido con solo una parte.
func TestWriteArchiveCancelledMidwayIsUnreadable(t *testing.T) {
	src := t.TempDir()
	mustWrite(t, filepath.Join(src, "a.txt"), "a", 0o644)
	mustWrite(t, filepath.Join(src, "b.txt"), "b", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var buf bytes.Buffer
	if _, err := WriteArchive(ctx, src, &buf, nil, func(done, _ int64) {
		if done > 0 {
			cancel() // tras el primer fichero
		}
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if err := ExtractArchive(context.Background(), &buf, t.TempDir(), nil); err == nil {
		t.Fatal("la salida de una copia cancelada debe ser ilegible")
	}
}

// failingWriter acepta n bytes y luego falla (disco lleno, panel desconectado…).
type failingWriter struct{ n int }

func (f *failingWriter) Write(p []byte) (int, error) {
	if len(p) > f.n {
		k := f.n
		f.n = 0
		return k, errors.New("no queda espacio")
	}
	f.n -= len(p)
	return len(p), nil
}

func TestWriteArchiveWriterError(t *testing.T) {
	src := t.TempDir()
	noise := make([]byte, 1<<20) // incompresible: el compresor escribe antes del final
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range noise {
		noise[i] = byte(rng.Uint32())
	}
	mustWrite(t, filepath.Join(src, "a.bin"), string(noise), 0o644)
	mustWrite(t, filepath.Join(src, "b.bin"), string(noise), 0o644)
	if _, err := WriteArchive(context.Background(), src, &failingWriter{n: 4096}, nil, nil); err == nil {
		t.Fatal("el error del destino debe propagarse")
	}
}

func TestWriteEntryPadsShrunkFileAndTruncatesGrown(t *testing.T) {
	dir := t.TempDir()
	shrunk, grown := filepath.Join(dir, "shrunk.log"), filepath.Join(dir, "grown.log")
	mustWrite(t, shrunk, "0123456789", 0o644)
	mustWrite(t, grown, "0123456789", 0o644)
	si, _ := os.Lstat(shrunk)
	gi, _ := os.Lstat(grown)
	mustWrite(t, shrunk, "0123", 0o644)                // encoge tras el escaneo
	mustWrite(t, grown, "0123456789ABCDEFGHIJ", 0o644) // crece tras el escaneo
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ctx := context.Background()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	n, skipped, warn, err := writeEntry(ctx, tw, root, entry{rel: "shrunk.log", info: si}, make([]byte, 64))
	if err != nil || skipped || n != 10 || !strings.Contains(warn, "cambió") {
		t.Fatalf("shrunk: n=%d skipped=%v warn=%q err=%v", n, skipped, warn, err)
	}
	n, _, warn, err = writeEntry(ctx, tw, root, entry{rel: "grown.log", info: gi}, make([]byte, 64))
	if err != nil || n != 10 || warn != "" {
		t.Fatalf("grown: n=%d warn=%q err=%v", n, warn, err)
	}
	if _, _, warn, _ = writeEntry(ctx, tw, root, entry{rel: "gone.log", info: si}, make([]byte, 64)); !strings.Contains(warn, "borró") {
		t.Fatalf("gone: warn=%q", warn)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(&buf)
	want := []string{"0123\x00\x00\x00\x00\x00\x00", "0123456789"}
	for _, w := range want {
		if _, err := tr.Next(); err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		if string(body) != w {
			t.Fatalf("contenido %q, esperaba %q", body, w)
		}
	}
}

// Un proceso del contenedor cambia un directorio por un enlace a fuera entre el escaneo y
// la lectura: el agente (root) nunca debe leer ficheros del anfitrión a través de él.
func TestWriteEntryNeverReadsOutsideSource(t *testing.T) {
	for _, target := range []string{"ABS", "../outside"} {
		t.Run(target, func(t *testing.T) {
			base := t.TempDir()
			src, outside := filepath.Join(base, "src"), filepath.Join(base, "outside")
			mustWrite(t, filepath.Join(outside, "secret"), "SECRETO", 0o644)
			mustWrite(t, filepath.Join(src, "world", "secret"), "publico", 0o644)
			info, err := os.Lstat(filepath.Join(src, "world", "secret"))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.RemoveAll(filepath.Join(src, "world")); err != nil {
				t.Fatal(err)
			}
			link := target
			if link == "ABS" {
				link = outside
			}
			if err := os.Symlink(link, filepath.Join(src, "world")); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(src)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			var buf bytes.Buffer
			tw := tar.NewWriter(&buf)
			if _, _, _, err := writeEntry(context.Background(), tw, root, entry{rel: "world/secret", info: info}, make([]byte, 64)); err == nil {
				t.Fatal("debe fallar en vez de seguir el enlace")
			}
			if strings.Contains(buf.String(), "SECRETO") {
				t.Fatal("se leyó un fichero de fuera de los datos")
			}
		})
	}
}

// Una FIFO colada en lugar de un fichero no puede bloquear la copia (con save-off activo).
func TestWriteEntrySkipsFifoSwappedIn(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x.dat")
	mustWrite(t, p, "data", 0o644)
	info, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(p, 0o644); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	type result struct {
		skipped bool
		warn    string
		err     error
	}
	done := make(chan result, 1)
	go func() {
		_, skipped, warn, err := writeEntry(context.Background(), tar.NewWriter(io.Discard), root, entry{rel: "x.dat", info: info}, make([]byte, 64))
		done <- result{skipped, warn, err}
	}()
	select {
	case r := <-done:
		if r.err != nil || !r.skipped || !strings.Contains(r.warn, "x.dat") {
			t.Fatalf("resultado = %+v", r)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("writeEntry se bloqueó abriendo una FIFO")
	}
}

// Si un directorio deja de serlo entre el listado de su padre y su apertura (fichero, FIFO,
// enlace a fuera o a otro directorio de dentro), se omite su contenido con aviso en vez de
// abortar la copia o listar otra cosa bajo su nombre.
func TestReadDirInDetectsDirectoryThatChanged(t *testing.T) {
	for _, swap := range []string{"fichero", "fifo", "enlace fuera", "enlace dentro", "borrado", "igual"} {
		t.Run(swap, func(t *testing.T) {
			base := t.TempDir()
			src := filepath.Join(base, "src")
			mustWrite(t, filepath.Join(src, "d", "x.txt"), "x", 0o644)
			mustWrite(t, filepath.Join(src, "otro", "y.txt"), "y", 0o644)
			mustWrite(t, filepath.Join(base, "fuera", "z.txt"), "z", 0o644)
			d := filepath.Join(src, "d")
			want, err := os.Lstat(d)
			if err != nil {
				t.Fatal(err)
			}
			if swap != "igual" {
				if err := os.RemoveAll(d); err != nil {
					t.Fatal(err)
				}
			}
			switch swap {
			case "fichero":
				mustWrite(t, d, "ya no es un directorio", 0o644)
			case "fifo":
				err = syscall.Mkfifo(d, 0o644)
			case "enlace fuera":
				err = os.Symlink("../fuera", d)
			case "enlace dentro":
				err = os.Symlink("otro", d)
			}
			if err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(src)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			des, changed, err := readDirIn(root, "d", want)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			switch swap {
			case "igual":
				if changed || len(des) != 1 || des[0].Name() != "x.txt" {
					t.Fatalf("des = %v, changed = %v", des, changed)
				}
			case "borrado":
				if changed || len(des) != 0 {
					t.Fatalf("des = %v, changed = %v", des, changed)
				}
			default:
				if !changed || len(des) != 0 {
					t.Fatalf("des = %v, changed = %v", des, changed)
				}
			}
		})
	}
}
