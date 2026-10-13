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

// Logs without TTY (9f2d104): Docker multiplexes stdout and stderr with an 8-byte header per frame and
// demuxLogs joins them into a text stream. Without Docker: the Docker stream is an io.Pipe.

// frame writes s as a Docker frame of the std stream (header: stream, 3 zeros and the size in
// big endian), in one go; it returns when the StdCopy goroutine has read it (io.Pipe has no buffer).
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
		t.Fatal("the StdCopy goroutine did not finish")
	}
}

// Streaming: each line reaches the reader before Docker sends the next one, without headers and
// with stdout and stderr in the same stream; the EOF of Docker's stream is the reader's EOF.
func TestDemuxLogsStreamsStdoutAndStderr(t *testing.T) {
	src, docker := io.Pipe()
	d := demuxLogs(src)
	br := bufio.NewReader(d)
	for _, l := range []struct {
		std  stdcopy.StdType
		text string
	}{{stdcopy.Stdout, "2026-10-12T10:00:00.000000001Z one\n"}, {stdcopy.Stderr, "2026-10-12T10:00:00.000000002Z two\n"}, {stdcopy.Stdout, "2026-10-12T10:00:00.000000003Z three\n"}} {
		frame(t, docker, l.std, l.text)
		got, err := br.ReadString('\n')
		if err != nil || got != l.text {
			t.Fatalf("line = %q, %v; want %q", got, err, l.text)
		}
	}
	_ = docker.Close()
	if rest, err := io.ReadAll(br); err != nil || len(rest) != 0 {
		t.Fatalf("after Docker's EOF: %q, %v", rest, err)
	}
	waitDone(t, d)
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
}

// An error from Docker's stream (dropped connection, cancelled context) or from the daemon (Systemerr frame)
// reaches the reader as an error, not as a clean EOF.
func TestDemuxLogsPropagatesErrors(t *testing.T) {
	src, docker := io.Pipe()
	d := demuxLogs(src)
	lost := errors.New("connection lost")
	_ = docker.CloseWithError(lost)
	if _, err := io.ReadAll(d); !errors.Is(err, lost) {
		t.Fatalf("err = %v", err)
	}
	waitDone(t, d)

	src, docker = io.Pipe()
	d = demuxLogs(src)
	frame(t, docker, stdcopy.Systemerr, "daemon failure")
	if _, err := io.ReadAll(d); err == nil || !strings.Contains(err.Error(), "daemon failure") {
		t.Fatalf("err = %v", err)
	}
	waitDone(t, d)
	_ = d.Close()
}

// Close ends the goroutine whether it is waiting for the reader to read (nobody reads the already separated frame)
// or waiting for Docker (no new logs), and closes Docker's stream. It is idempotent and can be
// called at the same time from two goroutines (the log follower does: defer and cancellation).
func TestDemuxLogsCloseEndsGoroutine(t *testing.T) {
	t.Run("waiting for the reader", func(t *testing.T) {
		src, docker := io.Pipe()
		d := demuxLogs(src)
		frame(t, docker, stdcopy.Stdout, "nobody reads it\n") // StdCopy read it and waits to write it
		_ = d.Close()
		waitDone(t, d)
		if _, err := docker.Write([]byte("x")); !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("Docker's stream must be left closed: %v", err)
		}
	})
	t.Run("waiting for Docker", func(t *testing.T) {
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
			t.Fatalf("Docker's stream must be left closed: %v", err)
		}
		if _, err := d.Read(make([]byte, 1)); err == nil {
			t.Fatal("reading after Close must fail")
		}
	})
}
