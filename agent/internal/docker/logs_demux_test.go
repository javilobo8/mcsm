package docker

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
)

// Logs sin TTY (9f2d104): Docker multiplexa stdout y stderr con una cabecera de 8 bytes por trama y
// demuxLogs los junta en un flujo de texto. Sin Docker: el stream de Docker es un io.Pipe.

// frame escribe s como una trama de Docker del flujo std (cabecera: flujo, 3 ceros y el tamaño en
// big endian), de una vez; vuelve cuando la goroutine de StdCopy la ha leído (io.Pipe no tiene buffer).
func frame(t *testing.T, w io.Writer, std stdcopy.StdType, s string) {
	t.Helper()
	b := make([]byte, 8, 8+len(s))
	b[0] = byte(std)
	binary.BigEndian.PutUint32(b[4:], uint32(len(s)))
	if _, err := w.Write(append(b, s...)); err != nil {
		t.Fatal(err)
	}
}

func waitDone(t *testing.T, d *demuxedLogs) {
	t.Helper()
	select {
	case <-d.done:
	case <-time.After(5 * time.Second):
		t.Fatal("la goroutine de StdCopy no terminó")
	}
}

// En streaming: cada línea llega al lector antes de que Docker mande la siguiente, sin cabeceras y
// con stdout y stderr en el mismo flujo; el EOF del stream de Docker es el EOF del lector.
func TestDemuxLogsStreamsStdoutAndStderr(t *testing.T) {
	src, docker := io.Pipe()
	d := demuxLogs(src)
	br := bufio.NewReader(d)
	for _, l := range []struct {
		std  stdcopy.StdType
		text string
	}{{stdcopy.Stdout, "2026-10-12T10:00:00.000000001Z uno\n"}, {stdcopy.Stderr, "2026-10-12T10:00:00.000000002Z dos\n"}, {stdcopy.Stdout, "2026-10-12T10:00:00.000000003Z tres\n"}} {
		frame(t, docker, l.std, l.text)
		got, err := br.ReadString('\n')
		if err != nil || got != l.text {
			t.Fatalf("línea = %q, %v; quiero %q", got, err, l.text)
		}
	}
	_ = docker.Close()
	if rest, err := io.ReadAll(br); err != nil || len(rest) != 0 {
		t.Fatalf("tras el EOF de Docker: %q, %v", rest, err)
	}
	waitDone(t, d)
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
}

// Un error del stream de Docker (conexión caída, contexto cancelado) o del daemon (trama Systemerr)
// llega al lector como error, no como un EOF limpio.
func TestDemuxLogsPropagatesErrors(t *testing.T) {
	src, docker := io.Pipe()
	d := demuxLogs(src)
	lost := errors.New("conexión perdida")
	_ = docker.CloseWithError(lost)
	if _, err := io.ReadAll(d); !errors.Is(err, lost) {
		t.Fatalf("err = %v", err)
	}
	waitDone(t, d)

	src, docker = io.Pipe()
	d = demuxLogs(src)
	frame(t, docker, stdcopy.Systemerr, "fallo del daemon")
	if _, err := io.ReadAll(d); err == nil || !strings.Contains(err.Error(), "fallo del daemon") {
		t.Fatalf("err = %v", err)
	}
	waitDone(t, d)
	_ = d.Close()
}

// Close termina la goroutine tanto si espera a que el lector lea (nadie lee la trama ya separada)
// como si espera a Docker (sin logs nuevos), y cierra el stream de Docker. Es idempotente y se puede
// llamar a la vez desde dos goroutines (el follower de logs lo hace: defer y cancelación).
func TestDemuxLogsCloseEndsGoroutine(t *testing.T) {
	t.Run("esperando al lector", func(t *testing.T) {
		src, docker := io.Pipe()
		d := demuxLogs(src)
		frame(t, docker, stdcopy.Stdout, "nadie la lee\n") // StdCopy la leyó y espera para escribirla
		_ = d.Close()
		waitDone(t, d)
		if _, err := docker.Write([]byte("x")); !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("el stream de Docker debe quedar cerrado: %v", err)
		}
	})
	t.Run("esperando a Docker", func(t *testing.T) {
		src, docker := io.Pipe()
		d := demuxLogs(src)
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() { defer wg.Done(); _ = d.Close() }()
		}
		wg.Wait()
		waitDone(t, d)
		if _, err := docker.Write([]byte("x")); !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("el stream de Docker debe quedar cerrado: %v", err)
		}
		if _, err := d.Read(make([]byte, 1)); err == nil {
			t.Fatal("leer tras Close debe fallar")
		}
	})
}
