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
	"time"
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
		// More attempts to sneak through (plan-9, security review).
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
			t.Errorf("%s %s (raw %q) must be denied; got %v %q", c.method, c.path, c.raw, op, id)
		}
	}
}

func TestStripEnv(t *testing.T) {
	out, err := StripEnv([]byte(`{"Id":"x","Name":"/mcsm-a","Config":{"Env":["RCON_PASSWORD=secret"],"Labels":{"mc-router.host":"a.lan"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "secret") || strings.Contains(string(out), "Env") {
		t.Fatalf("the env remains: %s", out)
	}
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if m["Id"] != "x" || m["Config"].(map[string]any)["Labels"].(map[string]any)["mc-router.host"] != "a.lan" {
		t.Fatalf("the rest is lost: %s", out)
	}
	if out, err := StripEnv([]byte(`{"Id":"x"}`)); err != nil || string(out) != `{"Id":"x"}` {
		t.Fatalf("without Config: %s %v", out, err)
	}
	if _, err := StripEnv([]byte(`no json`)); err == nil {
		t.Fatal("an unreadable inspect is an error")
	}
}

// upstream is a fake Docker listening on a unix socket.
type upstream struct {
	mu      sync.Mutex
	got     []string
	queries map[string]string // last raw query received per path
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
			// "abc" is a server with a router hostname; any other is a foreign container on the host.
			if strings.Contains(r.URL.Path, "/containers/abc/") {
				_, _ = io.WriteString(w, `{"Id":"abc","Config":{"Env":["RCON_PASSWORD=SECRET"],"Labels":{"mc-router.host":"a.lan"}}}`)
			} else {
				_, _ = io.WriteString(w, `{"Id":"foreign","Config":{"Cmd":["--password","FOREIGN"],"Labels":{"other":"x"}}}`)
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
			if c == "held" {
				return errors.New("stopped by crash loop")
			}
			return nil
		}})
	if err := p.Ready(); err == nil {
		t.Fatal("without Listen it is not ready")
	}
	if err := p.Listen(); err != nil {
		t.Fatal(err)
	}
	if err := p.Ready(); err != nil {
		t.Fatalf("ready = %v", err)
	}
	if fi, err := os.Stat(listen); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket permissions = %v %v", fi.Mode(), err)
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
	if res.StatusCode != 200 || strings.Contains(string(body), "SECRET") || !strings.Contains(string(body), `"Id":"abc"`) {
		t.Fatalf("inspect = %d %s", res.StatusCode, body)
	}
	if res := do("POST", "/v1.47/containers/create"); res.StatusCode != 403 {
		t.Fatalf("create = %d", res.StatusCode)
	}
	res = do("POST", "/v1.47/containers/held/start")
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 409 || !strings.Contains(string(body), "crash loop") {
		t.Fatalf("held start = %d %s", res.StatusCode, body)
	}
	if res := do("POST", "/v1.47/containers/ok/start"); res.StatusCode != 204 {
		t.Fatalf("start = %d", res.StatusCode)
	}
	got := strings.Join(up.requests(), "|")
	if strings.Contains(got, "create") || strings.Contains(got, "held") || !strings.Contains(got, "POST /v1.47/containers/ok/start") {
		t.Fatalf("the real Docker received: %s", got)
	}

	// Events arrive as soon as they are emitted (without waiting for the end of the response).
	res = do("GET", "/v1.47/events")
	defer res.Body.Close()
	up.events <- `{"Action":"start"}`
	line, err := bufio.NewReader(res.Body).ReadString('\n')
	if err != nil || !strings.Contains(line, `"start"`) {
		t.Fatalf("event = %q %v", line, err)
	}
}

func TestListenRejectsLongPaths(t *testing.T) {
	p := New(Options{Listen: "/" + strings.Repeat("x", MaxSocketPath), Upstream: "/none", UID: -1})
	if err := p.Listen(); err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("err = %v", err)
	}
	if err := p.Ready(); err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("ready = %v", err)
	}
}

// On the wire, without an HTTP client normalizing anything: what the allowlist denies never reaches Docker.
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
		t.Fatalf("the real Docker received: %v", got)
	}
}

// filtersOf decodes the filters parameter of a query into canonical form (key → sorted values).
func filtersOf(t *testing.T, rawQuery string) map[string][]string {
	t.Helper()
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(q["filters"]); n != 1 {
		t.Fatalf("filters appears %d times in %q", n, rawQuery)
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
		{"no filters", "", map[string][]string{"label": {"mc-router.host"}}, false},
		{"other parameters", "all=1", map[string][]string{"label": {"mc-router.host"}}, false},
		{"other filters", "filters=" + url.QueryEscape(`{"status":["running"],"type":["container"]}`),
			map[string][]string{"label": {"mc-router.host"}, "status": {"running"}, "type": {"container"}}, false},
		{"previous label (list)", "filters=" + url.QueryEscape(`{"label":["mcsm.managed=true"]}`),
			map[string][]string{"label": {"mc-router.host", "mcsm.managed=true"}}, false},
		// Docker ignores the map value (the key counts): it is kept as is.
		{"previous label (map)", "filters=" + url.QueryEscape(`{"label":{"a=b":true,"c":false}}`),
			map[string][]string{"label": {"a=b", "c", "mc-router.host"}}, false},
		{"already carries ours", "filters=" + url.QueryEscape(`{"label":["mc-router.host"]}`),
			map[string][]string{"label": {"mc-router.host"}}, false},
		{"empty filters", "filters=", map[string][]string{"label": {"mc-router.host"}}, false},
		{"invalid JSON", "filters=" + url.QueryEscape(`{"label":`), nil, true},
		{"label with odd type", "filters=" + url.QueryEscape(`{"label":"mc-router.host"}`), nil, true},
		{"not an object", "filters=" + url.QueryEscape(`["label"]`), nil, true},
		{"repeated filters", "filters=" + url.QueryEscape(`{}`) + "&filters=" + url.QueryEscape(`{}`), nil, true},
		{"unreadable query", "filters=%zz", nil, true},
	} {
		got, err := restrictFilters(c.query)
		if c.bad {
			if err == nil {
				t.Errorf("%s: must be rejected; got %q", c.name, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if f := filtersOf(t, got); !maps.EqualFunc(f, c.want, slices.Equal) {
			t.Errorf("%s: filters = %v, expected %v", c.name, f, c.want)
		}
		if c.query == "all=1" && !strings.Contains(got, "all=1") {
			t.Errorf("%s: the other parameters are lost: %q", c.name, got)
		}
	}
}

// The router only sees containers with a router hostname: list and events carry the filter, the inspect of another
// container is a 404 (without the real Docker body) and an invalid filters is a 400 that does not reach Docker.
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
		t.Fatalf("list to Docker with filters %v", f)
	}
	if code, _ := get("/v1.47/events?filters=" + url.QueryEscape(`{"type":["container"]}`)); code != 200 {
		t.Fatalf("events = %d", code)
	}
	if f := filtersOf(t, up.query("/v1.47/events")); !slices.Equal(f["label"], []string{"mc-router.host"}) || !slices.Equal(f["type"], []string{"container"}) {
		t.Fatalf("events to Docker with filters %v", f)
	}
	before := len(up.requests())
	if code, _ := get("/v1.47/containers/json?filters=" + url.QueryEscape(`{"label":`)); code != 400 {
		t.Fatalf("invalid filters = %d", code)
	}
	if len(up.requests()) != before {
		t.Fatal("an invalid filters does not reach Docker")
	}

	code, body := get("/v1.47/containers/foreign/json")
	if code != 404 || strings.Contains(body, "FOREIGN") || strings.Contains(body, "other") {
		t.Fatalf("foreign inspect = %d %s", code, body)
	}
	if code, body := get("/v1.47/containers/abc/json"); code != 200 || !strings.Contains(body, "a.lan") || strings.Contains(body, "SECRET") {
		t.Fatalf("router inspect = %d %s", code, body)
	}
}

// S1: with API < 1.24 Docker applies the HostConfig from the start body (privileged, binds…): those prefixes do not pass.
func TestClassifyRejectsOldAPIVersions(t *testing.T) {
	for _, c := range []struct {
		path string
		ok   bool
	}{
		{"/v1.24/containers/abc/start", true},
		{"/v1.47/containers/abc/start", true},
		{"/v1.100/containers/json", true},
		{"/containers/abc/start", true}, // no prefix: the daemon's version
		{"/v1.23/containers/abc/start", false},
		{"/v1.12/containers/json", false},
		{"/v1.9/_ping", false},
		{"/v1.024/_ping", false}, // leading zeros: ambiguous, rejected
		{"/v0.99/_ping", false},
		{"/v2.0/_ping", false},
	} {
		method := http.MethodGet
		if strings.HasSuffix(c.path, "/start") {
			method = http.MethodPost
		}
		if _, _, ok := Classify(method, c.path, ""); ok != c.ok {
			t.Errorf("%s → ok=%v, expected %v", c.path, ok, c.ok)
		}
	}
}

// S1: no operation on the allowlist carries a body; start goes without a query and stop only with t and signal.
func TestProxyRejectsBodiesAndTrimsStartStopQuery(t *testing.T) {
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
	raw := func(req string) int {
		t.Helper()
		conn, err := net.Dial("unix", listen)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, req)
		res, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for _, c := range []struct{ name, req string }{
		{"start with body", "POST /v1.47/containers/abc/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: 17\r\nConnection: close\r\n\r\n{\"Privileged\":1}\n"},
		{"start chunked", "POST /v1.47/containers/abc/start HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n"},
		{"stop with body", "POST /v1.47/containers/abc/stop HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"},
		{"inspect with body", "GET /v1.47/containers/abc/json HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"},
		{"start with old API", "POST /v1.23/containers/abc/start HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"},
	} {
		if code := raw(c.req); code != http.StatusBadRequest && code != http.StatusForbidden {
			t.Errorf("%s → %d", c.name, code)
		}
	}
	if got := up.requests(); len(got) != 0 {
		t.Fatalf("the real Docker received: %v", got)
	}

	if code := raw("POST /v1.47/containers/abc/start?checkpoint=x&checkpoint-dir=/tmp&detachKeys=a HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); code != 204 {
		t.Fatalf("start without body = %d", code)
	}
	if q := up.query("/v1.47/containers/abc/start"); q != "" {
		t.Fatalf("start arrived with query %q", q)
	}
	if code := raw("POST /v1.47/containers/abc/stop?t=10&signal=SIGTERM&other=1 HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n"); code != 204 {
		t.Fatalf("stop = %d", code)
	}
	if q := up.query("/v1.47/containers/abc/stop"); q != "signal=SIGTERM&t=10" {
		t.Fatalf("stop arrived with query %q", q)
	}
}

// If Serve ends (the socket stops serving because of an error, or the agent shuts down), Ready stops saying it is
// ready: the router shows it in its status instead of mounting a dead socket.
func TestReadyFalseAfterServeEnds(t *testing.T) {
	for _, viaCtx := range []bool{false, true} {
		dir := t.TempDir()
		p := New(Options{Listen: filepath.Join(dir, "p.sock"), Upstream: filepath.Join(dir, "none.sock"), UID: -1, GID: -1,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
		if err := p.Listen(); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			p.Serve(ctx)
			close(done)
		}()
		if viaCtx {
			cancel()
		} else {
			p.mu.Lock()
			_ = p.ln.Close() // the socket stops accepting: Serve exits with an error
			p.mu.Unlock()
		}
		<-done
		cancel()
		if err := p.Ready(); err == nil {
			t.Fatalf("viaCtx=%v: after Serve ends it is not ready", viaCtx)
		}
	}
}

// m5: if Listen fails (e.g. the directory cannot be created yet), Run retries with backoff and, meanwhile, Ready
// returns the error; after listening it notifies (the agent deploys the router). If Serve stops serving, it listens again.
func TestRunRetriesListenWithBackoff(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var sleeps []time.Duration
	var readyDuringSleep []error
	p := New(Options{Listen: filepath.Join(blocker, "p.sock"), Upstream: filepath.Join(dir, "none.sock"), UID: -1, GID: -1,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	p.opts.Sleep = func(ctx context.Context, d time.Duration) error {
		mu.Lock()
		defer mu.Unlock()
		sleeps = append(sleeps, d)
		readyDuringSleep = append(readyDuringSleep, p.Ready())
		if len(sleeps) == 2 {
			_ = os.Remove(blocker) // the directory can now be created
		}
		return ctx.Err()
	}
	listened := make(chan struct{}, 4)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		p.Run(ctx, func() { listened <- struct{}{} })
		close(done)
	}()
	waitSignal := func(what string) {
		t.Helper()
		select {
		case <-listened:
		case <-time.After(5 * time.Second):
			t.Fatalf("no notification: %s", what)
		}
	}
	waitSignal("first successful Listen")
	if err := p.Ready(); err != nil {
		t.Fatalf("ready = %v", err)
	}
	mu.Lock()
	if !slices.Equal(sleeps, []time.Duration{RetryMin, 2 * RetryMin}) || readyDuringSleep[0] == nil || readyDuringSleep[1] == nil {
		t.Fatalf("waits = %v, ready meanwhile = %v", sleeps, readyDuringSleep)
	}
	mu.Unlock()

	p.mu.Lock()
	_ = p.ln.Close() // the socket stops serving: Run listens again (backoff from the minimum)
	p.mu.Unlock()
	waitSignal("Listen after the Serve failure")
	mu.Lock()
	if got := sleeps[len(sleeps)-1]; len(sleeps) != 3 || got != RetryMin {
		t.Fatalf("waits = %v", sleeps)
	}
	mu.Unlock()

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run does not finish on cancel")
	}
}

func TestRunServesAnAlreadyListeningSocket(t *testing.T) {
	dir := t.TempDir()
	_, upPath := startUpstream(t, dir)
	listen := filepath.Join(dir, "p.sock")
	p := New(Options{Listen: listen, Upstream: upPath, UID: -1, GID: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := p.Listen(); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(listen)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		p.Run(ctx, func() { t.Error("it does not listen again on a socket that is already listening") })
		close(done)
	}()
	res, err := unixClient(listen).Get("http://docker/_ping")
	if err != nil || res.StatusCode >= 300 {
		t.Fatalf("ping = %v %v", res, err)
	}
	res.Body.Close()
	if after, err := os.Stat(listen); err != nil || !os.SameFile(before, after) {
		t.Fatal("the same socket")
	}
	cancel()
	<-done
}

func TestRetryBackoffCaps(t *testing.T) {
	d := RetryMin
	for i := 0; i < 20; i++ {
		d = nextRetry(d)
	}
	if d != RetryMax {
		t.Fatalf("cap = %v", d)
	}
}
