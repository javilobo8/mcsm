// Package dockerproxy serves mc-router a trimmed-down Docker API (★ of Plan 8): only what it needs to
// discover the servers (ping, version, info, list, inspect without env, events) and, with autoscale,
// start and stop the servers the agent's policy allows. List, events and inspect are limited to the
// containers with the mc-router.host label: the host's other containers do not exist for the router. Everything else (creating containers, exec,
// images, networks, volumes…) is 403: the router no longer has root on the node through the socket.
package dockerproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"mcsm/agent/internal/spec"
)

// Op is an allowed operation of the Docker API.
type Op int

const (
	OpPing Op = iota + 1
	OpVersion
	OpInfo
	OpList
	OpInspect
	OpEvents
	OpStart
	OpStop
)

// MaxSocketPath: sun_path holds 108 bytes including the trailing NUL; a margin is left.
const MaxSocketPath = 100

// maxInspectBytes bounds the inspect that gets rewritten (a normal one takes a few KiB).
const maxInspectBytes = 4 << 20

// routerLabel: the router only sees containers with this label (the servers with a hostname). The host's other
// containers —with their Cmd, Args, labels and mounts— do not exist for it (defense in depth).
const routerLabel = spec.LabelRouterHost

// restrictFilters adds label=routerLabel to the filters parameter of a list or events request, merging it with the
// filters it already carries (Docker requires all requested labels: a label of one's own only narrows). It accepts both
// Docker forms ({"k":["v"]} and {"k":{"v":true}}; for the map the key counts, as in Docker) and returns the query
// with a single filters in map form. An unreadable or repeated filters is an error (400).
func restrictFilters(rawQuery string) (string, error) {
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", fmt.Errorf("unreadable query: %w", err)
	}
	vals := q["filters"]
	if len(vals) > 1 {
		return "", errors.New("repeated filters")
	}
	merged := map[string]map[string]bool{}
	if len(vals) == 1 && vals[0] != "" {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(vals[0]), &raw); err != nil {
			return "", fmt.Errorf("invalid filters: %w", err)
		}
		for k, v := range raw {
			set := map[string]bool{}
			var list []string
			if err := json.Unmarshal(v, &list); err == nil {
				for _, s := range list {
					set[s] = true
				}
			} else {
				var m map[string]bool
				if err := json.Unmarshal(v, &m); err != nil {
					return "", fmt.Errorf("invalid filters (%s): %w", k, err)
				}
				for s := range m {
					set[s] = true
				}
			}
			merged[k] = set
		}
	}
	if merged["label"] == nil {
		merged["label"] = map[string]bool{}
	}
	merged["label"][routerLabel] = true
	enc, err := json.Marshal(merged)
	if err != nil {
		return "", err
	}
	q.Set("filters", string(enc))
	return q.Encode(), nil
}

var (
	// prefixRe separates the optional version prefix (/v1.47: major and minor) from the rest. Only simple path
	// characters.
	prefixRe    = regexp.MustCompile(`^(?:/v([0-9]{1,2})\.([0-9]{1,3}))?(/[A-Za-z0-9_./-]*)$`)
	containerRe = regexp.MustCompile(`^/containers/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/(json|start|stop)$`)
)

// Classify decides whether a request is on the allowlist and which operation it is. A path with escapes (non-empty
// rawPath), ".." or "//" is denied without looking further: there is no way for two readings of the path to disagree.
func Classify(method, path, rawPath string) (op Op, container string, ok bool) {
	if rawPath != "" || strings.Contains(path, "..") || strings.Contains(path, "//") {
		return 0, "", false
	}
	m := prefixRe.FindStringSubmatch(path)
	if m == nil || (m[1] != "" && !supportedAPI(m[1], m[2])) {
		return 0, "", false
	}
	p, get := m[3], method == http.MethodGet
	switch {
	case p == "/_ping" && (get || method == http.MethodHead):
		return OpPing, "", true
	case p == "/version" && get:
		return OpVersion, "", true
	case p == "/info" && get:
		return OpInfo, "", true
	case p == "/containers/json" && get:
		return OpList, "", true
	case p == "/events" && get:
		return OpEvents, "", true
	}
	c := containerRe.FindStringSubmatch(p)
	if c == nil {
		return 0, "", false
	}
	switch {
	case c[2] == "json" && get:
		return OpInspect, c[1], true
	case c[2] == "start" && method == http.MethodPost:
		return OpStart, c[1], true
	case c[2] == "stop" && method == http.MethodPost:
		return OpStop, c[1], true
	}
	return 0, "", false
}

// minAPIMinor: with API versions older than 1.24, Docker applies the HostConfig that arrives in the body of
// POST /containers/{id}/start (privileged, binds of the host root…). Daemons up to Docker 24 accept them.
const minAPIMinor = 24

// supportedAPI accepts only v1.N with N ≥ minAPIMinor and no leading zeros (an ambiguous version does not pass).
func supportedAPI(major, minor string) bool {
	if major != "1" || (len(minor) > 1 && minor[0] == '0') {
		return false
	}
	n, err := strconv.Atoi(minor)
	return err == nil && n >= minAPIMinor
}

// StripEnv removes Config.Env from a container inspect (it carries RCON_PASSWORD, CF_API_KEY…).
func StripEnv(inspect []byte) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(inspect, &m); err != nil {
		return nil, fmt.Errorf("unreadable inspect: %w", err)
	}
	raw, ok := m["Config"]
	if !ok {
		return inspect, nil
	}
	var cfg map[string]json.RawMessage
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("unreadable inspect: %w", err)
	}
	delete(cfg, "Env")
	clean, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	m["Config"] = clean
	return json.Marshal(m)
}

// Policy decides on OpStart and OpStop: nil = allowed; an error is answered 409 with its text. container is the id
// or the name as mc-router requested it.
type Policy func(ctx context.Context, op Op, container string) error

// Options configures the proxy.
type Options struct {
	Listen   string // socket mounted into the router (host path: mirror mount of DATA_ROOT)
	Upstream string // the real Docker socket
	Policy   Policy
	UID, GID int // socket owner (the mc-router user); UID < 0 = not changed
	Log      *slog.Logger
	// Sleep waits d or until ctx ends (error if it ended) between Run retries; nil = a timer.
	Sleep func(ctx context.Context, d time.Duration) error
}

// RetryMin and RetryMax bound Run's wait between Listen retries (it doubles after each failure).
const (
	RetryMin = time.Second
	RetryMax = 30 * time.Second
)

// nextRetry doubles the wait up to RetryMax.
func nextRetry(d time.Duration) time.Duration {
	if d *= 2; d > RetryMax {
		return RetryMax
	}
	return d
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Proxy is the HTTP server of the filtered socket.
type Proxy struct {
	opts Options
	rp   *httputil.ReverseProxy

	mu  sync.Mutex
	ln  net.Listener
	err error
}

// New prepares the proxy (it does not listen until Listen).
func New(o Options) *Proxy {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	p := &Proxy{opts: o}
	p.rp = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme, r.Out.URL.Host, r.Out.Host = "http", "docker", "docker"
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", o.Upstream)
			},
			MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second,
		},
		FlushInterval:  -1, // events arrive as soon as Docker emits them
		ModifyResponse: p.modify,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			p.opts.Log.Warn("router proxy: Docker did not respond", "method", r.Method, "path", r.URL.Path, "err", err)
			writeErr(w, http.StatusBadGateway, "mcsm: Docker is not responding")
		},
	}
	return p
}

func (p *Proxy) modify(res *http.Response) error {
	op, container, _ := Classify(res.Request.Method, res.Request.URL.Path, res.Request.URL.RawPath)
	if op != OpInspect || res.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxInspectBytes+1))
	res.Body.Close()
	if err != nil {
		return err
	}
	if len(body) > maxInspectBytes {
		return errors.New("inspect too large")
	}
	var probe struct{ Config *inspectConfig }
	if err := json.Unmarshal(body, &probe); err != nil {
		return fmt.Errorf("unreadable inspect: %w", err)
	}
	if _, routed := probe.Config.labels()[routerLabel]; !routed {
		// A container that is not the router's does not exist for it: Docker's 404, with nothing from the real body.
		clean, _ := json.Marshal(map[string]string{"message": "No such container: " + container})
		res.StatusCode, res.Status = http.StatusNotFound, "404 Not Found"
		res.Header = http.Header{"Content-Type": []string{"application/json"}}
		res.Body = io.NopCloser(bytes.NewReader(clean))
		res.ContentLength = int64(len(clean))
		res.Header.Set("Content-Length", strconv.Itoa(len(clean)))
		return nil
	}
	clean, err := StripEnv(body)
	if err != nil {
		return err
	}
	res.Body = io.NopCloser(bytes.NewReader(clean))
	res.ContentLength = int64(len(clean))
	res.Header.Set("Content-Length", strconv.Itoa(len(clean)))
	return nil
}

// ServeHTTP applies the allowlist and the policy, and forwards what is allowed to the real Docker.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	op, container, ok := Classify(r.Method, r.URL.Path, r.URL.RawPath)
	if !ok {
		p.opts.Log.Warn("router proxy: request denied", "method", r.Method, "path", r.URL.Path)
		writeErr(w, http.StatusForbidden, "mcsm: operation not allowed for the router")
		return
	}
	// Nothing on the allowlist carries a body: a body on start would be a HostConfig (S1 of the Plan 9 review).
	if r.ContentLength != 0 || len(r.TransferEncoding) > 0 {
		p.opts.Log.Warn("router proxy: request with body denied", "method", r.Method, "path", r.URL.Path)
		writeErr(w, http.StatusBadRequest, "mcsm: the router cannot send bodies to Docker")
		return
	}
	switch op {
	case OpStart: // no query: checkpoint, checkpoint-dir and detachKeys are not needed by the router
		r.URL.RawQuery = ""
	case OpStop: // only the wait and the signal of the stop
		q, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "mcsm: unreadable query")
			return
		}
		keep := url.Values{}
		for _, k := range []string{"t", "signal"} {
			if v, ok := q[k]; ok {
				keep[k] = v[:1]
			}
		}
		r.URL.RawQuery = keep.Encode()
	}
	if op == OpList || op == OpEvents {
		q, err := restrictFilters(r.URL.RawQuery)
		if err != nil {
			p.opts.Log.Warn("router proxy: invalid filters", "path", r.URL.Path, "err", err)
			writeErr(w, http.StatusBadRequest, "mcsm: "+err.Error())
			return
		}
		r.URL.RawQuery = q
	}
	if (op == OpStart || op == OpStop) && p.opts.Policy != nil {
		if err := p.opts.Policy(r.Context(), op, container); err != nil {
			p.opts.Log.Info("router proxy: start or stop denied", "container", container, "err", err)
			writeErr(w, http.StatusConflict, "mcsm: "+err.Error())
			return
		}
	}
	p.rp.ServeHTTP(w, r)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": msg}) // Docker API error format
}

// Listen creates the socket (deleting a previous one) and leaves it for the mc-router user only.
func (p *Proxy) Listen() error {
	ln, err := p.listen()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.err = err
	if err == nil {
		p.ln = ln
	}
	return err
}

func (p *Proxy) listen() (net.Listener, error) {
	path := p.opts.Listen
	if len(path) > MaxSocketPath {
		return nil, fmt.Errorf("the router socket path is too long (%d > %d bytes): use a shorter DATA_ROOT", len(path), MaxSocketPath)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := secure(path, p.opts.UID, p.opts.GID); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// secure sets the socket to 0600 for uid. Without permission to change the owner (tests without root) it opens it to everyone
// (0666): this only happens on development machines; the agent runs as root.
func secure(path string, uid, gid int) error {
	if uid >= 0 {
		if err := os.Chown(path, uid, gid); err != nil {
			if os.Geteuid() == 0 {
				return err
			}
			return os.Chmod(path, 0o666)
		}
	}
	return os.Chmod(path, 0o600)
}

// Serve serves the socket until ctx ends or it fails; then it deletes it and Ready stops returning nil. Without a prior Listen
// it does nothing.
func (p *Proxy) Serve(ctx context.Context) {
	p.mu.Lock()
	ln := p.ln
	p.mu.Unlock()
	if ln == nil {
		return
	}
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Close() // also cuts open event streams
	}()
	err := srv.Serve(ln)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		p.opts.Log.Error("router proxy: the socket stopped serving", "err", err)
		err = fmt.Errorf("the Docker socket proxy stopped serving: %w", err)
	} else {
		err = errors.New("the Docker socket proxy has been closed")
	}
	// plan-9: it no longer listens: Ready says so (the router shows it in its status) until a new Listen.
	p.mu.Lock()
	if p.ln == ln {
		p.ln, p.err = nil, err
	}
	p.mu.Unlock()
	_ = os.Remove(p.opts.Listen)
}

// Run listens (if it is not already listening) and serves the socket until ctx ends. If Listen fails, or Serve stops
// serving, it listens again after a wait that starts at RetryMin and doubles on each consecutive failure up to
// RetryMax; meanwhile, Ready returns the error (the router shows it in its status). After each successful Listen it calls
// onListen (may be nil): the agent deploys the router without waiting for its next pass.
func (p *Proxy) Run(ctx context.Context, onListen func()) {
	sleep := p.opts.Sleep
	if sleep == nil {
		sleep = sleepCtx
	}
	wait := RetryMin
	for ctx.Err() == nil {
		if p.Ready() != nil { // the agent does the first Listen before launching Run
			if err := p.Listen(); err != nil {
				p.opts.Log.Error("Docker socket proxy for the router: could not listen; retrying", "err", err, "wait", wait)
				if sleep(ctx, wait) != nil {
					return
				}
				wait = nextRetry(wait)
				continue
			}
			wait = RetryMin
			if onListen != nil {
				onListen()
			}
		}
		p.Serve(ctx)
		if ctx.Err() != nil || sleep(ctx, wait) != nil {
			return
		}
	}
}

// Ready is nil if the socket is listening; otherwise, why not.
func (p *Proxy) Ready() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ln != nil {
		return nil
	}
	if p.err != nil {
		return p.err
	}
	return errors.New("the Docker socket proxy is not listening yet")
}

// inspectConfig is what the proxy reads from an inspect's Config.
type inspectConfig struct{ Labels map[string]string }

// labels returns the labels of an inspect Config (nil if there is no Config).
func (c *inspectConfig) labels() map[string]string {
	if c == nil {
		return nil
	}
	return c.Labels
}
