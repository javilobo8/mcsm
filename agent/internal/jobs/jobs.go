// Package jobs registra los jobs largos del agente (backup, restore): los persiste en el
// store para responder a un job_id repetido sin repetir el trabajo (spec §5.4) y emite
// JobProgress al panel.
//
// Limitación conocida del log: las líneas que caen dentro de la ventana LogEvery tras un
// volcado solo se guardan y envían con la siguiente línea, Progress o Done (no hay volcado
// diferido por temporizador). El log completo siempre queda guardado en Done.
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

	// MaxLog es el log que se guarda por job (se conserva el final).
	MaxLog = 64 << 10
	// KeepFor es cuánto se recuerdan los jobs terminados.
	KeepFor = 7 * 24 * time.Hour
	// progressStep: un avance menor no se emite (no inundar el WS con ficheros pequeños).
	progressStep = 5
	// inventoryJobs e inventoryLog acotan el tamaño del inventario que se envía al panel.
	inventoryJobs = 200
	inventoryLog  = 4 << 10

	// MaxMessage acota el mensaje de estado de un job.
	MaxMessage = 1024
	// LogEvery es el intervalo mínimo entre volcados (guardar + enviar) del log de un job.
	LogEvery = time.Second

	putAttempts  = 3
	putRetryWait = 200 * time.Millisecond
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
	// sleep es la espera entre reintentos de guardado (inyectable en tests).
	sleep func(time.Duration)
	mu    sync.Mutex // serializa Begin: dos duplicados simultáneos no arrancan dos ejecuciones
}

// New crea un Tracker. send debe tolerar estar desconectado (devuelve error y se ignora).
func New(st Store, send func(*mcsmv1.Envelope) error, now func() time.Time) *Tracker {
	return &Tracker{st: st, send: send, now: now, sleep: time.Sleep, log: slog.Default().With("component", "jobs")}
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
	if id == "" || serverID == "" || typ == "" {
		return nil, nil, errors.New("job sin id, servidor o tipo")
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

// Replay reenvía al panel el estado guardado de un job (respuesta a un job_id repetido).
func (t *Tracker) Replay(rec *mcsmv1.JobRecord) {
	_ = t.send(progressEnv(rec, "", t.now()))
}

// FailInterrupted marca FAILED los jobs que quedaron RUNNING (el agente se reinició a mitad)
// y olvida los terminados hace más de KeepFor. Llamar solo al arrancar, antes de aceptar
// jobs (no toma t.mu).
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

// Job es un job en curso. Sus métodos son seguros para uso concurrente. Nunca se llama a
// send con el lock tomado: un envío lento no bloquea Record ni los demás métodos.
//
// Orden de locks fijo: sendMu -> mu. sendMu serializa guardar+enviar por job, de modo que los
// avisos salen en el orden en que se producen y tras el terminal no sale ninguno (los métodos
// ven j.done y vuelven antes de emitir).
type Job struct {
	t        *Tracker
	sendMu   sync.Mutex
	mu       sync.Mutex
	rec      *mcsmv1.JobRecord
	lastSent uint32
	done     bool
	pending  string    // líneas de log aún sin enviar al panel
	lastLog  time.Time // último volcado del log (cero = ninguno todavía)
}

// ID devuelve el id del job (no cambia).
func (j *Job) ID() string { return j.rec.JobId }

// Progress actualiza el avance (0-99: el 100 lo pone Done). Solo se guarda y se emite si
// cambia el mensaje o el avance sube al menos 5 puntos. El avance nunca retrocede.
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

// Log añade una línea al log del job. Se acumula en memoria y se guarda y envía (como un
// único log_chunk con las líneas pendientes) la primera vez y luego como mucho cada LogEvery;
// Done vuelca siempre lo que quede.
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

// Done cierra el job: OK con okMsg si err es nil, FAILED con el error si no. Idempotente.
// El estado en memoria queda final aunque falle el guardado; si tras reintentar sigue
// fallando devuelve el error (el llamante debe registrarlo): en disco quedaría RUNNING.
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
	// Reintentos fuera de j.mu (Record no espera); sendMu los serializa con el resto.
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
		return fmt.Errorf("guardar el estado final del job %s: %w", j.rec.JobId, perr)
	}
	return nil
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

// snapshot (con j.mu tomado) construye el aviso con el log pendiente y lo da por enviado.
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

// limit recorta s a max bytes sin partir un carácter.
func limit(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}
