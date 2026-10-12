package jobs

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/store"
)

type progressSink struct {
	mu   sync.Mutex
	msgs []*mcsmv1.JobProgress
}

func (s *progressSink) send(e *mcsmv1.Envelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := e.GetJobProgress(); p != nil {
		s.msgs = append(s.msgs, p)
	}
	return nil
}

func (s *progressSink) all() []*mcsmv1.JobProgress {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*mcsmv1.JobProgress(nil), s.msgs...)
}

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time { return c.t }

func setup(t *testing.T) (*Tracker, *store.Store, *progressSink, *testClock) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	s := &progressSink{}
	c := &testClock{t: time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)}
	return New(st, s.send, c.now), st, s, c
}

const (
	running = mcsmv1.JobStatus_JOB_STATUS_RUNNING
	ok      = mcsmv1.JobStatus_JOB_STATUS_OK
	failed  = mcsmv1.JobStatus_JOB_STATUS_FAILED
)

func TestJobLifecycle(t *testing.T) {
	tr, st, s, _ := setup(t)
	j, old, err := tr.Begin("j1", "srv", TypeBackup)
	if err != nil || old != nil || j == nil {
		t.Fatalf("Begin = %v, %v, %v", j, old, err)
	}
	j.Progress(3, "Copiando datos") // cambia el mensaje: se emite
	j.Progress(4, "Copiando datos") // +1: no se emite
	j.Progress(9, "Copiando datos") // ≥ 3+5: se emite
	j.Progress(2, "Copiando datos") // no retrocede ni se emite
	j.Log("save-off")
	j.Done(nil, "Copia creada")
	j.Done(errors.New("tarde"), "") // ignorado
	msgs := s.all()
	if len(msgs) != 5 {
		t.Fatalf("emitidos %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Status != running || msgs[0].Type != TypeBackup || msgs[0].ServerId != "srv" {
		t.Fatalf("primer aviso = %+v", msgs[0])
	}
	if msgs[2].Progress != 9 || msgs[3].LogChunk != "save-off\n" {
		t.Fatalf("avisos = %+v", msgs)
	}
	if last := msgs[4]; last.Status != ok || last.Progress != 100 || last.Message != "Copia creada" {
		t.Fatalf("final = %+v", last)
	}
	rec, _ := st.GetJob("j1")
	if rec.Status != ok || rec.Log != "save-off\n" || rec.FinishedUnixMs == 0 {
		t.Fatalf("guardado = %+v", rec)
	}
}

func TestDuplicateJobIsNotRunTwice(t *testing.T) {
	tr, _, s, _ := setup(t)
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	j.Done(nil, "ok")
	j2, old, err := tr.Begin("j1", "srv", TypeBackup)
	if err != nil || j2 != nil || old == nil || old.Status != ok {
		t.Fatalf("Begin duplicado = %v, %+v, %v", j2, old, err)
	}
	n := len(s.all())
	tr.Replay(old)
	got := s.all()
	if len(got) != n+1 || got[n].Status != ok || got[n].JobId != "j1" {
		t.Fatalf("Replay = %+v", got[n:])
	}
}

func TestDoneWithErrorAndInvalidUTF8(t *testing.T) {
	tr, st, _, _ := setup(t)
	j, _, _ := tr.Begin("j1", "srv", TypeRestore)
	j.Log("fichero raro: \xff\xfe")
	j.Done(errors.New("la copia está dañada \xff"), "")
	rec, err := st.GetJob("j1")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Status != failed || !strings.HasPrefix(rec.Message, "la copia está dañada") {
		t.Fatalf("rec = %+v", rec)
	}
	if !utf8.ValidString(rec.Log) || !utf8.ValidString(rec.Message) {
		t.Fatal("log y mensaje deben ser UTF-8 válido")
	}
}

func TestFailInterrupted(t *testing.T) {
	tr, st, _, _ := setup(t)
	tr.Begin("colgado", "srv", TypeBackup) // nunca termina: el agente "se reinicia"
	j, _, _ := tr.Begin("hecho", "srv", TypeBackup)
	j.Done(nil, "ok")
	tr2 := New(st, func(*mcsmv1.Envelope) error { return nil }, time.Now)
	if err := tr2.FailInterrupted(); err != nil {
		t.Fatal(err)
	}
	if rec, _ := st.GetJob("colgado"); rec.Status != failed || !strings.Contains(rec.Message, "interrumpido") || rec.FinishedUnixMs == 0 {
		t.Fatalf("colgado = %+v", rec)
	}
	if rec, _ := st.GetJob("hecho"); rec.Status != ok {
		t.Fatalf("hecho = %+v", rec)
	}
}

func TestLogIsBoundedKeepingTheEnd(t *testing.T) {
	tr, st, _, _ := setup(t)
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	line := strings.Repeat("ñ", 511) // 1022 bytes: el recorte puede caer a mitad de carácter
	for i := 0; i < 80; i++ {
		j.Log(line)
	}
	j.Log("ULTIMA")
	j.Done(nil, "ok") // Done vuelca el log pendiente
	rec, _ := st.GetJob("j1")
	if len(rec.Log) > MaxLog || !strings.HasPrefix(rec.Log, "…(recortado)") || !strings.HasSuffix(rec.Log, "ULTIMA\n") || !utf8.ValidString(rec.Log) {
		t.Fatalf("log de %d bytes, prefijo %q", len(rec.Log), rec.Log[:20])
	}
}

func TestInventoryPrunesFiltersAndOrders(t *testing.T) {
	tr, _, _, c := setup(t)
	a, _, _ := tr.Begin("viejo", "s1", TypeBackup)
	a.Done(nil, "ok")
	c.t = c.t.Add(8 * 24 * time.Hour)
	b, _, _ := tr.Begin("s1-nuevo", "s1", TypeBackup)
	b.Log(strings.Repeat("x", 10_000))
	c.t = c.t.Add(time.Minute)
	tr.Begin("s2-nuevo", "s2", TypeRestore)
	all, err := tr.Inventory("")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].JobId != "s2-nuevo" || all[1].JobId != "s1-nuevo" {
		t.Fatalf("inventario = %+v", all)
	}
	if len(all[1].Log) > inventoryLog {
		t.Fatalf("log del inventario sin recortar: %d", len(all[1].Log))
	}
	only, _ := tr.Inventory("s1")
	if len(only) != 1 || only[0].JobId != "s1-nuevo" {
		t.Fatalf("filtrado = %+v", only)
	}
}

func TestNewIDIsUUIDv4(t *testing.T) {
	id := NewID()
	if len(id) != 36 || id[14] != '4' || id == NewID() {
		t.Fatalf("id = %s", id)
	}
}

// countingStore envuelve el store real contando (y haciendo fallar) los PutJob.
type countingStore struct {
	Store
	mu     sync.Mutex
	puts   int
	failN  int // los primeros failN PutJob fallan
	failAt func(*mcsmv1.JobRecord) bool
}

func (c *countingStore) PutJob(r *mcsmv1.JobRecord) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.puts++
	if c.failN > 0 && c.failAt(r) {
		c.failN--
		return errors.New("disco lleno")
	}
	return c.Store.PutJob(r)
}

func newCounting(t *testing.T) (*Tracker, *countingStore, *progressSink, *testClock) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cs := &countingStore{Store: st}
	s := &progressSink{}
	c := &testClock{t: time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)}
	tr := New(cs, s.send, c.now)
	tr.sleep = func(time.Duration) {}
	return tr, cs, s, c
}

func TestLogIsCoalesced(t *testing.T) {
	tr, cs, s, c := newCounting(t)
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	base := cs.puts
	for i := 0; i < 1000; i++ {
		j.Log(fmt.Sprintf("fichero %d", i))
	}
	if got := cs.puts - base; got != 1 {
		t.Fatalf("guardados %d veces con el reloj parado, quería 1", got)
	}
	c.t = c.t.Add(LogEvery)
	j.Log("otra")
	if got := cs.puts - base; got != 2 {
		t.Fatalf("tras LogEvery quería 2 guardados, hay %d", got)
	}
	j.Log("final")
	j.Done(nil, "ok")
	chunks := 0
	var all strings.Builder
	for _, m := range s.all() {
		if m.LogChunk != "" {
			chunks++
			all.WriteString(m.LogChunk)
		}
	}
	if chunks != 3 {
		t.Fatalf("log_chunk enviados = %d, quería 3", chunks)
	}
	if !strings.HasSuffix(all.String(), "otra\nfinal\n") {
		t.Fatalf("Done debe volcar el log pendiente: %q", all.String()[all.Len()-30:])
	}
	rec, _ := cs.GetJob("j1")
	if !strings.Contains(rec.Log, "fichero 999\notra\nfinal\n") || len(rec.Log) > MaxLog {
		t.Fatalf("log guardado incompleto (%d bytes)", len(rec.Log))
	}
}

func TestDoneRetriesAndReportsPersistFailure(t *testing.T) {
	tr, cs, _, _ := newCounting(t)
	final := func(r *mcsmv1.JobRecord) bool { return r.Status != running }
	cs.failAt = final
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	cs.failN = 2
	if err := j.Done(nil, "ok"); err != nil {
		t.Fatalf("con 2 fallos y 3 intentos debe guardarse: %v", err)
	}
	if rec, _ := cs.GetJob("j1"); rec.Status != ok {
		t.Fatalf("guardado = %+v", rec)
	}
	k, _, _ := tr.Begin("j2", "srv", TypeBackup)
	cs.failN = 100
	if err := k.Done(nil, "ok"); err == nil {
		t.Fatal("Done debe devolver el error si el guardado sigue fallando")
	}
	if k.Record().Status != ok {
		t.Fatal("el estado en memoria debe ser el final")
	}
}

func TestConcurrentBeginSameIDRunsOnce(t *testing.T) {
	tr, _, _, _ := setup(t)
	const n = 32
	var wg sync.WaitGroup
	var mu sync.Mutex
	started, dup := 0, 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j, old, err := tr.Begin("same", "srv", TypeBackup)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err != nil:
				t.Error(err)
			case j != nil && old == nil:
				started++
			case j == nil && old != nil:
				dup++
			default:
				t.Error("resultado incoherente")
			}
		}()
	}
	wg.Wait()
	if started != 1 || dup != n-1 {
		t.Fatalf("started=%d dup=%d", started, dup)
	}
}

func TestSendErrorsAreIgnored(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := &testClock{t: time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)}
	calls := 0
	tr := New(st, func(*mcsmv1.Envelope) error { calls++; return errors.New("not connected") }, c.now)
	j, _, err := tr.Begin("j1", "srv", TypeBackup)
	if err != nil {
		t.Fatal(err)
	}
	j.Progress(50, "mitad")
	j.Log("linea")
	if err := j.Done(nil, "ok"); err != nil {
		t.Fatal(err)
	}
	tr.Replay(j.Record())
	rec, _ := st.GetJob("j1")
	if calls == 0 || rec.Status != ok || rec.Progress != 100 || rec.Log != "linea\n" {
		t.Fatalf("calls=%d rec=%+v", calls, rec)
	}
}

func TestReplayRunningJob(t *testing.T) {
	tr, _, s, _ := setup(t)
	j, _, _ := tr.Begin("j1", "srv", TypeRestore)
	j.Progress(40, "Restaurando")
	_, old, _ := tr.Begin("j1", "srv", TypeRestore)
	n := len(s.all())
	tr.Replay(old)
	got := s.all()
	if len(got) != n+1 || got[n].Status != running || got[n].Progress != 40 || got[n].Message != "Restaurando" || got[n].Type != TypeRestore {
		t.Fatalf("Replay = %+v", got[n:])
	}
}

func TestBeginValidatesAndMessageIsBounded(t *testing.T) {
	tr, st, _, _ := setup(t)
	for _, a := range [][3]string{{"", "s", TypeBackup}, {"j", "", TypeBackup}, {"j", "s", ""}} {
		if j, _, err := tr.Begin(a[0], a[1], a[2]); err == nil || j != nil {
			t.Fatalf("Begin%v debe fallar", a)
		}
	}
	j, _, _ := tr.Begin("j1", "s", TypeBackup)
	j.Done(errors.New(strings.Repeat("ñ", 2000)), "")
	rec, _ := st.GetJob("j1")
	if len(rec.Message) > MaxMessage || !utf8.ValidString(rec.Message) {
		t.Fatalf("mensaje de %d bytes", len(rec.Message))
	}
}

func TestFailInterruptedPrunesOld(t *testing.T) {
	tr, st, _, c := setup(t)
	a, _, _ := tr.Begin("viejo", "s", TypeBackup)
	a.Done(nil, "ok")
	c.t = c.t.Add(KeepFor + time.Hour)
	if err := tr.FailInterrupted(); err != nil {
		t.Fatal(err)
	}
	if rec, _ := st.GetJob("viejo"); rec != nil {
		t.Fatal("FailInterrupted debe podar los terminados antiguos")
	}
}

func TestNothingIsSentAfterTheTerminalMessage(t *testing.T) {
	for round := 0; round < 50; round++ {
		tr, _, s, _ := newCounting(t)
		j, _, _ := tr.Begin("j1", "srv", TypeBackup)
		var wg sync.WaitGroup
		for g := 0; g < 4; g++ {
			wg.Add(1)
			go func(g int) {
				defer wg.Done()
				for i := 0; i < 20; i++ {
					j.Progress(uint32(i), fmt.Sprintf("g%d-%d", g, i))
					j.Log(fmt.Sprintf("g%d linea %d", g, i))
				}
			}(g)
		}
		wg.Add(1)
		go func() { defer wg.Done(); j.Done(nil, "fin") }()
		wg.Wait()
		msgs := s.all()
		last := msgs[len(msgs)-1]
		if last.Status != ok {
			t.Fatalf("ronda %d: el último aviso no es el terminal: %+v", round, last)
		}
		for _, m := range msgs[:len(msgs)-1] {
			if m.Status != running {
				t.Fatalf("ronda %d: terminal antes del final: %+v", round, m)
			}
		}
	}
}

// Determinista: un aviso RUNNING queda retenido en send mientras otra goroutine cierra el job.
// Sin la serialización por job, el terminal se enviaría antes que el RUNNING retenido.
func TestSlowSendCannotBeOvertakenByTerminal(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	var mu sync.Mutex
	var order []mcsmv1.JobStatus
	inSend := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	send := func(e *mcsmv1.Envelope) error {
		p := e.GetJobProgress()
		if p.Message == "lento" {
			close(inSend)
			select {
			case <-release:
			case <-time.After(100 * time.Millisecond): // serializado: el terminal espera, así que nadie libera
			}
		}
		if p.Status != running {
			once.Do(func() { close(release) })
		}
		mu.Lock()
		order = append(order, p.Status)
		mu.Unlock()
		return nil
	}
	c := &testClock{t: time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)}
	tr := New(st, send, c.now)
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); j.Progress(10, "lento") }()
	go func() { defer wg.Done(); <-inSend; j.Done(nil, "fin") }()
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if n := len(order); n != 3 || order[1] != running || order[2] != ok {
		t.Fatalf("orden de avisos = %v", order)
	}
}
