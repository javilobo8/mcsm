package conn

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

var tid = strings.Repeat("A", 40) + "b_-"

// transferPanel simulates the panel's /agent/transfer/{id} and checks the token.
func transferPanel(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/agent/transfer/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		h(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestTransferGet(t *testing.T) {
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.PathValue("id") != tid {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", "5")
		_, _ = w.Write([]byte("hola!"))
	})
	body, size, err := NewTransferClient(srv.URL+"/", "tok").Get(context.Background(), tid)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	data, _ := io.ReadAll(body)
	if string(data) != "hola!" || size != 5 {
		t.Fatalf("data=%q size=%d", data, size)
	}
}

// closeTracker records whether anyone closed the body.
type closeTracker struct {
	io.Reader
	closed atomic.Bool
}

func (c *closeTracker) Close() error { c.closed.Store(true); return nil }

func TestTransferPut(t *testing.T) {
	var got []byte
	var gotLen int64
	var gotType string
	var chunked bool
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		gotLen, gotType = r.ContentLength, r.Header.Get("Content-Type")
		chunked = len(r.TransferEncoding) > 0
		w.WriteHeader(http.StatusNoContent)
	})
	c := NewTransferClient(srv.URL, "tok")
	src := &closeTracker{Reader: bytes.NewReader([]byte("hello"))}
	if err := c.Put(context.Background(), tid, src, 5); err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" || gotLen != 5 || gotType != "application/octet-stream" || chunked {
		t.Fatalf("got=%q len=%d type=%q chunked=%v", got, gotLen, gotType, chunked)
	}
	if src.closed.Load() {
		t.Fatal("Put must not close the caller's body")
	}
	// empty file: explicit Content-Length 0, not chunked
	if err := c.Put(context.Background(), tid, strings.NewReader(""), 0); err != nil {
		t.Fatal(err)
	}
	if gotLen != 0 || chunked {
		t.Fatalf("empty: len=%d chunked=%v", gotLen, chunked)
	}
	// unknown size: chunked
	src = &closeTracker{Reader: strings.NewReader("abc")}
	if err := c.Put(context.Background(), tid, src, -1); err != nil {
		t.Fatal(err)
	}
	if !chunked || string(got) != "abc" || src.closed.Load() {
		t.Fatalf("unknown: chunked=%v got=%q closed=%v", chunked, got, src.closed.Load())
	}
}

func TestTransferPutShortBodyFails(t *testing.T) {
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	})
	// the file shrank: it announces 10 bytes and there are only 3
	if err := NewTransferClient(srv.URL, "tok").Put(context.Background(), tid, strings.NewReader("abc"), 10); err == nil {
		t.Fatal("a body shorter than Content-Length must fail")
	}
}

// pattern generates deterministic, endless bytes without reserving memory.
type pattern struct{ off int }

var patternBlock = func() []byte {
	b := make([]byte, 64<<10+251)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}()

func (p *pattern) Read(b []byte) (int, error) {
	n := copy(b, patternBlock[p.off%251:])
	p.off += n
	return n, nil
}

// counting counts the bytes read (from net/http's write goroutine).
type counting struct {
	r io.Reader
	n atomic.Int64
}

func (c *counting) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

func TestTransferPutLongBodyFailsWithoutDrainingIt(t *testing.T) {
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	})
	// the file grew: it announces 5 bytes and there are 4 MiB. net/http would read the rest in full to
	// discard it (with an endless source, forever); it is cut at size+1.
	src := &counting{r: io.LimitReader(&pattern{}, 4<<20)}
	if err := NewTransferClient(srv.URL, "tok").Put(context.Background(), tid, src, 5); err == nil {
		t.Fatal("a body longer than Content-Length must fail")
	}
	if n := src.n.Load(); n > 6 {
		t.Fatalf("%d bytes were read from a body announced as 5", n)
	}
}

func TestTransferErrors(t *testing.T) {
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("id") {
		case tid:
			http.Error(w, `{"error":"Internal error"}`, http.StatusInternalServerError)
		case strings.Repeat("f", 43):
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		case strings.Repeat("p", 43):
			http.Error(w, "<html>broken proxy</html>", http.StatusBadGateway)
		default:
			http.NotFound(w, r)
		}
	})
	c := NewTransferClient(srv.URL, "tok")
	other := strings.Repeat("z", 43)
	if _, _, err := c.Get(context.Background(), other); !errors.Is(err, ErrTransferNotFound) {
		t.Fatalf("404 = %v", err)
	}
	if err := c.Put(context.Background(), other, strings.NewReader("x"), 1); !errors.Is(err, ErrTransferNotFound) {
		t.Fatalf("PUT 404 = %v", err)
	}
	if _, _, err := c.Get(context.Background(), tid); err == nil || !strings.Contains(err.Error(), "500") || !strings.Contains(err.Error(), "Internal error") {
		t.Fatalf("500 = %v", err)
	}
	if _, _, err := NewTransferClient(srv.URL, "other").Get(context.Background(), tid); err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "token") {
		t.Fatalf("bad token = %v", err)
	}
	if _, _, err := c.Get(context.Background(), strings.Repeat("f", 43)); err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "token") {
		t.Fatalf("403 = %v", err)
	}
	// a body that is not the panel's JSON does not end up in the message
	if _, _, err := c.Get(context.Background(), strings.Repeat("p", 43)); err == nil || !strings.Contains(err.Error(), "502") || strings.Contains(err.Error(), "html") {
		t.Fatalf("502 = %v", err)
	}
	for _, bad := range []string{"", "../ws", "short", strings.Repeat("a", 42) + "/", strings.Repeat("a", 42) + "\n"} {
		if _, _, err := c.Get(context.Background(), bad); err == nil || !strings.Contains(err.Error(), "invalid transfer_id") {
			t.Fatalf("id %q = %v", bad, err)
		}
		if err := c.Put(context.Background(), bad, strings.NewReader(""), 0); err == nil || !strings.Contains(err.Error(), "invalid transfer_id") {
			t.Fatalf("PUT id %q = %v", bad, err)
		}
	}
}

func TestTransferNeverLeaksToken(t *testing.T) {
	const secret = "s3cr3t-node-token-xyz"
	mux := http.NewServeMux()
	mux.HandleFunc("/agent/transfer/{id}", func(w http.ResponseWriter, r *http.Request) {
		// a panel (or proxy) that returns the header in the error
		http.Error(w, `{"error":"rejected: `+r.Header.Get("Authorization")+`"}`, http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := NewTransferClient(srv.URL, secret)
	_, _, err := c.Get(context.Background(), tid)
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("GET = %v", err)
	}
	if err := c.Put(context.Background(), tid, strings.NewReader("x"), 1); err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("PUT = %v", err)
	}
	// panel down: the network error does not carry the token either
	srv.Close()
	if _, _, err := c.Get(context.Background(), tid); err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("GET without panel = %v", err)
	}
}

func TestTransferDoesNotFollowRedirects(t *testing.T) {
	var followed atomic.Bool
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/other", http.StatusFound)
	})
	srv.Config.Handler.(*http.ServeMux).HandleFunc("/other", func(w http.ResponseWriter, r *http.Request) {
		followed.Store(true)
	})
	c := NewTransferClient(srv.URL, "tok")
	// a 302 would turn the PUT into a body-less GET that would "work"
	if err := c.Put(context.Background(), tid, strings.NewReader("hello"), 5); err == nil || !strings.Contains(err.Error(), "302") {
		t.Fatalf("PUT redirigido = %v", err)
	}
	if _, _, err := c.Get(context.Background(), tid); err == nil || !strings.Contains(err.Error(), "302") {
		t.Fatalf("GET redirigido = %v", err)
	}
	if followed.Load() {
		t.Fatal("redirects must not be followed")
	}
}

// rawResponse answers by hand (hijacking the connection) to simulate a panel that lies
// about Content-Length.
func rawResponse(raw string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			panic(err)
		}
		defer conn.Close()
		_, _ = buf.WriteString(raw)
		_ = buf.Flush()
	}
}

func TestTransferGetEnforcesContentLength(t *testing.T) {
	short := transferPanel(t, rawResponse("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"))
	body, size, err := NewTransferClient(short.URL, "tok").Get(context.Background(), tid)
	if err != nil || size != 10 {
		t.Fatalf("size=%d err=%v", size, err)
	}
	if _, err := io.ReadAll(body); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short body: err = %v", err)
	}
	body.Close()

	long := transferPanel(t, rawResponse("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdefghij"))
	body, size, err = NewTransferClient(long.URL, "tok").Get(context.Background(), tid)
	if err != nil || size != 3 {
		t.Fatalf("size=%d err=%v", size, err)
	}
	defer body.Close()
	if data, err := io.ReadAll(body); err != nil || string(data) != "abc" {
		t.Fatalf("long body: data=%q err=%v; only the announced bytes are read", data, err)
	}
}

func TestTransferGetReturnsRawBytes(t *testing.T) {
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(bytes.Repeat([]byte("a"), 1<<20))
	_ = zw.Close()
	var acceptEnc string
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		acceptEnc = r.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.Itoa(gz.Len()))
		_, _ = w.Write(gz.Bytes())
	})
	body, size, err := NewTransferClient(srv.URL, "tok").Get(context.Background(), tid)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	data, _ := io.ReadAll(body)
	// no transparent decompression: the announced size is the real one and there are no gzip bombs
	if acceptEnc != "" || size != int64(gz.Len()) || !bytes.Equal(data, gz.Bytes()) {
		t.Fatalf("Accept-Encoding=%q size=%d len=%d (gz %d)", acceptEnc, size, len(data), gz.Len())
	}
}

func TestTransferGetHonoursContext(t *testing.T) {
	block := make(chan struct{})
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		_, _ = w.Write([]byte("x"))
		w.(http.Flusher).Flush()
		<-block
	})
	defer close(block)
	ctx, cancel := context.WithCancel(context.Background())
	body, _, err := NewTransferClient(srv.URL, "tok").Get(ctx, tid)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	buf := make([]byte, 1)
	if _, err := io.ReadFull(body, buf); err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := io.ReadAll(body); err == nil {
		t.Fatal("cancelling the context must cut the read")
	}
}

func TestTransferPutHonoursContext(t *testing.T) {
	started, block := make(chan struct{}), make(chan struct{})
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadFull(r.Body, make([]byte, 1))
		close(started)
		<-block // the panel stops reading: the agent ends up blocked writing
	})
	defer close(block)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- NewTransferClient(srv.URL, "tok").Put(ctx, tid, &pattern{}, -1) }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Put does not respect context cancellation")
	}
}

func TestTransferHeaderTimeout(t *testing.T) {
	block := make(chan struct{})
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select { // never responds
		case <-block:
		case <-r.Context().Done():
		}
	})
	defer close(block)
	c := NewTransferClient(srv.URL, "tok")
	c.http = newTransferHTTP(50 * time.Millisecond)
	if _, _, err := c.Get(context.Background(), tid); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("GET without headers = %v", err)
	}
	if err := c.Put(context.Background(), tid, strings.NewReader("hello"), 5); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("PUT without response = %v", err)
	}
}

// slowReader delivers first, waits pause (a slow upload, not a synchronization) and then rest.
type slowReader struct {
	first, rest []byte
	pause       time.Duration
	paused      bool
}

func (s *slowReader) Read(p []byte) (int, error) {
	if len(s.first) > 0 {
		n := copy(p, s.first)
		s.first = s.first[n:]
		return n, nil
	}
	if !s.paused {
		s.paused = true
		<-time.After(s.pause)
	}
	if len(s.rest) == 0 {
		return 0, io.EOF
	}
	n := copy(p, s.rest)
	s.rest = s.rest[n:]
	return n, nil
}

func TestTransferSlowBodyHasNoDeadline(t *testing.T) {
	const timeout = 50 * time.Millisecond
	var got []byte
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			got, _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Length", "10")
		_, _ = w.Write([]byte("hello"))
		w.(http.Flusher).Flush()
		<-time.After(4 * timeout) // slow upload, not a synchronization
		_, _ = w.Write([]byte("world"))
	})
	c := NewTransferClient(srv.URL, "tok")
	c.http = newTransferHTTP(timeout)
	// the deadline covers the wait for headers, not the body: an upload that takes longer stays alive
	err := c.Put(context.Background(), tid, &slowReader{first: []byte("hello"), rest: []byte("world"), pause: 4 * timeout}, 10)
	if err != nil || string(got) != "helloworld" {
		t.Fatalf("slow PUT: got=%q err=%v", got, err)
	}
	body, _, err := c.Get(context.Background(), tid)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	if data, err := io.ReadAll(body); err != nil || string(data) != "helloworld" {
		t.Fatalf("slow GET: data=%q err=%v", data, err)
	}
}

func TestTransferStreamsWithoutBuffering(t *testing.T) {
	const size = 64 << 20
	var received atomic.Int64
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			n, _ := io.Copy(io.Discard, r.Body)
			received.Store(n)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(size))
		_, _ = io.Copy(w, io.LimitReader(&pattern{}, size))
	})
	c := NewTransferClient(srv.URL, "tok")
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if err := c.Put(context.Background(), tid, io.LimitReader(&pattern{}, size), size); err != nil {
		t.Fatal(err)
	}
	body, n, err := c.Get(context.Background(), tid)
	if err != nil {
		t.Fatal(err)
	}
	read, err := io.Copy(io.Discard, body)
	body.Close()
	runtime.ReadMemStats(&after)
	if err != nil || n != size || read != size || received.Load() != size {
		t.Fatalf("n=%d read=%d received=%d err=%v", n, read, received.Load(), err)
	}
	// panel and agent live in this process: 128 MiB moved with a few MiB reserved
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 8<<20 {
		t.Fatalf("%d bytes were reserved to move 2×64 MiB: it is not streaming", alloc)
	}
}

// assertScrubbed checks that a network error does not carry what identifies the connection: the
// message ends up in the browser (agent Error → 502 with its text).
func assertScrubbed(t *testing.T, what string, err error, secrets ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: must fail", what)
	}
	for _, s := range append(secrets, tid, "/agent/transfer", "127.0.0.1") {
		if strings.Contains(err.Error(), s) {
			t.Fatalf("%s: the error leaks %q: %v", what, s, err)
		}
	}
}

// Network errors carry neither the URL (with the transfer_id) nor IP addresses or ports, and
// keep the cause for errors.Is.
func TestTransferNetworkErrorsHideURLAndAddresses(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_, port, _ := net.SplitHostPort(addr)
	ln.Close() // nobody listening: connection refused
	c := NewTransferClient("http://"+addr, "tok")
	_, _, err = c.Get(context.Background(), tid)
	assertScrubbed(t, "refused GET", err, port)
	if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("refused GET: the cause is lost: %v", err)
	}
	err = c.Put(context.Background(), tid, strings.NewReader("x"), 1)
	assertScrubbed(t, "refused PUT", err, port)
	if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("refused PUT: the cause is lost: %v", err)
	}

	// The panel cuts the connection with a RST midway through the body.
	srv := transferPanel(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write(make([]byte, 10))
		w.(http.Flusher).Flush()
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_ = conn.(*net.TCPConn).SetLinger(0)
		_ = conn.Close()
	})
	body, _, err := NewTransferClient(srv.URL, "tok").Get(context.Background(), tid)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	_, err = io.ReadAll(body)
	assertScrubbed(t, "body cut off", err)
}
