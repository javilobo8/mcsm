// Package jobs records the agent's long jobs (backup, restore): it persists them in the
// store so a repeated job_id can be answered without repeating the work (spec §5.4) and emits
// JobProgress to the panel.
//
// Known log limitation: lines that fall within the LogEvery window after a
// flush are only saved and sent with the next line, Progress or Done (there is no
// timer-deferred flush). The full log is always saved on Done.
package jobs

import (
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

const (
	TypeBackup  = "backup"
	TypeRestore = "restore"

	// MaxLog is the log kept per job (the end is preserved).
	MaxLog = 64 << 10
	// KeepFor is how long finished jobs are remembered.
	KeepFor = 7 * 24 * time.Hour
	// progressStep: a smaller advance is not emitted (do not flood the WS with small files).
	progressStep = 5
	// inventoryJobs and inventoryLog bound the size of the inventory sent to the panel.
	inventoryJobs = 200
	inventoryLog  = 4 << 10

	// MaxMessage bounds a job's status message.
	MaxMessage = 1024
	// LogEvery is the minimum interval between flushes (save + send) of a job's log.
	LogEvery = time.Second

	putAttempts  = 3
	putRetryWait = 200 * time.Millisecond
)

// Store is the part of the agent's store that jobs use.
type Store interface {
	PutJob(*mcsmv1.JobRecord) error
	GetJob(id string) (*mcsmv1.JobRecord, error)
	ListJobs() ([]*mcsmv1.JobRecord, error)
	PruneJobs(before time.Time) (int, error)
}

// Tracker creates and follows jobs.
type Tracker struct {
	st   Store
	send func(*mcsmv1.Envelope) error
	now  func() time.Time
	log  *slog.Logger
	// sleep is the wait between save retries (injectable in tests).
	sleep func(time.Duration)
	mu    sync.Mutex // serializes Begin: two simultaneous duplicates do not start two executions
}

// New creates a Tracker. send must tolerate being disconnected (it returns an error and it is ignored).
func New(st Store, send func(*mcsmv1.Envelope) error, now func() time.Time) *Tracker {
	return &Tracker{st: st, send: send, now: now, sleep: time.Sleep, log: slog.Default().With("component", "jobs")}
}

// NewID generates an id (UUID v4) for the jobs the agent itself starts (scheduled backups).
func NewID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Begin registers a new job as RUNNING and announces it. If the id already exists it returns
// (nil, stored record, nil): the caller must NOT run it again.
func (t *Tracker) Begin(id, serverID, typ string) (*Job, *mcsmv1.JobRecord, error) {
	if id == "" || serverID == "" || typ == "" {
		return nil, nil, errors.New("job without id, server or type")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	old, err := t.st.GetJob(id)
	if err != nil {
		return nil, nil, err
	}
	if old != nil {
		return nil, old, nil
	}
	rec := &mcsmv1.JobRecord{JobId: id, ServerId: serverID, Type: typ, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: t.now().UnixMilli()}
	if err := t.st.PutJob(rec); err != nil {
		return nil, nil, err
	}
	j := &Job{t: t, rec: rec}
	j.mu.Lock()
	env := j.snapshot()
	j.mu.Unlock()
	_ = t.send(env)
	return j, nil, nil
}

// Replay resends a job's stored state to the panel (reply to a repeated job_id).
func (t *Tracker) Replay(rec *mcsmv1.JobRecord) {
	_ = t.send(progressEnv(rec, "", t.now()))
}

// FailInterrupted marks as FAILED the jobs that were left RUNNING (the agent restarted midway)
// and forgets those finished more than KeepFor ago. Call only at startup, before accepting
// jobs (it does not take t.mu).
func (t *Tracker) FailInterrupted() error {
	if _, err := t.st.PruneJobs(t.now().Add(-KeepFor)); err != nil {
		return err
	}
	list, err := t.st.ListJobs()
	if err != nil {
		return err
	}
	for _, rec := range list {
		if rec.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING {
			continue
		}
		rec.Status = mcsmv1.JobStatus_JOB_STATUS_FAILED
		rec.Message = "interrupted: the agent restarted during the job"
		rec.FinishedUnixMs = t.now().UnixMilli()
		if err := t.st.PutJob(rec); err != nil {
			return err
		}
	}
	return nil
}

// Inventory returns the recent jobs for the panel (newest first, at most
// 200 plus any RUNNING ones that do not fit, and with the log trimmed to 4 KiB) after forgetting those finished more than KeepFor ago.
// Empty serverID = all.
func (t *Tracker) Inventory(serverID string) ([]*mcsmv1.JobRecord, error) {
	if _, err := t.st.PruneJobs(t.now().Add(-KeepFor)); err != nil {
		return nil, err
	}
	list, err := t.st.ListJobs()
	if err != nil {
		return nil, err
	}
	out := make([]*mcsmv1.JobRecord, 0, len(list))
	for _, r := range list {
		if serverID == "" || r.ServerId == serverID {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedUnixMs > out[j].StartedUnixMs })
	if len(out) > inventoryJobs {
		// RUNNING ones always go in (the panel would consider a still-running one lost); the
		// rest, the most recent until inventoryJobs is reached. Order is preserved.
		running := 0
		for _, r := range out {
			if r.Status == mcsmv1.JobStatus_JOB_STATUS_RUNNING {
				running++
			}
		}
		room := max(inventoryJobs-running, 0)
		kept := out[:0]
		for _, r := range out {
			if r.Status == mcsmv1.JobStatus_JOB_STATUS_RUNNING {
				kept = append(kept, r)
			} else if room > 0 {
				kept = append(kept, r)
				room--
			}
		}
		out = kept
	}
	for _, r := range out {
		r.Log = tail(r.Log, inventoryLog)
	}
	return out, nil
}

// Job is a job in progress. Its methods are safe for concurrent use. send is never called
// with the lock held: a slow send does not block Record or the other methods.
//
// Fixed lock order: sendMu -> mu. sendMu serializes save+send per job, so that
// notifications go out in the order they are produced and none goes out after the terminal one
// (the methods see j.done and return before emitting).
type Job struct {
	t        *Tracker
	sendMu   sync.Mutex
	mu       sync.Mutex
	rec      *mcsmv1.JobRecord
	lastSent uint32
	done     bool
	pending  string    // log lines not yet sent to the panel
	lastLog  time.Time // last log flush (zero = none yet)
}

// ID returns the job's id (it does not change).
func (j *Job) ID() string { return j.rec.JobId }

// Progress updates the progress (0-99: Done sets 100). It is only saved and emitted if
// the message changes or the progress rises at least 5 points. Progress never goes backwards.
func (j *Job) Progress(pct uint32, msg string) {
	if pct > 99 {
		pct = 99
	}
	msg = limit(clean(msg), MaxMessage)
	j.sendMu.Lock()
	defer j.sendMu.Unlock()
	j.mu.Lock()
	if j.done {
		j.mu.Unlock()
		return
	}
	if pct < j.rec.Progress {
		pct = j.rec.Progress
	}
	changed := msg != j.rec.Message || pct >= j.lastSent+progressStep
	j.rec.Progress, j.rec.Message = pct, msg
	if !changed {
		j.mu.Unlock()
		return
	}
	j.persist()
	env := j.snapshot()
	j.mu.Unlock()
	_ = j.t.send(env)
}

// Log adds a line to the job's log. It accumulates in memory and is saved and sent (as a
// single log_chunk with the pending lines) the first time and then at most every LogEvery;
// Done always flushes whatever remains.
func (j *Job) Log(line string) {
	chunk := clean(strings.TrimRight(line, "\n")) + "\n"
	j.sendMu.Lock()
	defer j.sendMu.Unlock()
	j.mu.Lock()
	if j.done {
		j.mu.Unlock()
		return
	}
	j.rec.Log = tail(j.rec.Log+chunk, MaxLog)
	j.pending = tail(j.pending+chunk, MaxLog)
	now := j.t.now()
	if !j.lastLog.IsZero() && now.Sub(j.lastLog) < LogEvery {
		j.mu.Unlock()
		return
	}
	j.lastLog = now
	j.persist()
	env := j.snapshot()
	j.mu.Unlock()
	_ = j.t.send(env)
}

// Done closes the job: OK with okMsg if err is nil, FAILED with the error otherwise. Idempotent.
// The in-memory state ends up final even if saving fails; if it keeps
// failing after retrying it returns the error (the caller must log it): on disk it would stay RUNNING.
func (j *Job) Done(err error, okMsg string) error {
	j.sendMu.Lock()
	defer j.sendMu.Unlock()
	j.mu.Lock()
	if j.done {
		j.mu.Unlock()
		return nil
	}
	j.done = true
	if err != nil {
		j.rec.Status = mcsmv1.JobStatus_JOB_STATUS_FAILED
		j.rec.Message = limit(clean(err.Error()), MaxMessage)
	} else {
		j.rec.Status = mcsmv1.JobStatus_JOB_STATUS_OK
		j.rec.Progress = 100
		j.rec.Message = limit(clean(okMsg), MaxMessage)
	}
	j.rec.FinishedUnixMs = j.t.now().UnixMilli()
	rec := proto.Clone(j.rec).(*mcsmv1.JobRecord)
	env := j.snapshot()
	j.mu.Unlock()
	// Retries outside j.mu (Record does not wait); sendMu serializes them with the rest.
	var perr error
	for i := 0; i < putAttempts; i++ {
		if perr = j.t.st.PutJob(rec); perr == nil {
			break
		}
		if i < putAttempts-1 {
			j.t.sleep(putRetryWait)
		}
	}
	_ = j.t.send(env)
	if perr != nil {
		return fmt.Errorf("save the job's final state %s: %w", j.rec.JobId, perr)
	}
	return nil
}

// Record returns a copy of the current state.
func (j *Job) Record() *mcsmv1.JobRecord {
	j.mu.Lock()
	defer j.mu.Unlock()
	return proto.Clone(j.rec).(*mcsmv1.JobRecord)
}

func (j *Job) persist() {
	if err := j.t.st.PutJob(j.rec); err != nil {
		j.t.log.Warn("save job", "job", j.rec.JobId, "err", err)
	}
}

// snapshot (with j.mu held) builds the notification with the pending log and marks it as sent.
func (j *Job) snapshot() *mcsmv1.Envelope {
	j.lastSent = j.rec.Progress
	chunk := j.pending
	j.pending = ""
	return progressEnv(j.rec, chunk, j.t.now())
}

func progressEnv(r *mcsmv1.JobRecord, chunk string, now time.Time) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Body: &mcsmv1.Envelope_JobProgress{JobProgress: &mcsmv1.JobProgress{
		JobId: r.JobId, ServerId: r.ServerId, Type: r.Type, Status: r.Status, Progress: r.Progress,
		Message: r.Message, LogChunk: chunk, TsUnixMs: now.UnixMilli(),
	}}}
}

// clean leaves s as valid UTF-8: proto3 rejects invalid strings when serializing, and
// file names or RCON output may carry stray bytes.
func clean(s string) string { return strings.ToValidUTF8(s, "�") }

// tail trims s to its last max bytes (marking the cut) without splitting a character.
func tail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	const mark = "…(trimmed)\n"
	cut := s[len(s)-max+len(mark):]
	if i := strings.IndexByte(cut, '\n'); i >= 0 && i < len(cut)-1 {
		cut = cut[i+1:]
	}
	return mark + strings.ToValidUTF8(cut, "")
}

// limit trims s to max bytes without splitting a character.
func limit(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}
