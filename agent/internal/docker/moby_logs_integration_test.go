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
			Cmd: []string{"sh", "-c", "echo uno; echo dos >&2; echo tres; sleep 300"}},
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
}
