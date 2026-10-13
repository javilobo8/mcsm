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

// A container without a TTY (Compose ones, e.g. an imported server still adopted) has its logs
// multiplexed by Docker (8-byte header per frame): Logs must return only the text, with
// each line starting with its timestamp, just as with a TTY.
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
			// "four" waits for /tmp/go-on to exist: it arrives in streaming, with the follow already open.
			Cmd: []string{"sh", "-c", "echo one; echo two >&2; echo three; while [ ! -e /tmp/go-on ]; do sleep 0.1; done; echo four >&2; sleep 300"}},
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
			t.Fatalf("line without timestamp: %q", line)
		}
		if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
			t.Fatalf("the line does not start with the timestamp (multiplexing header?): %q", line)
		}
		got = append(got, msg)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	if want := []string{"one", "three", "two"}; !slices.Equal(got, want) {
		t.Fatalf("lines = %q, want %q (stdout and stderr, without headers)", got, want)
	}
	// Live follow: a new stderr line arrives separated and with its timestamp.
	ex, err := m.cli.ExecCreate(ctx, id, client.ExecCreateOptions{Cmd: []string{"touch", "/tmp/go-on"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.cli.ExecStart(ctx, ex.ID, client.ExecStartOptions{Detach: true}); err != nil {
		t.Fatal(err)
	}
	if !sc.Scan() {
		t.Fatalf("the live line did not arrive: %v", sc.Err())
	}
	if ts, msg, _ := strings.Cut(sc.Text(), " "); msg != "four" {
		t.Fatalf("live line = %q", sc.Text())
	} else if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
		t.Fatalf("live line without timestamp: %q", sc.Text())
	}
	// Close cuts the follow: the pending read ends (no dangling goroutines).
	done := make(chan error, 1)
	go func() { _, err := rc.Read(make([]byte, 1)); done <- err }()
	if err := rc.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("reading after Close must fail")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close did not cut the read")
	}
	if d, ok := rc.(*demuxedLogs); !ok {
		t.Fatalf("without a TTY Logs returns the separated stream: %T", rc)
	} else {
		select {
		case <-d.done:
		case <-time.After(10 * time.Second):
			t.Fatal("the StdCopy goroutine did not finish after Close")
		}
	}
}
