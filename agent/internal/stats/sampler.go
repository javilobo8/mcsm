package stats

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/mc"
	"mcsm/agent/internal/spec"
)

const (
	tpsEvery            = 30 * time.Second // spec §6.4
	tpsMaxAge           = 45 * time.Second // un TPS más antiguo no se envía
	tpsTop              = 20.0             // TPS objetivo de Minecraft: lo que pase de ahí se recorta
	tpsAccept           = 25.0             // por encima, la salida no es un TPS fiable y se descarta
	statsTimeout        = 3 * time.Second  // docker stats, lista de contenedores y lectura del host
	defaultProbeTimeout = 4 * time.Second  // docker stats + SLP + TPS de un servidor
)

// Containers es lo que el muestreador usa de Docker (docker.Engine lo cumple). El motor
// no impone plazos propios: el muestreador pasa siempre un ctx con plazo.
type Containers interface {
	ListManaged(ctx context.Context) ([]docker.Container, error)
	Stats(ctx context.Context, id string) (docker.Stats, error)
}

// Rcon es una sesión RCON persistente (*mc.RconConn la cumple). No necesita ser segura
// para uso concurrente: cada sesión la usa una sola goroutine a la vez.
type Rcon interface {
	Command(ctx context.Context, command string) (string, error)
	Close() error
}

// DialRcon abre una sesión RCON autenticada.
type DialRcon func(ctx context.Context, host string, port uint16, password string) (Rcon, error)

var (
	_ Containers = docker.Engine(nil)
	_ Rcon       = (*mc.RconConn)(nil)
)

// Clock abstrae el tiempo para probar Run sin esperas reales.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// RealClock es el reloj del sistema.
var RealClock Clock = realClock{}

// Options son las dependencias del muestreador. Status, Dial y las sesiones Rcon deben
// respetar el plazo del ctx: Sample espera a todos los sondeos antes de devolver.
type Options struct {
	Containers   Containers
	Host         HostReader
	DataRoot     string                                  // ruta cuyo sistema de ficheros se mide
	Status       mc.StatusFunc                           // Server List Ping
	Spec         func(serverID string) (spec.Spec, bool) // spec guardada: tipo y contraseña RCON
	Dial         DialRcon
	Send         func(*mcsmv1.Envelope) error
	Clock        Clock         // por defecto RealClock
	ProbeTimeout time.Duration // plazo total por servidor (stats + SLP + TPS); por defecto 4 s
	Log          *slog.Logger
}

// tpsProbe es el estado del sondeo de TPS de un servidor. Durante un Sample solo lo toca
// la goroutine que mide ese servidor (una por server_id); entre Samples, solo Sample.
type tpsProbe struct {
	container string // contenedor al que apunta la sesión: si se recrea, es otro proceso
	password  string
	conn      Rcon
	tried     time.Time // último intento (cero: nunca)
	value     float64
	at        time.Time // cuándo se midió value (cero: nunca)
	err       error     // resultado del último intento, para registrarlo desde Sample
}

func (p *tpsProbe) close() {
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
}

// target es un servidor en marcha que se mide en este ciclo. Su goroutine solo escribe
// en target y en su tpsProbe; Sample lee el resultado tras esperarla.
type target struct {
	containerID, serverID, host string
	prev                        docker.Stats // última lectura válida (si hasPrev)
	hasPrev                     bool
	probe                       *tpsProbe // nil si su tipo no tiene `tps`

	cur docker.Stats
	err error
	m   *mcsmv1.ServerMetricSample // nil si no hay muestra que enviar
}

// failKey identifica una fuente de lectura para registrar sus fallos una sola vez.
type failKey struct{ what, server string }

// Sampler reúne las métricas del host y de los servidores en marcha. Run es su único
// llamador en producción; Sample se serializa con un mutex por si acaso.
type Sampler struct {
	o        Options
	mu       sync.Mutex
	prevHost *CPUTimes
	prev     map[string]docker.Stats // última lectura válida por id de contenedor
	tps      map[string]*tpsProbe    // por server_id
	failing  map[failKey]bool        // fuentes cuyo fallo ya se registró
}

// New crea un muestreador.
func New(o Options) *Sampler {
	if o.Clock == nil {
		o.Clock = RealClock
	}
	if o.ProbeTimeout <= 0 {
		o.ProbeTimeout = defaultProbeTimeout
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Sampler{o: o, prev: map[string]docker.Stats{}, tps: map[string]*tpsProbe{}, failing: map[failKey]bool{}}
}

// Run muestrea en cada NextTick y envía el lote hasta que ctx termina; al terminar
// cierra las sesiones RCON. ctx debe ser el contexto de vida del agente (App.life), no
// el de una sesión WS. Si el panel no está conectado el lote se descarta: no se acumula
// nada en memoria.
func (s *Sampler) Run(ctx context.Context) {
	defer s.closeAll()
	for {
		now := s.o.Clock.Now()
		select {
		case <-ctx.Done():
			return
		case t := <-s.o.Clock.After(NextTick(now).Sub(now)):
			b := s.Sample(ctx, t)
			if b == nil {
				continue
			}
			if err := s.o.Send(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_MetricBatch{MetricBatch: b}}); err != nil {
				s.o.Log.Debug("métricas: lote descartado", "err", err)
			}
		}
	}
}

// Sample toma una lectura en el instante now. Devuelve nil si no hay nada que enviar: la
// primera lectura de cada contenedor (y del host) solo fija la base de la CPU.
//
// Cada servidor se mide en su propia goroutine con un plazo total de ProbeTimeout
// (docker stats, SLP y, si toca, TPS), así que un servidor o un daemon colgado no
// retrasa a los demás ni alarga el ciclo más de ese plazo.
func (s *Sampler) Sample(ctx context.Context, now time.Time) *mcsmv1.MetricBatch {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		return nil
	}
	b := &mcsmv1.MetricBatch{TsUnix: RoundTS(now), Host: s.sampleHost(ctx)}
	lctx, cancel := context.WithTimeout(ctx, statsTimeout)
	list, err := s.o.Containers.ListManaged(lctx)
	cancel()
	s.report(ctx, failKey{what: "lista de contenedores"}, err)
	if err != nil {
		return nonEmpty(b) // fallo pasajero: no se toca el estado ni se cierran sesiones
	}

	var targets []*target
	seen, running := map[string]bool{}, map[string]bool{} // por contenedor / por server_id
	for _, c := range list {
		id := c.Labels[spec.LabelServerID]
		// Un server_id repetido no debe ocurrir; si ocurre se mide solo el primero, para
		// que dos goroutines no compartan la misma sesión RCON.
		if id == "" || c.State != "running" || running[id] {
			continue
		}
		seen[c.ID], running[id] = true, true
		prev, had := s.prev[c.ID]
		targets = append(targets, &target{
			containerID: c.ID, serverID: id, host: spec.ContainerName(c.Labels[spec.LabelSlug]),
			prev: prev, hasPrev: had, probe: s.probeFor(id, c.ID),
		})
	}
	var wg sync.WaitGroup
	for _, t := range targets {
		wg.Go(func() { s.measure(ctx, now, t) })
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil // apagando: nada que enviar ni que registrar
	}

	for _, t := range targets {
		s.report(ctx, failKey{"docker stats", t.serverID}, t.err)
		if t.err == nil && hasData(t.cur) { // una lectura sin datos no sustituye a la base
			s.prev[t.containerID] = t.cur
		}
		if t.probe != nil {
			s.report(ctx, failKey{"tps", t.serverID}, t.probe.err)
		}
		if t.m != nil {
			b.Servers = append(b.Servers, t.m)
		}
	}
	for cid := range s.prev {
		if !seen[cid] {
			delete(s.prev, cid)
		}
	}
	for id, p := range s.tps {
		if !running[id] {
			p.close()
			delete(s.tps, id)
		}
	}
	for k := range s.failing {
		if k.server != "" && !running[k.server] {
			delete(s.failing, k)
		}
	}
	return nonEmpty(b)
}

// sampleHost lee el host. nil en la primera lectura o si falla la CPU; si fallan memoria
// o disco se envían a 0 y se registra el error.
func (s *Sampler) sampleHost(ctx context.Context) *mcsmv1.HostMetricSample {
	hctx, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()
	cur, err := s.o.Host.CPUTimes(hctx)
	s.report(ctx, failKey{what: "cpu del host"}, err)
	if err != nil {
		return nil
	}
	// HostCPUPercent no distingue la primera lectura (daría el % desde el arranque):
	// sin lectura previa no hay muestra.
	prev := s.prevHost
	s.prevHost = &cur
	if prev == nil {
		return nil
	}
	pct, ok := HostCPUPercent(*prev, cur)
	if !ok {
		return nil
	}
	h := &mcsmv1.HostMetricSample{CpuPct: round1(pct)}
	var memErr, diskErr error
	h.MemUsedBytes, h.MemTotalBytes, memErr = s.o.Host.Memory(hctx)
	s.report(ctx, failKey{what: "memoria del host"}, memErr)
	h.DiskUsedBytes, h.DiskTotalBytes, diskErr = s.o.Host.Disk(hctx, s.o.DataRoot)
	s.report(ctx, failKey{what: "disco de DATA_ROOT"}, diskErr)
	return h
}

// hasData: Docker devuelve una lectura a ceros (sin límite de memoria ni reloj de CPU
// del host) para un contenedor que ya no está en marcha. No es un 0 %: se ignora.
func hasData(st docker.Stats) bool { return st.SystemCPUNs != 0 && st.MemLimit != 0 }

// measure corre en su propia goroutine: lee docker stats, calcula la CPU respecto a la
// última lectura válida y, si hay muestra, sondea SLP y TPS. Todo dentro de ProbeTimeout.
func (s *Sampler) measure(ctx context.Context, now time.Time, t *target) {
	ctx, cancel := context.WithTimeout(ctx, s.o.ProbeTimeout)
	defer cancel()
	sctx, scancel := context.WithTimeout(ctx, statsTimeout)
	t.cur, t.err = s.o.Containers.Stats(sctx, t.containerID)
	scancel()
	if t.err != nil || !hasData(t.cur) || !t.hasPrev {
		return
	}
	pct, ok := ContainerCPUPercent(t.prev, t.cur)
	if !ok { // contadores reiniciados: esta ventana se omite
		return
	}
	t.m = &mcsmv1.ServerMetricSample{
		ServerId: t.serverID, CpuPct: round1(pct), MemBytes: t.cur.MemBytes, MemLimitBytes: t.cur.MemLimit,
		NetRxBytes: t.cur.NetRxBytes, NetTxBytes: t.cur.NetTxBytes,
	}
	s.probe(ctx, now, t)
}

// probeFor devuelve el sondeo de TPS si el tipo del servidor lo admite. Cierra la sesión
// RCON si la contraseña cambió y la descarta (con su último valor) si el contenedor se
// recreó. nil si no aplica.
func (s *Sampler) probeFor(serverID, containerID string) *tpsProbe {
	p := s.tps[serverID]
	sp, ok := s.o.Spec(serverID)
	if !ok || !hasTPS(sp.Type) {
		if p != nil {
			p.close()
			delete(s.tps, serverID)
		}
		return nil
	}
	if p != nil && p.container != containerID {
		p.close()
		p = nil
	}
	if p == nil {
		p = &tpsProbe{container: containerID, password: sp.RconPassword}
		s.tps[serverID] = p
	}
	if p.password != sp.RconPassword {
		p.close()
		p.password = sp.RconPassword
	}
	return p
}

// hasTPS: solo Paper y Purpur tienen el comando `tps` (spec §6.4).
func hasTPS(serverType string) bool {
	return strings.EqualFold(serverType, "PAPER") || strings.EqualFold(serverType, "PURPUR")
}

// probe hace el Server List Ping y, cada 30 s y solo si respondió, pide el TPS.
func (s *Sampler) probe(ctx context.Context, now time.Time, t *target) {
	st := s.o.Status(ctx, t.host, spec.GamePort)
	if st == nil || !st.Online {
		return
	}
	t.m.McOnline = true
	t.m.PlayersOnline, t.m.PlayersMax, t.m.PingMs = st.PlayersOnline, st.PlayersMax, st.LatencyMs
	p := t.probe
	if p == nil {
		return
	}
	if since := now.Sub(p.tried); p.tried.IsZero() || since >= tpsEvery || since < 0 {
		p.tried = now
		p.err = s.measureTPS(ctx, now, p, t.host)
	}
	if !p.at.IsZero() && now.Sub(p.at) <= tpsMaxAge {
		v := p.value
		t.m.Tps = &v
	}
}

// measureTPS reutiliza la sesión RCON del servidor (o abre una) y ejecuta `tps`. Si la
// sesión falla se cierra y se reabre en el siguiente intento.
func (s *Sampler) measureTPS(ctx context.Context, now time.Time, p *tpsProbe, host string) error {
	if p.conn == nil {
		c, err := s.o.Dial(ctx, host, spec.RconPort, p.password)
		if err == nil && c == nil {
			err = errors.New("rcon: sesión nula")
		}
		if err != nil {
			return err
		}
		p.conn = c
	}
	out, err := p.conn.Command(ctx, "tps")
	if err != nil {
		p.close()
		return err
	}
	v, ok := mc.ParseTPS(out)
	if !ok {
		return fmt.Errorf("salida de tps no reconocida: %.80q", out)
	}
	if v < 0 || v > tpsAccept {
		return fmt.Errorf("tps fuera de rango: %g", v)
	}
	p.value, p.at = math.Min(v, tpsTop), now
	return nil
}

func (s *Sampler) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.tps {
		p.close()
		delete(s.tps, id)
	}
}

// report registra el primer fallo de una fuente (aunque el texto cambie en los
// siguientes, p. ej. por un puerto efímero) y su recuperación, para no repetir el mismo
// aviso cada 10 s. Un error con ctx ya terminado es el apagado, no un fallo.
func (s *Sampler) report(ctx context.Context, k failKey, err error) {
	attrs := []any{}
	if k.server != "" {
		attrs = append(attrs, "server_id", k.server)
	}
	if err == nil {
		if s.failing[k] {
			delete(s.failing, k)
			s.o.Log.Info("métricas: "+k.what+" vuelve a responder", attrs...)
		}
		return
	}
	if ctx.Err() != nil {
		return
	}
	attrs = append(attrs, "err", err)
	if s.failing[k] {
		s.o.Log.Debug("métricas: "+k.what+" sigue fallando", attrs...)
		return
	}
	s.failing[k] = true
	s.o.Log.Warn("métricas: fallo al leer "+k.what, attrs...)
}

func nonEmpty(b *mcsmv1.MetricBatch) *mcsmv1.MetricBatch {
	if b.Host == nil && len(b.Servers) == 0 {
		return nil
	}
	return b
}
