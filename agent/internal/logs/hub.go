// Package logs sigue los logs de los contenedores y los reparte a suscriptores.
package logs

import (
	"bufio"
	"context"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"mcsm/agent/internal/docker"
)

const (
	ringSize     = 500
	subBuffer    = 1024
	maxLineBytes = 64 * 1024 // el ring (500 líneas) queda acotado a ~32 MiB por servidor
	truncMarker  = " …[truncada]"
	defaultGrace = 30 * time.Second
	redacted     = "[oculto]"
	minSecretLen = 8 // más cortos ocultarían texto normal
)

type Line struct {
	TS   time.Time
	Text string
}

// Subscription es una suscripción a los logs de un servidor.
//
// Lines entrega primero el replay del buffer circular (las últimas `tail` líneas,
// máx. 500) y luego las nuevas. Se cierra cuando muere el follower (EOF del
// stream, Reset, contenedor borrado o cambio de contenedor). Si el suscriptor no
// lee y su buffer se llena, las líneas nuevas se descartan sin bloquear a nadie y
// se cuentan: Dropped() devuelve el total acumulado, para que la capa WS emita
// StreamDropped{count} (spec §5.2) con la diferencia desde el último aviso.
// Close es idempotente y seguro tras el cierre del follower.
type Subscription struct {
	Lines   <-chan Line
	dropped atomic.Uint64
	unsub   func()
}

// Dropped devuelve el número acumulado de líneas descartadas por este suscriptor.
func (s *Subscription) Dropped() uint64 { return s.dropped.Load() }

// Close da de baja la suscripción (inicia el periodo de gracia si era la última).
func (s *Subscription) Close() { s.unsub() }

type Hub struct {
	eng       docker.Engine
	mu        sync.Mutex
	followers map[string]*follower
	grace     time.Duration
	secrets   func(serverID string) []string // plan-9: lo que no debe salir en la consola

	// graceHook (solo tests) se invoca al inicio del callback del temporizador de gracia.
	graceHook func()
}

type subscriber struct {
	ch  chan Line
	sub *Subscription
}

type follower struct {
	hub         *Hub
	serverID    string
	containerID string
	secrets     []string
	cancel      context.CancelFunc
	mu          sync.Mutex
	ring        []Line
	subs        map[int]*subscriber
	nextSub     int
	closed      bool
	graceTimer  *time.Timer
}

func NewHub(eng docker.Engine) *Hub {
	return &Hub{eng: eng, followers: map[string]*follower{}, grace: defaultGrace}
}

// SetGrace cambia el periodo de gracia (por defecto 30 s) para las próximas bajas.
func (h *Hub) SetGrace(d time.Duration) {
	h.mu.Lock()
	h.grace = d
	h.mu.Unlock()
}

// SetSecrets fija de dónde sale, por servidor, lo que hay que ocultar en sus logs (contraseña RCON, API key de
// CurseForge; L2 del Plan 3: los modos debug de itzg pueden imprimirlas). Se consulta al abrir cada follower: un
// cambio de spec recrea el contenedor y abre otro.
func (h *Hub) SetSecrets(fn func(serverID string) []string) {
	h.mu.Lock()
	h.secrets = fn
	h.mu.Unlock()
}

func (h *Hub) secretsOf(serverID string) []string {
	h.mu.Lock()
	fn := h.secrets
	h.mu.Unlock()
	if fn == nil {
		return nil
	}
	var out []string
	for _, s := range fn(serverID) {
		if len(s) >= minSecretLen {
			out = append(out, s)
		}
	}
	return out
}

// redact sustituye cada aparición de un secreto por [oculto].
func redact(text string, secrets []string) string {
	for _, s := range secrets {
		if strings.Contains(text, s) {
			text = strings.ReplaceAll(text, s, redacted)
		}
	}
	return text
}

// Subscribe es SubscribeSub sin contador de descartes.
func (h *Hub) Subscribe(serverID, containerID string, tail int) (<-chan Line, func(), error) {
	s, err := h.SubscribeSub(serverID, containerID, tail)
	if err != nil {
		return nil, nil, err
	}
	return s.Lines, s.Close, nil
}

// SubscribeSub suscribe a los logs de serverID. El primer suscriptor abre
// `docker logs --follow` con `tail` líneas; los siguientes comparten el follower.
// Si containerID cambia respecto al follower vigente, este se cierra y se abre otro.
// Nunca devuelve una suscripción a un follower ya cerrado: en ese caso abre uno nuevo.
func (h *Hub) SubscribeSub(serverID, containerID string, tail int) (*Subscription, error) {
	for {
		h.mu.Lock()
		f := h.followers[serverID]
		if f != nil && f.containerID != containerID {
			f.close()
			delete(h.followers, serverID)
			f = nil
		}
		if f == nil {
			h.mu.Unlock()
			secrets := h.secretsOf(serverID)
			// Docker se consulta sin h.mu: un daemon lento no bloquea a otros servidores.
			ctx, cancel := context.WithCancel(context.Background())
			rc, err := h.eng.Logs(ctx, containerID, tail)
			if err != nil {
				cancel()
				return nil, err
			}
			h.mu.Lock()
			if cur := h.followers[serverID]; cur != nil {
				// Otro Subscribe se nos adelantó: descartamos nuestro stream y lo reintentamos.
				h.mu.Unlock()
				cancel()
				_ = rc.Close()
				continue
			}
			f = &follower{hub: h, serverID: serverID, containerID: containerID, secrets: secrets, cancel: cancel, subs: map[int]*subscriber{}}
			h.followers[serverID] = f
			go f.run(ctx, rc)
		}
		h.mu.Unlock()
		if s := f.subscribe(tail); s != nil {
			return s, nil
		}
		// El follower se cerró entre medias (gracia, EOF, Reset): se reintenta.
	}
}

func (h *Hub) Reset(serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if f, ok := h.followers[serverID]; ok {
		f.close()
		delete(h.followers, serverID)
	}
}

// drop cierra f y lo quita del mapa solo si sigue siendo el follower vigente.
func (h *Hub) drop(f *follower) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.followers[f.serverID] == f {
		delete(h.followers, f.serverID)
	}
	f.close()
}

// dropIfIdle comprueba que f sigue sin suscriptores y lo cierra, de forma atómica
// respecto a Subscribe (h.mu y luego f.mu, el mismo orden que drop).
func (h *Hub) dropIfIdle(f *follower) {
	h.mu.Lock()
	defer h.mu.Unlock()
	f.mu.Lock()
	idle := len(f.subs) == 0
	f.mu.Unlock()
	if !idle {
		return
	}
	if h.followers[f.serverID] == f {
		delete(h.followers, f.serverID)
	}
	f.close()
}

// subscribe devuelve nil si el follower ya está cerrado.
func (f *follower) subscribe(tail int) *Subscription {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil
	}
	if f.graceTimer != nil {
		f.graceTimer.Stop()
		f.graceTimer = nil
	}
	ch := make(chan Line, subBuffer)
	replay := f.ring
	if tail <= 0 {
		replay = nil
	} else if len(replay) > tail {
		replay = replay[len(replay)-tail:]
	}
	for _, l := range replay {
		ch <- l
	}
	s := &Subscription{Lines: ch}
	id := f.nextSub
	f.nextSub++
	f.subs[id] = &subscriber{ch: ch, sub: s}
	var once sync.Once
	s.unsub = func() {
		once.Do(func() {
			// h.mu antes que f.mu (mismo orden que drop), así que la gracia se lee antes.
			f.hub.mu.Lock()
			grace := f.hub.grace
			f.hub.mu.Unlock()
			f.mu.Lock()
			defer f.mu.Unlock()
			delete(f.subs, id)
			if len(f.subs) == 0 && !f.closed {
				f.graceTimer = time.AfterFunc(grace, func() {
					if hook := f.hub.graceHook; hook != nil {
						hook()
					}
					f.hub.dropIfIdle(f)
				})
			}
		})
	}
	return s
}

func (f *follower) run(ctx context.Context, rc io.ReadCloser) {
	defer rc.Close()
	go func() { <-ctx.Done(); rc.Close() }() // Close es idempotente en Fake y Moby
	br := bufio.NewReaderSize(rc, 64*1024)
	for {
		line, err := readLine(br)
		if line != nil {
			l := parseLine(string(line))
			l.Text = redact(l.Text, f.secrets)
			f.publish(l)
		}
		if err != nil {
			break
		}
	}
	f.hub.drop(f)
}

// readLine lee una línea; si supera maxLineBytes la trunca (con marcador) y descarta
// el resto en vez de abortar. Devuelve la última línea parcial junto con el error.
func readLine(br *bufio.Reader) ([]byte, error) {
	var buf []byte
	truncated := false
	for {
		chunk, isPrefix, err := br.ReadLine()
		if len(chunk) > 0 {
			if room := maxLineBytes - len(buf); room > 0 {
				if len(chunk) > room {
					chunk = chunk[:room]
					truncated = true
				}
				buf = append(buf, chunk...)
			} else {
				truncated = true
			}
		}
		if err != nil {
			if truncated {
				buf = append(buf, truncMarker...)
			}
			if len(buf) == 0 {
				return nil, err
			}
			return buf, err
		}
		if !isPrefix {
			if truncated {
				buf = append(buf, truncMarker...)
			}
			if buf == nil {
				buf = []byte{}
			}
			return buf, nil
		}
	}
}

func (f *follower) publish(l Line) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ring) == ringSize {
		copy(f.ring, f.ring[1:])
		f.ring = f.ring[:ringSize-1]
	}
	f.ring = append(f.ring, l)
	for _, s := range f.subs {
		select {
		case s.ch <- l:
		default: // suscriptor lento: se descarta y se cuenta para no bloquear al resto
			s.sub.dropped.Add(1)
		}
	}
}

func (f *follower) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.closed = true
	if f.graceTimer != nil {
		f.graceTimer.Stop()
		f.graceTimer = nil
	}
	f.cancel()
	for id, s := range f.subs {
		close(s.ch)
		delete(f.subs, id)
	}
}

// parseLine separa el timestamp RFC3339Nano que añade Docker ("2026-...Z texto").
// Las líneas de TTY pueden traer \r al final; se elimina.
func parseLine(raw string) Line {
	raw = strings.TrimRight(raw, "\r")
	ts, rest, ok := strings.Cut(raw, " ")
	if ok {
		if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			return Line{TS: t, Text: rest}
		}
	}
	return Line{TS: time.Now(), Text: raw}
}
