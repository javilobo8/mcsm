// Package jobs registra los jobs largos del agente (backup, restore): los persiste en el
// store para responder a un job_id repetido sin repetir el trabajo (spec §5.4) y emite
// JobProgress al panel.
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

	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

const (
	TypeBackup  = "backup"
	TypeRestore = "restore"

	// MaxLog es el log que se guarda por job (se conserva el final).
	MaxLog = 64 << 10
	// KeepFor es cuánto se recuerdan los jobs terminados.
	KeepFor = 7 * 24 * time.Hour
	// progressStep: un avance menor no se emite (no inundar el WS con ficheros pequeños).
	progressStep = 5
	// inventoryJobs e inventoryLog acotan el tamaño del inventario que se envía al panel.
	inventoryJobs = 200
	inventoryLog  = 4 << 10
)

// Store es la parte del store del agente que usan los jobs.
type Store interface {
	PutJob(*mcsmv1.JobRecord) error
	GetJob(id string) (*mcsmv1.JobRecord, error)
	ListJobs() ([]*mcsmv1.JobRecord, error)
	PruneJobs(before time.Time) (int, error)
}

// Tracker crea y sigue jobs.
type Tracker struct {
	st   Store
	send func(*mcsmv1.Envelope) error
	now  func() time.Time
	log  *slog.Logger
	mu   sync.Mutex // serializa Begin: dos duplicados simultáneos no arrancan dos ejecuciones
}

// New crea un Tracker. send debe tolerar estar desconectado (devuelve error y se ignora).
func New(st Store, send func(*mcsmv1.Envelope) error, now func() time.Time) *Tracker {
	return &Tracker{st: st, send: send, now: now, log: slog.Default().With("component", "jobs")}
}

// NewID genera un id (UUID v4) para los jobs que inicia el propio agente (copias programadas).
func NewID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Begin registra un job nuevo en RUNNING y lo anuncia. Si el id ya existe devuelve
// (nil, registro guardado, nil): el llamante NO debe ejecutarlo otra vez.
func (t *Tracker) Begin(id, serverID, typ string) (*Job, *mcsmv1.JobRecord, error) {
	if id == "" {
		return nil, nil, errors.New("job sin id")
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
	j.emit("")
	return j, nil, nil
}

// Replay reenvía al panel el estado guardado de un job (respuesta a un job_id repetido).
func (t *Tracker) Replay(rec *mcsmv1.JobRecord) {
	_ = t.send(progressEnv(rec, "", t.now()))
}

// FailInterrupted marca FAILED los jobs que quedaron RUNNING: el agente se reinició a mitad.
func (t *Tracker) FailInterrupted() error {
	list, err := t.st.ListJobs()
	if err != nil {
		return err
	}
	for _, rec := range list {
		if rec.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING {
			continue
		}
		rec.Status = mcsmv1.JobStatus_JOB_STATUS_FAILED
		rec.Message = "interrumpido: el agente se reinició durante el job"
		rec.FinishedUnixMs = t.now().UnixMilli()
		if err := t.st.PutJob(rec); err != nil {
			return err
		}
	}
	return nil
}

// Inventory devuelve los jobs recientes para el panel (los más nuevos primero, como mucho
// 200 y con el log recortado a 4 KiB) tras olvidar los terminados hace más de KeepFor.
// serverID vacío = todos.
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
		out = out[:inventoryJobs]
	}
	for _, r := range out {
		r.Log = tail(r.Log, inventoryLog)
	}
	return out, nil
}

// Job es un job en curso. Sus métodos son seguros para uso concurrente.
type Job struct {
	t        *Tracker
	mu       sync.Mutex
	rec      *mcsmv1.JobRecord
	lastSent uint32
	done     bool
}

// ID devuelve el id del job (no cambia).
func (j *Job) ID() string { return j.rec.JobId }

// Progress actualiza el avance (0-99: el 100 lo pone Done). Solo se guarda y se emite si
// cambia el mensaje o el avance sube al menos 5 puntos. El avance nunca retrocede.
func (j *Job) Progress(pct uint32, msg string) {
	if pct > 99 {
		pct = 99
	}
	msg = clean(msg)
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.done {
		return
	}
	if pct < j.rec.Progress {
		pct = j.rec.Progress
	}
	changed := msg != j.rec.Message || pct >= j.lastSent+progressStep
	j.rec.Progress, j.rec.Message = pct, msg
	if !changed {
		return
	}
	j.persist()
	j.emit("")
}

// Log añade una línea al log del job; se guarda y se emite como log_chunk.
func (j *Job) Log(line string) {
	chunk := clean(strings.TrimRight(line, "\n")) + "\n"
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.done {
		return
	}
	j.rec.Log = tail(j.rec.Log+chunk, MaxLog)
	j.persist()
	j.emit(chunk)
}

// Done cierra el job: OK con okMsg si err es nil, FAILED con el error si no. Idempotente.
func (j *Job) Done(err error, okMsg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.done {
		return
	}
	j.done = true
	if err != nil {
		j.rec.Status = mcsmv1.JobStatus_JOB_STATUS_FAILED
		j.rec.Message = clean(err.Error())
	} else {
		j.rec.Status = mcsmv1.JobStatus_JOB_STATUS_OK
		j.rec.Progress = 100
		j.rec.Message = clean(okMsg)
	}
	j.rec.FinishedUnixMs = j.t.now().UnixMilli()
	j.persist()
	j.emit("")
}

// Record devuelve una copia del estado actual.
func (j *Job) Record() *mcsmv1.JobRecord {
	j.mu.Lock()
	defer j.mu.Unlock()
	return proto.Clone(j.rec).(*mcsmv1.JobRecord)
}

func (j *Job) persist() {
	if err := j.t.st.PutJob(j.rec); err != nil {
		j.t.log.Warn("guardar job", "job", j.rec.JobId, "err", err)
	}
}

func (j *Job) emit(chunk string) {
	j.lastSent = j.rec.Progress
	_ = j.t.send(progressEnv(j.rec, chunk, j.t.now()))
}

func progressEnv(r *mcsmv1.JobRecord, chunk string, now time.Time) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Body: &mcsmv1.Envelope_JobProgress{JobProgress: &mcsmv1.JobProgress{
		JobId: r.JobId, ServerId: r.ServerId, Type: r.Type, Status: r.Status, Progress: r.Progress,
		Message: r.Message, LogChunk: chunk, TsUnixMs: now.UnixMilli(),
	}}}
}

// clean deja s en UTF-8 válido: proto3 rechaza strings inválidos al serializar, y los
// nombres de fichero o la salida de RCON pueden traer bytes sueltos.
func clean(s string) string { return strings.ToValidUTF8(s, "�") }

// tail recorta s a sus últimos max bytes (marcando el recorte) sin partir un carácter.
func tail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	const mark = "…(recortado)\n"
	cut := s[len(s)-max+len(mark):]
	if i := strings.IndexByte(cut, '\n'); i >= 0 && i < len(cut)-1 {
		cut = cut[i+1:]
	}
	return mark + strings.ToValidUTF8(cut, "")
}
