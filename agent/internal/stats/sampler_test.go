package stats

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
)

// ── fakes ────────────────────────────────────────────────────────────────────

type fakeHost struct {
	mu  sync.Mutex
	cpu []CPUTimes // one reading per call; the last one repeats
	err error
}

func (h *fakeHost) CPUTimes(context.Context) (CPUTimes, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.err != nil {
		return CPUTimes{}, h.err
	}
	c := h.cpu[0]
	if len(h.cpu) > 1 {
		h.cpu = h.cpu[1:]
	}
	return c, nil
}
func (h *fakeHost) Memory(context.Context) (uint64, uint64, error) { return 6 << 30, 16 << 30, nil }
func (h *fakeHost) Disk(_ context.Context, path string) (uint64, uint64, error) {
	if path != "/srv/minecraft" {
		return 0, 0, errors.New("unexpected path " + path)
	}
	return 100 << 30, 500 << 30, nil
}

type fakeRcon struct {
	mu      sync.Mutex
	outputs []string // responses to `tps`, in order; the last one repeats
	cmds    int
	closed  bool
	fail    bool
}

func (r *fakeRcon) Command(_ context.Context, cmd string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return "", errors.New("closed")
	}
	if r.fail {
		return "", errors.New("broken connection")
	}
	r.cmds++
	out := r.outputs[0]
	if len(r.outputs) > 1 {
		r.outputs = r.outputs[1:]
	}
	return out, nil
}
func (r *fakeRcon) Close() error { r.mu.Lock(); r.closed = true; r.mu.Unlock(); return nil }

// engine wraps the fake engine: it requires a deadline on every call (the real engine does not
// impose its own timeout), lets ListManaged fail and Stats hang.
type engine struct {
	*docker.Fake
	t       *testing.T
	mu      sync.Mutex
	listErr error
	hung    map[string]bool // Stats of these containers does not respond until ctx expires
}

func (e *engine) ListManaged(ctx context.Context) ([]docker.Container, error) {
	if _, ok := ctx.Deadline(); !ok {
		e.t.Error("ListManaged without a deadline")
	}
	e.mu.Lock()
	err := e.listErr
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return e.Fake.ListManaged(ctx)
}

func (e *engine) Stats(ctx context.Context, id string) (docker.Stats, error) {
	if _, ok := ctx.Deadline(); !ok {
		e.t.Error("Stats without a deadline")
	}
	e.mu.Lock()
	hung := e.hung[id]
	e.mu.Unlock()
	if hung {
		<-ctx.Done()
		return docker.Stats{}, ctx.Err()
	}
	return e.Fake.Stats(ctx, id)
}

func (e *engine) setListErr(err error) { e.mu.Lock(); e.listErr = err; e.mu.Unlock() }
func (e *engine) hang(id string, on bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.hung == nil {
		e.hung = map[string]bool{}
	}
	e.hung[id] = on
}

type world struct {
	t      *testing.T
	eng    *docker.Fake
	ctr    *engine
	host   *fakeHost
	mu     sync.Mutex
	online map[string]*mcsmv1.McStatus // per host (mcsm-<slug>)
	specs  map[string]spec.Spec
	dials  []string // "host:port:password"
	conns  []*fakeRcon
	rcon   func() *fakeRcon
	s      *Sampler
}

func newWorld(t *testing.T) *world {
	w := &world{t: t, eng: docker.NewFake(), host: &fakeHost{cpu: []CPUTimes{{Busy: 100, Total: 1000}, {Busy: 150, Total: 1100}}},
		online: map[string]*mcsmv1.McStatus{}, specs: map[string]spec.Spec{}}
	w.ctr = &engine{Fake: w.eng, t: t}
	w.rcon = func() *fakeRcon {
		return &fakeRcon{outputs: []string{"§6TPS from last 1m, 5m, 15m: §a19.5, §a20.0, §a20.0"}}
	}
	w.s = New(Options{
		Containers: w.ctr, Host: w.host, DataRoot: "/srv/minecraft",
		Status: func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
			if port != spec.GamePort {
				t.Errorf("SLP to port %d", port)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Error("SLP without a deadline")
			}
			w.mu.Lock()
			defer w.mu.Unlock()
			if st := w.online[host]; st != nil {
				return st
			}
			return &mcsmv1.McStatus{}
		},
		Spec: func(id string) (spec.Spec, bool) {
			w.mu.Lock()
			defer w.mu.Unlock()
			sp, ok := w.specs[id]
			return sp, ok
		},
		Dial: func(ctx context.Context, host string, port uint16, pw string) (Rcon, error) {
			if _, ok := ctx.Deadline(); !ok {
				t.Error("RCON without a deadline")
			}
			w.mu.Lock()
			defer w.mu.Unlock()
			w.dials = append(w.dials, host+":"+strconv.Itoa(int(port))+":"+pw)
			c := w.rcon()
			w.conns = append(w.conns, c)
			return c, nil
		},
		Send: func(*mcsmv1.Envelope) error { return nil },
		Log:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return w
}

// server creates a managed container and starts it if running.
func (w *world) server(id, slug, typ string, running bool) string {
	w.t.Helper()
	ctx := context.Background()
	cid, err := w.eng.Create(ctx, spec.ContainerName(slug), &container.Config{Labels: map[string]string{
		spec.LabelManaged: "true", spec.LabelServerID: id, spec.LabelSlug: slug,
	}}, &container.HostConfig{}, nil)
	if err != nil {
		w.t.Fatal(err)
	}
	if running {
		if err := w.eng.Start(ctx, cid); err != nil {
			w.t.Fatal(err)
		}
	}
	w.mu.Lock()
	w.specs[id] = spec.Spec{Type: typ, RconPassword: "pw-" + id}
	w.mu.Unlock()
	return cid
}

func (w *world) setOnline(slug string, players, max, ping uint32) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.online[spec.ContainerName(slug)] = &mcsmv1.McStatus{Online: true, PlayersOnline: players, PlayersMax: max, LatencyMs: ping}
}

func find(b *mcsmv1.MetricBatch, id string) *mcsmv1.ServerMetricSample {
	for _, s := range b.GetServers() {
		if s.ServerId == id {
			return s
		}
	}
	return nil
}

// st is a valid one-core reading (without memory data: MemLimit == 0 does not
// invalidate it).
func st(cpuNs, sysNs uint64) docker.Stats {
	return docker.Stats{CPUTotalNs: cpuNs, SystemCPUNs: sysNs, OnlineCPUs: 1}
}

var t0 = time.Date(2026, 10, 12, 10, 0, 5, 0, time.UTC)

// ── tests ────────────────────────────────────────────────────────────────────

func TestSampleNeedsTwoReadings(t *testing.T) {
	w := newWorld(t)
	cid := w.server("a", "alpha", "VANILLA", true)
	w.setOnline("alpha", 3, 20, 4)
	w.eng.SetStats(cid, docker.Stats{CPUTotalNs: 1e9, SystemCPUNs: 10e9, OnlineCPUs: 4, MemBytes: 1 << 30, MemLimit: 3 << 30, NetRxBytes: 10, NetTxBytes: 20})
	ctx := context.Background()
	if b := w.s.Sample(ctx, t0); b != nil {
		t.Fatalf("the first reading must not send anything: %v", b)
	}
	w.eng.SetStats(cid, docker.Stats{CPUTotalNs: 3e9, SystemCPUNs: 30e9, OnlineCPUs: 4, MemBytes: 2 << 30, MemLimit: 3 << 30, NetRxBytes: 110, NetTxBytes: 220})
	b := w.s.Sample(ctx, t0.Add(10*time.Second))
	if b == nil {
		t.Fatal("the second reading must send a batch")
	}
	if b.TsUnix != time.Date(2026, 10, 12, 10, 0, 10, 0, time.UTC).Unix() {
		t.Fatalf("ts = %d", b.TsUnix)
	}
	if b.Host == nil || b.Host.CpuPct != 50 || b.Host.MemUsedBytes != 6<<30 || b.Host.MemTotalBytes != 16<<30 || b.Host.DiskUsedBytes != 100<<30 || b.Host.DiskTotalBytes != 500<<30 {
		t.Fatalf("host = %+v", b.Host)
	}
	m := find(b, "a")
	if m == nil {
		t.Fatalf("missing server: %v", b)
	}
	if m.CpuPct != 40 || m.MemBytes != 2<<30 || m.MemLimitBytes != 3<<30 || m.NetRxBytes != 110 || m.NetTxBytes != 220 {
		t.Fatalf("sample = %+v", m)
	}
	if !m.McOnline || m.PlayersOnline != 3 || m.PlayersMax != 20 || m.PingMs != 4 {
		t.Fatalf("SLP = %+v", m)
	}
	if m.Tps != nil || len(w.dials) != 0 {
		t.Fatalf("VANILLA must not request TPS: tps=%v dials=%v", m.Tps, w.dials)
	}
}

func TestSampleSkipsStoppedUnlabeledAndResetCounters(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	run := w.server("a", "alpha", "VANILLA", true)
	stopped := w.server("b", "beta", "VANILLA", false)
	w.eng.SetStats(stopped, docker.Stats{CPUTotalNs: 1, SystemCPUNs: 1})
	// managed container without server_id: ignored
	if _, err := w.eng.Create(ctx, "mcsm-odd", &container.Config{Labels: map[string]string{spec.LabelManaged: "true"}}, &container.HostConfig{}, nil); err != nil {
		t.Fatal(err)
	}
	w.eng.SetStats(run, st(5e9, 10e9))
	w.s.Sample(ctx, t0)
	// the container restarted: its accumulated CPU starts over
	w.eng.SetStats(run, st(1e9, 20e9))
	b := w.s.Sample(ctx, t0.Add(10*time.Second))
	if find(b, "a") != nil {
		t.Fatalf("with reset counters no sample is sent: %+v", find(b, "a"))
	}
	if find(b, "b") != nil || len(b.Servers) != 0 {
		t.Fatalf("running servers only: %v", b.Servers)
	}
	w.eng.SetStats(run, st(2e9, 30e9))
	b = w.s.Sample(ctx, t0.Add(20*time.Second))
	if m := find(b, "a"); m == nil || m.CpuPct != 10 || m.McOnline {
		t.Fatalf("after the restart it measures again (10 %%, no SLP): %+v", m)
	}
}

// A reading without data (SystemCPUNs == 0: that of a stopped container, or all zero) is not
// a 0 %: it is not sent and does not replace the last valid reading as the CPU baseline.
func TestNoDataReadingIsSkippedAndKeepsBase(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cid := w.server("a", "alpha", "VANILLA", true)
	w.eng.SetStats(cid, st(1e9, 10e9))
	w.s.Sample(ctx, t0)
	empties := []docker.Stats{
		{},
		{CPUTotalNs: 2e9, OnlineCPUs: 1, MemBytes: 1 << 20, MemLimit: 1 << 30},
	}
	for i, e := range empties {
		w.eng.SetStats(cid, e)
		if m := find(w.s.Sample(ctx, t0.Add(time.Duration(i+1)*10*time.Second)), "a"); m != nil {
			t.Fatalf("reading without data %d sent: %+v", i, m)
		}
	}
	w.eng.SetStats(cid, st(4e9, 40e9))
	if m := find(w.s.Sample(ctx, t0.Add(40*time.Second)), "a"); m == nil || m.CpuPct != 10 {
		t.Fatalf("the baseline must remain the last valid reading (10 %%): %+v", m)
	}
}

// Without a memory cgroup (e.g. Raspberry Pi OS without cgroup_enable=memory) Docker gives a valid
// CPU and MemLimit == 0: the sample is sent with limit 0 ("no known limit").
func TestZeroMemLimitWithValidCPUIsSent(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cid := w.server("a", "alpha", "VANILLA", true)
	w.eng.SetStats(cid, docker.Stats{CPUTotalNs: 1e9, SystemCPUNs: 10e9, OnlineCPUs: 2})
	w.s.Sample(ctx, t0)
	w.eng.SetStats(cid, docker.Stats{CPUTotalNs: 2e9, SystemCPUNs: 20e9, OnlineCPUs: 2, MemBytes: 512 << 20, NetRxBytes: 7})
	m := find(w.s.Sample(ctx, t0.Add(10*time.Second)), "a")
	if m == nil || m.CpuPct != 20 || m.MemBytes != 512<<20 || m.MemLimitBytes != 0 || m.NetRxBytes != 7 {
		t.Fatalf("sample with MemLimit 0 = %+v", m)
	}
}

func TestTPSOnlyPaperPurpurEvery30sOverOneSession(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	paper := w.server("p", "paper", "paper", true)
	purpur := w.server("u", "purple", "PURPUR", true)
	for _, cid := range []string{paper, purpur} {
		w.eng.SetStats(cid, st(1e9, 10e9))
	}
	w.setOnline("paper", 0, 20, 1)
	w.s.Sample(ctx, t0) // base
	for i := 1; i <= 7; i++ {
		for _, cid := range []string{paper, purpur} {
			w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		}
		b := w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second))
		p := find(b, "p")
		if p == nil || p.Tps == nil || *p.Tps != 19.5 {
			t.Fatalf("cycle %d: online Paper must carry TPS 19.5: %+v", i, p)
		}
		if u := find(b, "u"); u == nil || u.Tps != nil || u.McOnline {
			t.Fatalf("cycle %d: Purpur without SLP does not probe TPS: %+v", i, u)
		}
	}
	// t0+10 (1st measurement), t0+40 and t0+70: three `tps` over the same session.
	if len(w.dials) != 1 || w.dials[0] != "mcsm-paper:25575:pw-p" {
		t.Fatalf("dials = %v", w.dials)
	}
	if w.conns[0].cmds != 3 {
		t.Fatalf("tps commands = %d, want 3 (every 30 s)", w.conns[0].cmds)
	}
}

func TestTPSReconnectsAfterErrorAndStaleValueExpires(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cid := w.server("p", "paper", "PAPER", true)
	w.setOnline("paper", 0, 20, 1)
	step := func(i int) *mcsmv1.ServerMetricSample {
		w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		return find(w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second)), "p")
	}
	step(0)
	if m := step(1); m.Tps == nil { // measured at t0+10
		t.Fatal("must measure TPS")
	}
	w.conns[0].mu.Lock()
	w.conns[0].fail = true // the server restarts: the session breaks
	w.conns[0].mu.Unlock()
	w.rcon = func() *fakeRcon { return &fakeRcon{outputs: []string{"TPS from last 1m, 5m, 15m: 18.0, 20.0, 20.0"}} }
	for i := 2; i <= 5; i++ { // at t0+40 the probe fails; the t0+10 value stays valid until t0+55
		if m := step(i); m.Tps == nil || *m.Tps != 19.5 {
			t.Fatalf("cycle %d: tps = %v, want 19.5", i, m.Tps)
		}
	}
	if !w.conns[0].closed {
		t.Fatal("the broken session must be closed")
	}
	if m := step(6); m.Tps != nil { // t0+60: the last good value is 50 s old
		t.Fatalf("a TPS older than 45 s is not sent: %v", *m.Tps)
	}
	if m := step(7); m.Tps == nil || *m.Tps != 18 { // t0+70: retry with a new session
		t.Fatalf("after reconnecting: %+v", m)
	}
	if len(w.dials) != 2 {
		t.Fatalf("dials = %v, want 2", w.dials)
	}
}

// Paper/Purpur TPS ranges from 0 to 20: a slightly higher value is capped to 20 and an
// absurd one is discarded without breaking the session.
func TestTPSClampedAndOutOfRangeDropped(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.rcon = func() *fakeRcon {
		return &fakeRcon{outputs: []string{"TPS from last 1m, 5m, 15m: 99.0, 20.0, 20.0", "TPS from last 1m, 5m, 15m: 20.4, 20.0, 20.0"}}
	}
	cid := w.server("p", "paper", "PAPER", true)
	w.setOnline("paper", 0, 20, 1)
	step := func(i int) *mcsmv1.ServerMetricSample {
		w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		return find(w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second)), "p")
	}
	step(0)
	if m := step(1); m == nil || m.Tps != nil {
		t.Fatalf("an out-of-range TPS is not sent: %+v", m)
	}
	step(2)
	step(3)
	if m := step(4); m == nil || m.Tps == nil || *m.Tps != 20 {
		t.Fatalf("20.4 is capped to 20: %+v", m)
	}
	if len(w.dials) != 1 || w.conns[0].closed {
		t.Fatalf("an out-of-range value does not close the session: dials=%v", w.dials)
	}
}

func TestTPSSessionClosedWhenServerStopsOrPasswordChanges(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cid := w.server("p", "paper", "PAPER", true)
	w.setOnline("paper", 0, 20, 1)
	for i := 0; i <= 1; i++ {
		w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second))
	}
	w.mu.Lock()
	w.specs["p"] = spec.Spec{Type: "PAPER", RconPassword: "new"}
	w.mu.Unlock()
	w.eng.SetStats(cid, st(3e9, 30e9))
	w.s.Sample(ctx, t0.Add(20*time.Second))
	if !w.conns[0].closed {
		t.Fatal("changing the RCON password closes the session")
	}
	if err := w.eng.Stop(ctx, cid, time.Second); err != nil {
		t.Fatal(err)
	}
	w.s.Sample(ctx, t0.Add(50*time.Second)) // tps due: would reopen if it were still running
	if len(w.dials) != 1 {
		t.Fatalf("a stopped server is not probed: dials = %v", w.dials)
	}
	if len(w.s.tps) != 0 || len(w.s.prev) != 0 {
		t.Fatalf("a stopped server's state is forgotten: tps=%d prev=%d", len(w.s.tps), len(w.s.prev))
	}
}

// If the container is recreated between two ticks (spec change), the RCON session points to the
// old process: it is closed and the TPS is measured again right away with a new session.
func TestTPSSessionResetWhenContainerRecreated(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cid := w.server("p", "paper", "PAPER", true)
	w.setOnline("paper", 0, 20, 1)
	for i := 0; i <= 1; i++ {
		w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second))
	}
	if err := w.eng.Remove(ctx, cid); err != nil {
		t.Fatal(err)
	}
	w.rcon = func() *fakeRcon { return &fakeRcon{outputs: []string{"TPS from last 1m, 5m, 15m: 17.0, 20.0, 20.0"}} }
	nid := w.server("p", "paper", "PAPER", true)
	for i := 2; i <= 3; i++ {
		w.eng.SetStats(nid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		m := find(w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second)), "p")
		if i == 2 && m != nil {
			t.Fatalf("first reading of the new container: %+v", m)
		}
		if i == 3 && (m == nil || m.Tps == nil || *m.Tps != 17) {
			t.Fatalf("TPS of the new process: %+v", m)
		}
	}
	if !w.conns[0].closed || len(w.dials) != 2 {
		t.Fatalf("old session closed and a new one: closed=%v dials=%v", w.conns[0].closed, w.dials)
	}
}

func TestHungServerDoesNotBlockOthers(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	a := w.server("a", "alpha", "VANILLA", true)
	b := w.server("b", "beta", "VANILLA", true)
	w.setOnline("beta", 1, 10, 2)
	w.s.o.ProbeTimeout = 50 * time.Millisecond
	slow := w.s.o.Status
	w.s.o.Status = func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
		if host == "mcsm-alpha" {
			<-ctx.Done() // hung server: does not respond until the timeout
			return &mcsmv1.McStatus{}
		}
		return slow(ctx, host, port)
	}
	for i := 0; i <= 1; i++ {
		for _, cid := range []string{a, b} {
			w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		}
		w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second))
	}
	w.eng.SetStats(a, st(3e9, 30e9))
	w.eng.SetStats(b, st(3e9, 30e9))
	start := time.Now()
	batch := w.s.Sample(ctx, t0.Add(20*time.Second))
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("Sample took %s with a hung server", took)
	}
	if m := find(batch, "a"); m == nil || m.McOnline {
		t.Fatalf("the hung one is sent without SLP: %+v", m)
	}
	if m := find(batch, "b"); m == nil || !m.McOnline || m.PlayersOnline != 1 {
		t.Fatalf("the healthy one keeps its SLP: %+v", m)
	}
}

// docker stats of a container that does not respond does not delay the others beyond the per-server
// deadline, and does not spoil its CPU baseline.
func TestHungDockerStatsDoesNotBlockOthers(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	a := w.server("a", "alpha", "VANILLA", true)
	b := w.server("b", "beta", "VANILLA", true)
	w.setOnline("beta", 1, 10, 2)
	w.s.o.ProbeTimeout = 50 * time.Millisecond
	for i := 0; i <= 1; i++ {
		for _, cid := range []string{a, b} {
			w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		}
		w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second))
	}
	w.ctr.hang(a, true)
	w.eng.SetStats(b, st(3e9, 30e9))
	start := time.Now()
	batch := w.s.Sample(ctx, t0.Add(20*time.Second))
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("Sample took %s with docker stats hung", took)
	}
	if find(batch, "a") != nil {
		t.Fatalf("without a reading there is no sample: %+v", find(batch, "a"))
	}
	if m := find(batch, "b"); m == nil || !m.McOnline || m.CpuPct != 10 {
		t.Fatalf("the healthy one is measured as usual: %+v", m)
	}
	w.ctr.hang(a, false)
	w.eng.SetStats(a, st(4e9, 40e9)) // base: (2e9, 20e9)
	if m := find(w.s.Sample(ctx, t0.Add(30*time.Second)), "a"); m == nil || m.CpuPct != 10 {
		t.Fatalf("when it responds it measures against the last good reading: %+v", m)
	}
}

func TestHostErrorsAndDockerErrors(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.host.err = errors.New("no /proc")
	if b := w.s.Sample(ctx, t0); b != nil {
		t.Fatalf("without host or servers nothing is sent: %v", b)
	}
	w.host.err = nil
	w.s.Sample(ctx, t0.Add(10*time.Second))
	w.eng.StatsErr = errors.New("daemon busy")
	w.server("a", "alpha", "VANILLA", true)
	b := w.s.Sample(ctx, t0.Add(20*time.Second))
	if b == nil || b.Host == nil || len(b.Servers) != 0 {
		t.Fatalf("with docker stats failing only the host is sent: %v", b)
	}
}

// A transient failure when listing containers does not delete CPU baselines or close sessions.
func TestListErrorKeepsState(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cid := w.server("p", "paper", "PAPER", true)
	w.setOnline("paper", 0, 20, 1)
	for i := 0; i <= 1; i++ {
		w.eng.SetStats(cid, st(uint64(1+i)*1e9, uint64(10+10*i)*1e9))
		w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second))
	}
	w.ctr.setListErr(errors.New("daemon down"))
	if m := find(w.s.Sample(ctx, t0.Add(20*time.Second)), "p"); m != nil {
		t.Fatalf("without a list there are no servers: %+v", m)
	}
	if w.conns[0].closed || len(w.s.prev) != 1 || len(w.s.tps) != 1 {
		t.Fatalf("state lost: closed=%v prev=%d tps=%d", w.conns[0].closed, len(w.s.prev), len(w.s.tps))
	}
	w.ctr.setListErr(nil)
	w.eng.SetStats(cid, st(4e9, 40e9))
	m := find(w.s.Sample(ctx, t0.Add(30*time.Second)), "p")
	if m == nil || m.CpuPct != 10 || m.Tps == nil || *m.Tps != 19.5 {
		t.Fatalf("on return it measures without a new baseline and with the current TPS: %+v", m)
	}
	if len(w.dials) != 1 {
		t.Fatalf("dials = %v", w.dials)
	}
}

// recorder stores the log records to count them by level.
type recorder struct {
	mu   sync.Mutex
	recs []slog.Record
}

func (r *recorder) Enabled(context.Context, slog.Level) bool { return true }
func (r *recorder) Handle(_ context.Context, rec slog.Record) error {
	r.mu.Lock()
	r.recs = append(r.recs, rec)
	r.mu.Unlock()
	return nil
}
func (r *recorder) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *recorder) WithGroup(string) slog.Handler      { return r }
func (r *recorder) count(l slog.Level) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, rec := range r.recs {
		if rec.Level == l {
			n++
		}
	}
	return n
}

// A failure that repeats every 10 s is logged once (even if the text changes, e.g.
// because of an ephemeral port) and once more on recovery; if it fails again, it is logged again.
func TestRepeatedErrorsLoggedOnce(t *testing.T) {
	w := newWorld(t)
	rec := &recorder{}
	w.s.o.Log = slog.New(rec)
	ctx := context.Background()
	cid := w.server("a", "alpha", "VANILLA", true)
	w.eng.SetStats(cid, st(1e9, 10e9))
	i := 0
	sample := func() { w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second)); i++ }
	sample()
	for _, msg := range []string{"read tcp 127.0.0.1:41000: i/o timeout", "read tcp 127.0.0.1:41001: i/o timeout", "read tcp 127.0.0.1:41002: i/o timeout"} {
		w.eng.StatsErr = errors.New(msg)
		sample()
	}
	if n := rec.count(slog.LevelWarn); n != 1 {
		t.Fatalf("warnings = %d, want 1", n)
	}
	w.eng.StatsErr = nil
	sample()
	if n := rec.count(slog.LevelInfo); n != 1 {
		t.Fatalf("recovery logged %d times, want 1", n)
	}
	w.eng.StatsErr = errors.New("daemon busy")
	sample()
	if n := rec.count(slog.LevelWarn); n != 2 {
		t.Fatalf("warnings = %d, want 2 (fails again)", n)
	}
}

// fakeClock delivers the ticks the test asks for; After reports the requested wait.
type fakeClock struct {
	mu    sync.Mutex
	now   time.Time
	waits chan time.Duration
	fire  chan time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.waits <- d
	return c.fire
}

// wait waits for Run to request a timer and returns the requested wait.
func (c *fakeClock) wait(t *testing.T) time.Duration {
	t.Helper()
	select {
	case d := <-c.waits:
		return d
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not request a timer")
		return 0
	}
}

// advance moves the clock d and fires the pending timer.
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	c.mu.Unlock()
	c.fire <- now
}

func TestRunAlignsTicksSendsAndClosesSessions(t *testing.T) {
	w := newWorld(t)
	cid := w.server("p", "paper", "PAPER", true)
	w.setOnline("paper", 2, 20, 1)
	clk := &fakeClock{now: time.Date(2026, 10, 12, 10, 0, 2, 0, time.UTC), waits: make(chan time.Duration, 1), fire: make(chan time.Time)}
	sent := make(chan *mcsmv1.Envelope, 4)
	w.s.o.Clock = clk
	w.s.o.Send = func(e *mcsmv1.Envelope) error { sent <- e; return nil }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.s.Run(ctx); close(done) }()

	d := clk.wait(t)
	if d != 3*time.Second { // 10:00:02 → 10:00:05
		t.Fatalf("first wait = %s, want 3s", d)
	}
	w.eng.SetStats(cid, st(1e9, 10e9))
	clk.advance(d)
	// Run requests a timer again when the first Sample has finished.
	if d = clk.wait(t); d != 10*time.Second {
		t.Fatalf("second wait = %s, want 10s", d)
	}
	w.eng.SetStats(cid, st(2e9, 20e9))
	clk.advance(d)
	var env *mcsmv1.Envelope
	select {
	case env = <-sent:
	case <-time.After(3 * time.Second):
		t.Fatal("the batch was not sent")
	}
	b := env.GetMetricBatch()
	if env.Id != 0 || b == nil || b.TsUnix != time.Date(2026, 10, 12, 10, 0, 10, 0, time.UTC).Unix() || find(b, "p") == nil || b.Host == nil {
		t.Fatalf("envelope = %v", env)
	}
	clk.wait(t) // Run finished the second Sample and waits for the third
	select {
	case e := <-sent:
		t.Fatalf("only one batch after two ticks: %v", e)
	default:
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not finish on cancel")
	}
	if !w.conns[0].closed {
		t.Fatal("Run closes the RCON sessions on finishing")
	}
}

func TestTPSSessionResetWhenCPUCountersGoBackwards(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cid := w.server("p", "paper", "PAPER", true)
	w.setOnline("paper", 0, 20, 1)
	for i := 0; i <= 1; i++ {
		w.eng.SetStats(cid, st(uint64(5+i)*1e9, uint64(10+10*i)*1e9))
		w.s.Sample(ctx, t0.Add(time.Duration(i)*10*time.Second))
	}
	// In-place restart: same id, CPU counters at zero.
	w.rcon = func() *fakeRcon { return &fakeRcon{outputs: []string{"TPS from last 1m, 5m, 15m: 17.0, 20.0, 20.0"}} }
	w.eng.SetStats(cid, st(1e8, 30e9))
	if m := find(w.s.Sample(ctx, t0.Add(20*time.Second)), "p"); m != nil {
		t.Fatalf("window with reset counters: %+v", m)
	}
	if !w.conns[0].closed {
		t.Fatal("the previous process's RCON session must be closed")
	}
	w.eng.SetStats(cid, st(2e8, 40e9))
	m := find(w.s.Sample(ctx, t0.Add(30*time.Second)), "p")
	if m == nil || m.Tps == nil || *m.Tps != 17 || len(w.dials) != 2 {
		t.Fatalf("TPS of the new process: %+v dials=%v", m, w.dials)
	}
}
