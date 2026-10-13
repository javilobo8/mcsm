// Package dockerproxy sirve a mc-router una API de Docker recortada (★ del Plan 8): solo lo que necesita para
// descubrir los servidores (ping, versión, info, listar, inspeccionar sin entorno, eventos) y, con autoscale,
// arrancar y parar los servidores que la política del agente permita. Listar, eventos e inspeccionar se limitan a los
// contenedores con la etiqueta mc-router.host: el resto de contenedores del host no existen para el router. Todo lo demás (crear contenedores, exec,
// imágenes, redes, volúmenes…) es 403: el router deja de tener root en el nodo a través del socket.
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

// Op es una operación permitida de la API de Docker.
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

// MaxSocketPath: sun_path admite 108 bytes con el NUL final; se deja margen.
const MaxSocketPath = 100

// maxInspectBytes acota el inspect que se reescribe (uno normal ocupa unos KiB).
const maxInspectBytes = 4 << 20

// routerLabel: el router solo ve los contenedores con esta etiqueta (los servidores con hostname). Los demás
// contenedores del host —con sus Cmd, Args, etiquetas y montajes— no existen para él (defensa en profundidad).
const routerLabel = spec.LabelRouterHost

// restrictFilters añade label=routerLabel al parámetro filters de un list o de events, fusionándolo con los
// filtros que ya traiga (Docker exige todas las etiquetas pedidas: un label propio solo estrecha). Acepta las dos
// formas de Docker ({"k":["v"]} y {"k":{"v":true}}; del mapa cuenta la clave, como en Docker) y devuelve la query
// con un único filters en forma de mapa. Un filters ilegible o repetido es un error (400).
func restrictFilters(rawQuery string) (string, error) {
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", fmt.Errorf("query ilegible: %w", err)
	}
	vals := q["filters"]
	if len(vals) > 1 {
		return "", errors.New("filters repetido")
	}
	merged := map[string]map[string]bool{}
	if len(vals) == 1 && vals[0] != "" {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(vals[0]), &raw); err != nil {
			return "", fmt.Errorf("filters inválido: %w", err)
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
					return "", fmt.Errorf("filters inválido (%s): %w", k, err)
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
	// prefixRe separa el prefijo de versión opcional (/v1.47) del resto. Solo caracteres de ruta sencillos.
	prefixRe    = regexp.MustCompile(`^(/v[0-9]{1,2}\.[0-9]{1,3})?(/[A-Za-z0-9_./-]*)$`)
	containerRe = regexp.MustCompile(`^/containers/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/(json|start|stop)$`)
)

// Classify decide si una petición está en la lista blanca y qué operación es. Una ruta con escapes (rawPath no
// vacío), «..» o «//» se deniega sin mirar más: no hay forma de que dos lecturas de la ruta discrepen.
func Classify(method, path, rawPath string) (op Op, container string, ok bool) {
	if rawPath != "" || strings.Contains(path, "..") || strings.Contains(path, "//") {
		return 0, "", false
	}
	m := prefixRe.FindStringSubmatch(path)
	if m == nil {
		return 0, "", false
	}
	p, get := m[2], method == http.MethodGet
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

// StripEnv borra Config.Env de un inspect de contenedor (lleva RCON_PASSWORD, CF_API_KEY…).
func StripEnv(inspect []byte) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(inspect, &m); err != nil {
		return nil, fmt.Errorf("inspect ilegible: %w", err)
	}
	raw, ok := m["Config"]
	if !ok {
		return inspect, nil
	}
	var cfg map[string]json.RawMessage
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("inspect ilegible: %w", err)
	}
	delete(cfg, "Env")
	clean, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	m["Config"] = clean
	return json.Marshal(m)
}

// Policy decide sobre OpStart y OpStop: nil = permitida; un error se responde 409 con su texto. container es el id
// o el nombre tal como lo pidió mc-router.
type Policy func(ctx context.Context, op Op, container string) error

// Options configura el proxy.
type Options struct {
	Listen   string // socket que se monta en el router (ruta del host: montaje espejo de DATA_ROOT)
	Upstream string // socket real de Docker
	Policy   Policy
	UID, GID int // propietario del socket (el usuario de mc-router); UID < 0 = no se cambia
	Log      *slog.Logger
}

// Proxy es el servidor HTTP del socket filtrado.
type Proxy struct {
	opts Options
	rp   *httputil.ReverseProxy

	mu    sync.Mutex
	ln    net.Listener
	since time.Time
	err   error
}

// New prepara el proxy (no escucha hasta Listen).
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
		FlushInterval:  -1, // los eventos llegan en cuanto Docker los emite
		ModifyResponse: p.modify,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			p.opts.Log.Warn("proxy del router: Docker no respondió", "method", r.Method, "path", r.URL.Path, "err", err)
			writeErr(w, http.StatusBadGateway, "mcsm: Docker no responde")
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
		return errors.New("inspect demasiado grande")
	}
	var probe struct{ Config *inspectConfig }
	if err := json.Unmarshal(body, &probe); err != nil {
		return fmt.Errorf("inspect ilegible: %w", err)
	}
	if _, routed := probe.Config.labels()[routerLabel]; !routed {
		// Un contenedor que no es del router no existe para él: el 404 de Docker, sin nada del cuerpo real.
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

// ServeHTTP aplica la lista blanca y la política, y reenvía lo permitido al Docker real.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	op, container, ok := Classify(r.Method, r.URL.Path, r.URL.RawPath)
	if !ok {
		p.opts.Log.Warn("proxy del router: petición denegada", "method", r.Method, "path", r.URL.Path)
		writeErr(w, http.StatusForbidden, "mcsm: operación no permitida al router")
		return
	}
	if op == OpList || op == OpEvents {
		q, err := restrictFilters(r.URL.RawQuery)
		if err != nil {
			p.opts.Log.Warn("proxy del router: filtros inválidos", "path", r.URL.Path, "err", err)
			writeErr(w, http.StatusBadRequest, "mcsm: "+err.Error())
			return
		}
		r.URL.RawQuery = q
	}
	if (op == OpStart || op == OpStop) && p.opts.Policy != nil {
		if err := p.opts.Policy(r.Context(), op, container); err != nil {
			p.opts.Log.Info("proxy del router: arranque o parada denegados", "container", container, "err", err)
			writeErr(w, http.StatusConflict, "mcsm: "+err.Error())
			return
		}
	}
	p.rp.ServeHTTP(w, r)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": msg}) // formato de error de la API de Docker
}

// Listen crea el socket (borra uno anterior) y lo deja solo para el usuario de mc-router.
func (p *Proxy) Listen() error {
	ln, err := p.listen()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.err = err
	if err == nil {
		p.ln, p.since = ln, time.Now()
	}
	return err
}

func (p *Proxy) listen() (net.Listener, error) {
	path := p.opts.Listen
	if len(path) > MaxSocketPath {
		return nil, fmt.Errorf("la ruta del socket del router es demasiado larga (%d > %d bytes): usa un DATA_ROOT más corto", len(path), MaxSocketPath)
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

// secure deja el socket en 0600 para uid. Sin permiso para cambiar el propietario (tests sin root) lo abre a todos
// (0666): solo pasa en máquinas de desarrollo; el agente corre como root.
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

// Serve atiende el socket hasta que ctx termina; después lo borra. Sin Listen previo no hace nada.
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
		_ = srv.Close() // también corta los streams de eventos abiertos
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		p.opts.Log.Error("proxy del router: el socket dejó de atender", "err", err)
	}
	_ = os.Remove(p.opts.Listen)
}

// Ready es nil si el socket está escuchando; si no, por qué.
func (p *Proxy) Ready() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ln != nil {
		return nil
	}
	if p.err != nil {
		return p.err
	}
	return errors.New("el proxy del socket de Docker aún no escucha")
}

// Since es cuándo empezó a escuchar el socket actual (cero si no escucha).
func (p *Proxy) Since() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.since
}

// inspectConfig es lo que el proxy lee del Config de un inspect.
type inspectConfig struct{ Labels map[string]string }

// labels devuelve las etiquetas de un Config de inspect (nil si no hay Config).
func (c *inspectConfig) labels() map[string]string {
	if c == nil {
		return nil
	}
	return c.Labels
}
