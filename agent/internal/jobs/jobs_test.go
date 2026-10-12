package jobs

import (
	"errors"
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
