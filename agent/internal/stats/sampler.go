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
	tpsMaxAge           = 45 * time.Second // an older TPS is not sent
	tpsTop              = 20.0             // Minecraft's target TPS: anything above is capped
	tpsAccept           = 25.0             // above that, the output is not a reliable TPS and is discarded
	statsTimeout        = 3 * time.Second  // docker stats, container list and host reading
	defaultProbeTimeout = 4 * time.Second  // docker stats + SLP + a server's TPS
)

// Containers is what the sampler uses from Docker (docker.Engine satisfies it). The engine
// imposes no deadlines of its own: the sampler always passes a ctx with a deadline.
type Containers interface {
	ListManaged(ctx context.Context) ([]docker.Container, error)
	Stats(ctx context.Context, id string) (docker.Stats, error)
}

// Rcon is a persistent RCON session (*mc.RconConn satisfies it). It does not need to be safe
// for concurrent use: each session is used by a single goroutine at a time.
type Rcon interface {
	Command(ctx context.Context, command string) (string, error)
	Close() error
}

// DialRcon opens an authenticated RCON session.
type DialRcon func(ctx context.Context, host string, port uint16, password string) (Rcon, error)

var (
	_ Containers = docker.Engine(nil)
	_ Rcon       = (*mc.RconConn)(nil)
)

// Clock abstracts time to test Run without real waits.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// RealClock is the system clock.
var RealClock Clock = realClock{}

// Options are the sampler's dependencies. Status, Dial and the Rcon sessions must
// respect the ctx deadline: Sample waits for all the probes before returning.
type Options struct {
	Containers   Containers
	Host         HostReader
	DataRoot     string                                  // path whose filesystem is measured
	Status       mc.StatusFunc                           // Server List Ping
	Spec         func(serverID string) (spec.Spec, bool) // stored spec: type and RCON password
	Dial         DialRcon
	Send         func(*mcsmv1.Envelope) error
	Clock        Clock         // RealClock by default
	ProbeTimeout time.Duration // total deadline per server (stats + SLP + TPS); 4 s by default
	Log          *slog.Logger
}

// tpsProbe is the state of a server's TPS probe. During a Sample only the goroutine measuring
// that server touches it (one per server_id); between Samples, only Sample.
type tpsProbe struct {
	container string // container the session points to: if recreated, it is another process
	password  string
	conn      Rcon
	tried     time.Time // last attempt (zero: never)
	value     float64
	at        time.Time // when value was measured (zero: never)
	err       error     // result of the last attempt, to log it from Sample
}

func (p *tpsProbe) close() {
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
}

// target is a running server measured in this cycle. Its goroutine only writes
// to target and its tpsProbe; Sample reads the result after waiting for it.
type target struct {
	containerID, serverID, host string
	prev                        docker.Stats // last valid reading (if hasPrev)
	hasPrev                     bool
	probe                       *tpsProbe // nil if its type has no `tps`

	cur docker.Stats
	err error
	m   *mcsmv1.ServerMetricSample // nil if there is no sample to send
}

// failKey identifies a reading source to log its failures only once.
type failKey struct{ what, server string }

// Sampler gathers the metrics of the host and of running servers. Run is its only
// caller in production; Sample is serialized with a mutex just in case.
type Sampler struct {
	o        Options
	mu       sync.Mutex
	prevHost *CPUTimes
	prev     map[string]docker.Stats // last valid reading per container id
	tps      map[string]*tpsProbe    // per server_id
	failing  map[failKey]bool        // sources whose failure was already logged
}

// New creates a sampler.
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

// Run samples on every NextTick and sends the batch until ctx ends; on finishing it
// closes the RCON sessions. ctx must be the agent's life context (App.life), not
// a WS session's. If the panel is not connected the batch is dropped: nothing
// accumulates in memory.
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
				s.o.Log.Debug("metrics: batch dropped", "err", err)
			}
		}
	}
}

// Sample takes a reading at instant now. It returns nil if there is nothing to send: the
// first reading of each container (and of the host) only sets the CPU baseline.
//
// Each server is measured in its own goroutine with a total deadline of ProbeTimeout
// (docker stats, SLP and, if due, TPS), so a hung server or daemon does not
// delay the others nor extend the cycle beyond that deadline.
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
	s.report(ctx, failKey{what: "container list"}, err)
	if err != nil {
		return nonEmpty(b) // transient failure: state is not touched nor sessions closed
	}

	var targets []*target
	seen, running := map[string]bool{}, map[string]bool{} // per container / per server_id
	for _, c := range list {
		id := c.Labels[spec.LabelServerID]
		// A repeated server_id should not happen; if it does only the first is measured, so
		// that two goroutines do not share the same RCON session.
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
		return nil // shutting down: nothing to send or log
	}

	for _, t := range targets {
		s.report(ctx, failKey{"docker stats", t.serverID}, t.err)
		if t.err == nil && hasData(t.cur) { // a reading without data does not replace the baseline
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

// sampleHost reads the host. nil on the first reading or if the CPU fails; if memory
// or disk fail they are sent as 0 and the error is logged.
func (s *Sampler) sampleHost(ctx context.Context) *mcsmv1.HostMetricSample {
	hctx, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()
	cur, err := s.o.Host.CPUTimes(hctx)
	s.report(ctx, failKey{what: "host cpu"}, err)
	if err != nil {
		return nil
	}
	// HostCPUPercent does not distinguish the first reading (it would give the % since boot):
	// without a previous reading there is no sample.
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
	s.report(ctx, failKey{what: "host memory"}, memErr)
	h.DiskUsedBytes, h.DiskTotalBytes, diskErr = s.o.Host.Disk(hctx, s.o.DataRoot)
	s.report(ctx, failKey{what: "DATA_ROOT disk"}, diskErr)
	return h
}

// hasData: Docker returns a reading without host CPU clock (SystemCPUNs == 0) for
// a container that is no longer running. It is not a 0 %: it is ignored. MemLimit == 0 is
// a valid reading (host without a memory cgroup): it is sent with limit 0.
func hasData(st docker.Stats) bool { return st.SystemCPUNs != 0 }

// measure runs in its own goroutine: it reads docker stats, computes the CPU against the
// last valid reading and, if there is a sample, probes SLP and TPS. All within ProbeTimeout.
func (s *Sampler) measure(ctx context.Context, now time.Time, t *target) {
	ctx, cancel := context.WithTimeout(ctx, s.o.ProbeTimeout)
	defer cancel()
	sctx, scancel := context.WithTimeout(ctx, statsTimeout)
	t.cur, t.err = s.o.Containers.Stats(sctx, t.containerID)
	scancel()
	if t.err != nil || !hasData(t.cur) || !t.hasPrev {
		return
	}
	if t.cur.CPUTotalNs < t.prev.CPUTotalNs && t.probe != nil {
		// In-place restart (same id, Stop+Start or restart policy): it is another process,
		// just like a recreation. The RCON session and the previous TPS are discarded.
		*t.probe = tpsProbe{container: t.probe.container, password: t.probe.password, conn: t.probe.conn}
		t.probe.close()
	}
	pct, ok := ContainerCPUPercent(t.prev, t.cur)
	if !ok { // reset counters: this window is skipped
		return
	}
	t.m = &mcsmv1.ServerMetricSample{
		ServerId: t.serverID, CpuPct: round1(pct), MemBytes: t.cur.MemBytes, MemLimitBytes: t.cur.MemLimit,
		NetRxBytes: t.cur.NetRxBytes, NetTxBytes: t.cur.NetTxBytes,
	}
	s.probe(ctx, now, t)
}

// probeFor returns the TPS probe if the server's type supports it. It closes the RCON
// session if the password changed and discards it (with its last value) if the container was
// recreated. nil if it does not apply.
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

// hasTPS: only Paper and Purpur have the `tps` command (spec §6.4).
func hasTPS(serverType string) bool {
	return strings.EqualFold(serverType, "PAPER") || strings.EqualFold(serverType, "PURPUR")
}

// probe does the Server List Ping and, every 30 s and only if it responded, requests the TPS.
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

// measureTPS reuses the server's RCON session (or opens one) and runs `tps`. If the
// session fails it is closed and reopened on the next attempt.
func (s *Sampler) measureTPS(ctx context.Context, now time.Time, p *tpsProbe, host string) error {
	if p.conn == nil {
		c, err := s.o.Dial(ctx, host, spec.RconPort, p.password)
		if err == nil && c == nil {
			err = errors.New("rcon: nil session")
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
		return fmt.Errorf("unrecognized tps output: %.80q", out)
	}
	if v < 0 || v > tpsAccept {
		return fmt.Errorf("tps out of range: %g", v)
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

// report logs a source's first failure (even if the text changes on the
// following ones, e.g. because of an ephemeral port) and its recovery, so as not to repeat the same
// warning every 10 s. An error with an already finished ctx is shutdown, not a failure.
func (s *Sampler) report(ctx context.Context, k failKey, err error) {
	attrs := []any{}
	if k.server != "" {
		attrs = append(attrs, "server_id", k.server)
	}
	if err == nil {
		if s.failing[k] {
			delete(s.failing, k)
			s.o.Log.Info("metrics: "+k.what+" responds again", attrs...)
		}
		return
	}
	if ctx.Err() != nil {
		return
	}
	attrs = append(attrs, "err", err)
	if s.failing[k] {
		s.o.Log.Debug("metrics: "+k.what+" keeps failing", attrs...)
		return
	}
	s.failing[k] = true
	s.o.Log.Warn("metrics: failed to read "+k.what, attrs...)
}

func nonEmpty(b *mcsmv1.MetricBatch) *mcsmv1.MetricBatch {
	if b.Host == nil && len(b.Servers) == 0 {
		return nil
	}
	return b
}
