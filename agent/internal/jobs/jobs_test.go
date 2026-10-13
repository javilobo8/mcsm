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
	j.Progress(3, "Copying data") // the message changes: emitted
	j.Progress(4, "Copying data") // +1: not emitted
	j.Progress(9, "Copying data") // ≥ 3+5: emitted
	j.Progress(2, "Copying data") // does not go backwards nor is emitted
	j.Log("save-off")
	j.Done(nil, "Backup created")
	j.Done(errors.New("late"), "") // ignored
	msgs := s.all()
	if len(msgs) != 5 {
		t.Fatalf("emitted %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Status != running || msgs[0].Type != TypeBackup || msgs[0].ServerId != "srv" {
		t.Fatalf("first notification = %+v", msgs[0])
	}
	if msgs[2].Progress != 9 || msgs[3].LogChunk != "save-off\n" {
		t.Fatalf("notifications = %+v", msgs)
	}
	if last := msgs[4]; last.Status != ok || last.Progress != 100 || last.Message != "Backup created" {
		t.Fatalf("final = %+v", last)
	}
	rec, _ := st.GetJob("j1")
	if rec.Status != ok || rec.Log != "save-off\n" || rec.FinishedUnixMs == 0 {
		t.Fatalf("saved = %+v", rec)
	}
}

func TestDuplicateJobIsNotRunTwice(t *testing.T) {
	tr, _, s, _ := setup(t)
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	j.Done(nil, "ok")
	j2, old, err := tr.Begin("j1", "srv", TypeBackup)
	if err != nil || j2 != nil || old == nil || old.Status != ok {
		t.Fatalf("duplicate Begin = %v, %+v, %v", j2, old, err)
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
	j.Log("odd file: \xff\xfe")
	j.Done(errors.New("the backup is corrupted \xff"), "")
	rec, err := st.GetJob("j1")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Status != failed || !strings.HasPrefix(rec.Message, "the backup is corrupted") {
		t.Fatalf("rec = %+v", rec)
	}
	if !utf8.ValidString(rec.Log) || !utf8.ValidString(rec.Message) {
		t.Fatal("log and message must be valid UTF-8")
	}
}

func TestFailInterrupted(t *testing.T) {
	tr, st, _, _ := setup(t)
	tr.Begin("stuck", "srv", TypeBackup) // never finishes: the agent "restarts"
	j, _, _ := tr.Begin("finished", "srv", TypeBackup)
	j.Done(nil, "ok")
	tr2 := New(st, func(*mcsmv1.Envelope) error { return nil }, time.Now)
	if err := tr2.FailInterrupted(); err != nil {
		t.Fatal(err)
	}
	if rec, _ := st.GetJob("stuck"); rec.Status != failed || !strings.Contains(rec.Message, "interrupted") || rec.FinishedUnixMs == 0 {
		t.Fatalf("stuck = %+v", rec)
	}
	if rec, _ := st.GetJob("finished"); rec.Status != ok {
		t.Fatalf("finished = %+v", rec)
	}
}

func TestLogIsBoundedKeepingTheEnd(t *testing.T) {
	tr, st, _, _ := setup(t)
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	line := strings.Repeat("ñ", 511) // 1022 bytes: the cut can fall in the middle of a character
	for i := 0; i < 80; i++ {
		j.Log(line)
	}
	j.Log("LAST")
	j.Done(nil, "ok") // Done flushes the pending log
	rec, _ := st.GetJob("j1")
	if len(rec.Log) > MaxLog || !strings.HasPrefix(rec.Log, "…(trimmed)") || !strings.HasSuffix(rec.Log, "LAST\n") || !utf8.ValidString(rec.Log) {
		t.Fatalf("log of %d bytes, prefix %q", len(rec.Log), rec.Log[:20])
	}
}

func TestInventoryPrunesFiltersAndOrders(t *testing.T) {
	tr, _, _, c := setup(t)
	a, _, _ := tr.Begin("old", "s1", TypeBackup)
	a.Done(nil, "ok")
	c.t = c.t.Add(8 * 24 * time.Hour)
	b, _, _ := tr.Begin("s1-new", "s1", TypeBackup)
	b.Log(strings.Repeat("x", 10_000))
	c.t = c.t.Add(time.Minute)
	tr.Begin("s2-new", "s2", TypeRestore)
	all, err := tr.Inventory("")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].JobId != "s2-new" || all[1].JobId != "s1-new" {
		t.Fatalf("inventory = %+v", all)
	}
	if len(all[1].Log) > inventoryLog {
		t.Fatalf("inventory log not trimmed: %d", len(all[1].Log))
	}
	only, _ := tr.Inventory("s1")
	if len(only) != 1 || only[0].JobId != "s1-new" {
		t.Fatalf("filtered = %+v", only)
	}
}

func TestNewIDIsUUIDv4(t *testing.T) {
	id := NewID()
	if len(id) != 36 || id[14] != '4' || id == NewID() {
		t.Fatalf("id = %s", id)
	}
}

// countingStore wraps the real store counting (and failing) the PutJobs.
type countingStore struct {
	Store
	mu     sync.Mutex
	puts   int
	failN  int // the first failN PutJobs fail
	failAt func(*mcsmv1.JobRecord) bool
}

func (c *countingStore) PutJob(r *mcsmv1.JobRecord) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.puts++
	if c.failN > 0 && c.failAt(r) {
		c.failN--
		return errors.New("disk full")
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
		j.Log(fmt.Sprintf("file %d", i))
	}
	if got := cs.puts - base; got != 1 {
		t.Fatalf("saved %d times with the clock stopped, wanted 1", got)
	}
	c.t = c.t.Add(LogEvery)
	j.Log("another")
	if got := cs.puts - base; got != 2 {
		t.Fatalf("after LogEvery wanted 2 saves, got %d", got)
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
		t.Fatalf("log_chunks sent = %d, wanted 3", chunks)
	}
	if !strings.HasSuffix(all.String(), "another\nfinal\n") {
		t.Fatalf("Done must flush the pending log: %q", all.String()[all.Len()-30:])
	}
	rec, _ := cs.GetJob("j1")
	if !strings.Contains(rec.Log, "file 999\nanother\nfinal\n") || len(rec.Log) > MaxLog {
		t.Fatalf("saved log incomplete (%d bytes)", len(rec.Log))
	}
}

func TestDoneRetriesAndReportsPersistFailure(t *testing.T) {
	tr, cs, _, _ := newCounting(t)
	final := func(r *mcsmv1.JobRecord) bool { return r.Status != running }
	cs.failAt = final
	j, _, _ := tr.Begin("j1", "srv", TypeBackup)
	cs.failN = 2
	if err := j.Done(nil, "ok"); err != nil {
		t.Fatalf("with 2 failures and 3 attempts it must be saved: %v", err)
	}
	if rec, _ := cs.GetJob("j1"); rec.Status != ok {
		t.Fatalf("saved = %+v", rec)
	}
	k, _, _ := tr.Begin("j2", "srv", TypeBackup)
	cs.failN = 100
	if err := k.Done(nil, "ok"); err == nil {
		t.Fatal("Done must return the error if saving keeps failing")
	}
	if k.Record().Status != ok {
		t.Fatal("the in-memory state must be the final one")
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
				t.Error("inconsistent result")
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
	j.Progress(50, "half")
	j.Log("line")
	if err := j.Done(nil, "ok"); err != nil {
		t.Fatal(err)
	}
	tr.Replay(j.Record())
	rec, _ := st.GetJob("j1")
	if calls == 0 || rec.Status != ok || rec.Progress != 100 || rec.Log != "line\n" {
		t.Fatalf("calls=%d rec=%+v", calls, rec)
	}
}

func TestReplayRunningJob(t *testing.T) {
	tr, _, s, _ := setup(t)
	j, _, _ := tr.Begin("j1", "srv", TypeRestore)
	j.Progress(40, "Restoring")
	_, old, _ := tr.Begin("j1", "srv", TypeRestore)
	n := len(s.all())
	tr.Replay(old)
	got := s.all()
	if len(got) != n+1 || got[n].Status != running || got[n].Progress != 40 || got[n].Message != "Restoring" || got[n].Type != TypeRestore {
		t.Fatalf("Replay = %+v", got[n:])
	}
}

func TestBeginValidatesAndMessageIsBounded(t *testing.T) {
	tr, st, _, _ := setup(t)
	for _, a := range [][3]string{{"", "s", TypeBackup}, {"j", "", TypeBackup}, {"j", "s", ""}} {
		if j, _, err := tr.Begin(a[0], a[1], a[2]); err == nil || j != nil {
			t.Fatalf("Begin%v must fail", a)
		}
	}
	j, _, _ := tr.Begin("j1", "s", TypeBackup)
	j.Done(errors.New(strings.Repeat("ñ", 2000)), "")
	rec, _ := st.GetJob("j1")
	if len(rec.Message) > MaxMessage || !utf8.ValidString(rec.Message) {
		t.Fatalf("message of %d bytes", len(rec.Message))
	}
}

func TestFailInterruptedPrunesOld(t *testing.T) {
	tr, st, _, c := setup(t)
	a, _, _ := tr.Begin("old", "s", TypeBackup)
	a.Done(nil, "ok")
	c.t = c.t.Add(KeepFor + time.Hour)
	if err := tr.FailInterrupted(); err != nil {
		t.Fatal(err)
	}
	if rec, _ := st.GetJob("old"); rec != nil {
		t.Fatal("FailInterrupted must prune the old finished ones")
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
					j.Log(fmt.Sprintf("g%d line %d", g, i))
				}
			}(g)
		}
		wg.Add(1)
		go func() { defer wg.Done(); j.Done(nil, "fin") }()
		wg.Wait()
		msgs := s.all()
		last := msgs[len(msgs)-1]
		if last.Status != ok {
			t.Fatalf("round %d: the last notification is not the terminal one: %+v", round, last)
		}
		for _, m := range msgs[:len(msgs)-1] {
			if m.Status != running {
				t.Fatalf("round %d: terminal before the end: %+v", round, m)
			}
		}
	}
}

// Deterministic: a RUNNING notification is held in send while another goroutine closes the job.
// Without per-job serialization, the terminal one would be sent before the held RUNNING one.
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
		if p.Message == "slow" {
			close(inSend)
			select {
			case <-release:
			case <-time.After(100 * time.Millisecond): // serialized: the terminal waits, so nobody releases
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
	go func() { defer wg.Done(); j.Progress(10, "slow") }()
	go func() { defer wg.Done(); <-inSend; j.Done(nil, "fin") }()
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if n := len(order); n != 3 || order[1] != running || order[2] != ok {
		t.Fatalf("notification order = %v", order)
	}
}

// m3: trimming to inventoryJobs never leaves out a running job: the panel would consider it
// lost while it is still running.
func TestInventoryAlwaysIncludesRunning(t *testing.T) {
	tr, st, _, c := setup(t)
	if _, _, err := tr.Begin("in-progress", "s1", TypeBackup); err != nil { // the oldest
		t.Fatal(err)
	}
	for i := 0; i < inventoryJobs+5; i++ {
		c.t = c.t.Add(time.Second)
		if err := st.PutJob(&mcsmv1.JobRecord{JobId: fmt.Sprintf("finished-%03d", i), ServerId: "s1", Type: TypeBackup,
			Status: mcsmv1.JobStatus_JOB_STATUS_OK, StartedUnixMs: c.t.UnixMilli(), FinishedUnixMs: c.t.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
	}
	inv, err := tr.Inventory("")
	if err != nil {
		t.Fatal(err)
	}
	if len(inv) != inventoryJobs {
		t.Fatalf("len = %d", len(inv))
	}
	found := false
	for _, r := range inv {
		found = found || r.JobId == "in-progress"
	}
	if !found {
		t.Fatal("the running job must be in the inventory")
	}
	if inv[0].JobId != "finished-204" {
		t.Fatalf("the rest, most recent first: %s", inv[0].JobId)
	}
}
