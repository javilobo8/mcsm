//go:build integration

package docker

import (
	"bufio"
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

// Un contenedor sin TTY (los de Compose, p. ej. un servidor importado aún adoptado) tiene los logs
// multiplexados por Docker (cabecera de 8 bytes por trama): Logs debe devolver solo el texto, con
// cada línea empezando por su marca de tiempo, igual que con TTY.
func TestMobyLogsWithoutTTY(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	const name = "mcsm-test-logs-notty"
	_, _ = m.cli.ContainerRemove(ctx, name, client.ContainerRemoveOptions{Force: true})
	id, err := m.Create(ctx, name,
		&container.Config{Image: "alpine:3.22", Tty: false, Labels: map[string]string{"mcsm.test": "true"},
			// «cuatro» espera a que exista /tmp/sigue: llega en streaming, con el seguimiento ya abierto.
			Cmd: []string{"sh", "-c", "echo uno; echo dos >&2; echo tres; while [ ! -e /tmp/sigue ]; do sleep 0.1; done; echo cuatro >&2; sleep 300"}},
		&container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	rc, err := m.Logs(ctx, id, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	sc := bufio.NewScanner(rc)
	var got []string
	for len(got) < 3 && sc.Scan() {
		line := sc.Text()
		ts, msg, ok := strings.Cut(line, " ")
		if !ok {
			t.Fatalf("línea sin marca de tiempo: %q", line)
		}
		if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
			t.Fatalf("la línea no empieza por la marca de tiempo (¿cabecera del multiplexado?): %q", line)
		}
		got = append(got, msg)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	if want := []string{"dos", "tres", "uno"}; !slices.Equal(got, want) {
		t.Fatalf("líneas = %q, quiero %q (stdout y stderr, sin cabeceras)", got, want)
	}
	// Seguimiento en vivo: una línea nueva de stderr llega separada y con su marca de tiempo.
	ex, err := m.cli.ExecCreate(ctx, id, client.ExecCreateOptions{Cmd: []string{"touch", "/tmp/sigue"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.cli.ExecStart(ctx, ex.ID, client.ExecStartOptions{Detach: true}); err != nil {
		t.Fatal(err)
	}
	if !sc.Scan() {
		t.Fatalf("no llegó la línea en vivo: %v", sc.Err())
	}
	if ts, msg, _ := strings.Cut(sc.Text(), " "); msg != "cuatro" {
		t.Fatalf("línea en vivo = %q", sc.Text())
	} else if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
		t.Fatalf("línea en vivo sin marca de tiempo: %q", sc.Text())
	}
	// Close corta el seguimiento: la lectura pendiente termina (sin goroutines colgadas).
	done := make(chan error, 1)
	go func() { _, err := rc.Read(make([]byte, 1)); done <- err }()
	if err := rc.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("leer tras Close debe fallar")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close no cortó la lectura")
	}
	if d, ok := rc.(*demuxedLogs); !ok {
		t.Fatalf("sin TTY Logs devuelve el flujo separado: %T", rc)
	} else {
		select {
		case <-d.done:
		case <-time.After(10 * time.Second):
			t.Fatal("la goroutine de StdCopy no terminó tras Close")
		}
	}
}
