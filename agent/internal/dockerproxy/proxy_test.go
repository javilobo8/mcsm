package dockerproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestClassifyAllowList(t *testing.T) {
	allowed := []struct {
		method, path string
		op           Op
		id           string
	}{
		{"GET", "/_ping", OpPing, ""},
		{"HEAD", "/v1.47/_ping", OpPing, ""},
		{"GET", "/v1.47/version", OpVersion, ""},
		{"GET", "/v1.47/info", OpInfo, ""},
		{"GET", "/v1.47/containers/json", OpList, ""},
		{"GET", "/v1.47/events", OpEvents, ""},
		{"GET", "/v1.47/containers/abc123/json", OpInspect, "abc123"},
		{"POST", "/v1.47/containers/mcsm-alpha/start", OpStart, "mcsm-alpha"},
		{"POST", "/containers/abc123/stop", OpStop, "abc123"},
	}
	for _, c := range allowed {
		op, id, ok := Classify(c.method, c.path, "")
		if !ok || op != c.op || id != c.id {
			t.Errorf("%s %s → %v %q %v", c.method, c.path, op, id, ok)
		}
	}
	denied := []struct{ method, path, raw string }{
		{"POST", "/v1.47/containers/create", ""},
		{"POST", "/v1.47/containers/abc/exec", ""},
		{"POST", "/v1.47/containers/abc/kill", ""},
		{"POST", "/v1.47/containers/abc/restart", ""},
		{"POST", "/v1.47/containers/abc/unpause", ""},
		{"DELETE", "/v1.47/containers/abc", ""},
		{"GET", "/v1.47/containers/abc/logs", ""},
		{"GET", "/v1.47/containers/abc/archive", ""},
		{"POST", "/v1.47/containers/abc/json", ""},
		{"GET", "/v1.47/containers/abc/start", ""},
		{"GET", "/v1.47/images/json", ""},
		{"POST", "/v1.47/networks/create", ""},
		{"POST", "/v1.47/build", ""},
		{"GET", "/v1.47/containers/../json", ""},
		{"GET", "//containers/json", ""},
		{"GET", "/containers/json", "/containers%2Fjson"},
		{"GET", "/v1.47/containers/a%2Fb/json", "/v1.47/containers/a%2Fb/json"},
		// Más intentos de colarse (plan-9, revisión de seguridad).
		{"GET", "/v1.47/containers/../json", "/v1.47/containers/%2e%2e/json"},
		{"POST", "/v1.47/containers/abc/json/../../create", ""},
		{"POST", "/v1.47/containers/abc/start/", ""},
		{"GET", "/v1.47/containers/json/", ""},
		{"GET", "/V1.47/containers/json", ""},
		{"GET", "/v1.47/./containers/json", ""},
		{"GET", "/v1.47/containers/./json", ""},
		{"GET", "/v1.47/containers/.hidden/json", ""},
		{"OPTIONS", "*", ""},
		{"GET", "", ""},
		{"POST", "/v1.47/containers/abc/attach", ""},
		{"POST", "/v1.47/containers/abc/update", ""},
		{"POST", "/v1.47/containers/abc/rename", ""},
		{"POST", "/v1.47/containers/abc/pause", ""},
		{"POST", "/v1.47/containers/abc/wait", ""},
		{"POST", "/v1.47/exec/abc/start", ""},
		{"POST", "/v1.47/containers/prune", ""},
		{"POST", "/v1.47/swarm/init", ""},
		{"POST", "/v1.47/plugins/pull", ""},
		{"POST", "/v1.47/session", ""},
		{"GET", "/v1.47/volumes", ""},
		{"POST", "/v1.47/images/create", ""},
		{"GET", "/v1.47/containers/" + strings.Repeat("a", 129) + "/json", ""},
	}
	for _, c := range denied {
		if op, id, ok := Classify(c.method, c.path, c.raw); ok {
			t.Errorf("%s %s (raw %q) debe denegarse; dio %v %q", c.method, c.path, c.raw, op, id)
		}
	}
}

func TestStripEnv(t *testing.T) {
	out, err := StripEnv([]byte(`{"Id":"x","Name":"/mcsm-a","Config":{"Env":["RCON_PASSWORD=secreto"],"Labels":{"mc-router.host":"a.lan"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "secreto") || strings.Contains(string(out), "Env") {
		t.Fatalf("queda el entorno: %s", out)
	}
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if m["Id"] != "x" || m["Config"].(map[string]any)["Labels"].(map[string]any)["mc-router.host"] != "a.lan" {
		t.Fatalf("se pierde lo demás: %s", out)
	}
	if out, err := StripEnv([]byte(`{"Id":"x"}`)); err != nil || string(out) != `{"Id":"x"}` {
		t.Fatalf("sin Config: %s %v", out, err)
	}
	if _, err := StripEnv([]byte(`no json`)); err == nil {
		t.Fatal("un inspect ilegible es un error")
	}
}

// upstream es un Docker falso escuchando en un socket unix.
type upstream struct {
	mu     sync.Mutex
	got    []string
	events chan string
}

func startUpstream(t *testing.T, dir string) (*upstream, string) {
	t.Helper()
	u := &upstream{events: make(chan string, 4)}
	path := filepath.Join(dir, "docker.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.got = append(u.got, r.Method+" "+r.URL.Path)
		u.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/events"):
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			for {
				select {
				case ev := <-u.events:
					_, _ = io.WriteString(w, ev+"\n")
					w.(http.Flusher).Flush()
				case <-r.Context().Done():
					return
				}
			}
		case strings.HasSuffix(r.URL.Path, "/json") && strings.Contains(r.URL.Path, "/containers/") && !strings.HasSuffix(r.URL.Path, "/containers/json"):
			_, _ = io.WriteString(w, `{"Id":"abc","Config":{"Env":["RCON_PASSWORD=SECRETO"],"Labels":{}}}`)
		default:
			w.WriteHeader(204)
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return u, path
}

func (u *upstream) requests() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.got...)
}

func unixClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}}}
}

func TestProxyEndToEnd(t *testing.T) {
	dir := t.TempDir()
	up, upPath := startUpstream(t, dir)
	listen := filepath.Join(dir, "proxy", "docker.sock")
	p := New(Options{Listen: listen, Upstream: upPath, UID: -1, GID: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Policy: func(_ context.Context, op Op, c string) error {
			if c == "retenido" {
				return errors.New("parado por bucle de crash")
			}
			return nil
		}})
	if err := p.Ready(); err == nil {
		t.Fatal("sin Listen no está listo")
	}
	if err := p.Listen(); err != nil {
		t.Fatal(err)
	}
	if err := p.Ready(); err != nil || p.Since().IsZero() {
		t.Fatalf("ready = %v since = %v", err, p.Since())
	}
	if fi, err := os.Stat(listen); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("permisos del socket = %v %v", fi.Mode(), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.Serve(ctx)
	c := unixClient(listen)
	do := func(method, path string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(method, "http://docker"+path, nil)
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	res := do("GET", "/v1.47/containers/abc/json")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || strings.Contains(string(body), "SECRETO") || !strings.Contains(string(body), `"Id":"abc"`) {
		t.Fatalf("inspect = %d %s", res.StatusCode, body)
	}
	if res := do("POST", "/v1.47/containers/create"); res.StatusCode != 403 {
		t.Fatalf("create = %d", res.StatusCode)
	}
	res = do("POST", "/v1.47/containers/retenido/start")
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 409 || !strings.Contains(string(body), "bucle de crash") {
		t.Fatalf("start retenido = %d %s", res.StatusCode, body)
	}
	if res := do("POST", "/v1.47/containers/ok/start"); res.StatusCode != 204 {
		t.Fatalf("start = %d", res.StatusCode)
	}
	got := strings.Join(up.requests(), "|")
	if strings.Contains(got, "create") || strings.Contains(got, "retenido") || !strings.Contains(got, "POST /v1.47/containers/ok/start") {
		t.Fatalf("al Docker real llegó: %s", got)
	}

	// Los eventos llegan en cuanto se emiten (sin esperar al final de la respuesta).
	res = do("GET", "/v1.47/events")
	defer res.Body.Close()
	up.events <- `{"Action":"start"}`
	line, err := bufio.NewReader(res.Body).ReadString('\n')
	if err != nil || !strings.Contains(line, `"start"`) {
		t.Fatalf("evento = %q %v", line, err)
	}
}

func TestListenRejectsLongPaths(t *testing.T) {
	p := New(Options{Listen: "/" + strings.Repeat("x", MaxSocketPath), Upstream: "/nada", UID: -1})
	if err := p.Listen(); err == nil || !strings.Contains(err.Error(), "demasiado larga") {
		t.Fatalf("err = %v", err)
	}
	if err := p.Ready(); err == nil || !strings.Contains(err.Error(), "demasiado larga") {
		t.Fatalf("ready = %v", err)
	}
}

// En el cable, sin que un cliente HTTP normalice nada: lo que la lista blanca deniega nunca llega a Docker.
func TestProxyDeniesTrickyRequestsOnTheWire(t *testing.T) {
	dir := t.TempDir()
	up, upPath := startUpstream(t, dir)
	listen := filepath.Join(dir, "p.sock")
	p := New(Options{Listen: listen, Upstream: upPath, UID: -1, GID: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := p.Listen(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.Serve(ctx)
	for _, target := range []string{
		"/v1.47/containers%2Fjson",
		"/v1.47/cont%61iners/json",
		"/v1.47/containers/%2e%2e/create",
		"/v1.47/containers/abc/../../containers/create",
		"/v1.47/containers/abc/%2e%2e/%2e%2e/containers/create",
		"//v1.47/containers/create",
		"http://docker/v1.47/containers/create",
		"/v1.47/containers/create?name=x",
		"/v1.47/containers/abc/exec",
	} {
		conn, err := net.Dial("unix", listen)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(conn, "POST "+target+" HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
		res, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		res.Body.Close()
		conn.Close()
		if res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s → %d", target, res.StatusCode)
		}
	}
	if got := up.requests(); len(got) != 0 {
		t.Fatalf("al Docker real llegó: %v", got)
	}
}
