package dockerproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
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
	mu      sync.Mutex
	got     []string
	queries map[string]string // última query cruda recibida por ruta
	events  chan string
}

func startUpstream(t *testing.T, dir string) (*upstream, string) {
	t.Helper()
	u := &upstream{events: make(chan string, 4), queries: map[string]string{}}
	path := filepath.Join(dir, "docker.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.got = append(u.got, r.Method+" "+r.URL.Path)
		u.queries[r.URL.Path] = r.URL.RawQuery
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
			// «abc» es un servidor con hostname de router; cualquier otro, un contenedor ajeno del host.
			if strings.Contains(r.URL.Path, "/containers/abc/") {
				_, _ = io.WriteString(w, `{"Id":"abc","Config":{"Env":["RCON_PASSWORD=SECRETO"],"Labels":{"mc-router.host":"a.lan"}}}`)
			} else {
				_, _ = io.WriteString(w, `{"Id":"ajeno","Config":{"Cmd":["--password","AJENO"],"Labels":{"otra":"x"}}}`)
			}
		default:
			w.WriteHeader(204)
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return u, path
}

func (u *upstream) query(path string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.queries[path]
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

// filtersOf decodifica el parámetro filters de una query en forma canónica (clave → valores ordenados).
func filtersOf(t *testing.T, rawQuery string) map[string][]string {
	t.Helper()
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(q["filters"]); n != 1 {
		t.Fatalf("filters aparece %d veces en %q", n, rawQuery)
	}
	var m map[string]map[string]bool
	if err := json.Unmarshal([]byte(q.Get("filters")), &m); err != nil {
		t.Fatalf("filters %q: %v", q.Get("filters"), err)
	}
	out := map[string][]string{}
	for k, vs := range m {
		for v := range vs {
			out[k] = append(out[k], v)
		}
		slices.Sort(out[k])
	}
	return out
}

func TestRestrictFilters(t *testing.T) {
	for _, c := range []struct {
		name, query string
		want        map[string][]string
		bad         bool
	}{
		{"sin filtros", "", map[string][]string{"label": {"mc-router.host"}}, false},
		{"otros parámetros", "all=1", map[string][]string{"label": {"mc-router.host"}}, false},
		{"otros filtros", "filters=" + url.QueryEscape(`{"status":["running"],"type":["container"]}`),
			map[string][]string{"label": {"mc-router.host"}, "status": {"running"}, "type": {"container"}}, false},
		{"label previo (lista)", "filters=" + url.QueryEscape(`{"label":["mcsm.managed=true"]}`),
			map[string][]string{"label": {"mc-router.host", "mcsm.managed=true"}}, false},
		// Docker ignora el valor del mapa (cuenta la clave): se conserva igual.
		{"label previo (mapa)", "filters=" + url.QueryEscape(`{"label":{"a=b":true,"c":false}}`),
			map[string][]string{"label": {"a=b", "c", "mc-router.host"}}, false},
		{"ya trae el nuestro", "filters=" + url.QueryEscape(`{"label":["mc-router.host"]}`),
			map[string][]string{"label": {"mc-router.host"}}, false},
		{"filters vacío", "filters=", map[string][]string{"label": {"mc-router.host"}}, false},
		{"JSON inválido", "filters=" + url.QueryEscape(`{"label":`), nil, true},
		{"label con tipo raro", "filters=" + url.QueryEscape(`{"label":"mc-router.host"}`), nil, true},
		{"no es un objeto", "filters=" + url.QueryEscape(`["label"]`), nil, true},
		{"filters repetido", "filters=" + url.QueryEscape(`{}`) + "&filters=" + url.QueryEscape(`{}`), nil, true},
		{"query ilegible", "filters=%zz", nil, true},
	} {
		got, err := restrictFilters(c.query)
		if c.bad {
			if err == nil {
				t.Errorf("%s: debe rechazarse; dio %q", c.name, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if f := filtersOf(t, got); !maps.EqualFunc(f, c.want, slices.Equal) {
			t.Errorf("%s: filtros = %v, se esperaba %v", c.name, f, c.want)
		}
		if c.query == "all=1" && !strings.Contains(got, "all=1") {
			t.Errorf("%s: se pierden los demás parámetros: %q", c.name, got)
		}
	}
}

// El router solo ve los contenedores con hostname de router: list y events llevan el filtro, el inspect de otro
// contenedor es un 404 (sin cuerpo del Docker real) y un filters inválido es un 400 que no llega a Docker.
func TestProxyOnlyShowsRouterContainers(t *testing.T) {
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
	c := unixClient(listen)
	get := func(path string) (int, string) {
		t.Helper()
		res, err := c.Get("http://docker" + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if strings.HasSuffix(strings.SplitN(path, "?", 2)[0], "/events") {
			return res.StatusCode, ""
		}
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	if code, _ := get("/v1.47/containers/json?all=1&filters=" + url.QueryEscape(`{"label":{"x=y":true}}`)); code != 204 {
		t.Fatalf("list = %d", code)
	}
	if f := filtersOf(t, up.query("/v1.47/containers/json")); !slices.Equal(f["label"], []string{"mc-router.host", "x=y"}) {
		t.Fatalf("list a Docker con filtros %v", f)
	}
	if code, _ := get("/v1.47/events?filters=" + url.QueryEscape(`{"type":["container"]}`)); code != 200 {
		t.Fatalf("events = %d", code)
	}
	if f := filtersOf(t, up.query("/v1.47/events")); !slices.Equal(f["label"], []string{"mc-router.host"}) || !slices.Equal(f["type"], []string{"container"}) {
		t.Fatalf("events a Docker con filtros %v", f)
	}
	before := len(up.requests())
	if code, _ := get("/v1.47/containers/json?filters=" + url.QueryEscape(`{"label":`)); code != 400 {
		t.Fatalf("filters inválido = %d", code)
	}
	if len(up.requests()) != before {
		t.Fatal("un filters inválido no llega a Docker")
	}

	code, body := get("/v1.47/containers/ajeno/json")
	if code != 404 || strings.Contains(body, "AJENO") || strings.Contains(body, "otra") {
		t.Fatalf("inspect ajeno = %d %s", code, body)
	}
	if code, body := get("/v1.47/containers/abc/json"); code != 200 || !strings.Contains(body, "a.lan") || strings.Contains(body, "SECRETO") {
		t.Fatalf("inspect del router = %d %s", code, body)
	}
}
