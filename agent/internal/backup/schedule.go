package backup

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"mcsm/agent/internal/spec"
)

// Clock es el reloj del planificador (inyectable en tests).
type Clock interface {
	Now() time.Time
	// Until devuelve un canal que recibe un valor cuando el reloj alcanza t.
	Until(t time.Time) <-chan time.Time
}

type realClock struct{}

func (realClock) Now() time.Time                     { return time.Now() }
func (realClock) Until(t time.Time) <-chan time.Time { return time.After(time.Until(t)) }

// RealClock es el reloj del sistema. Las expresiones cron se interpretan en su zona
// horaria (variable TZ del contenedor del agente; UTC si no se define).
var RealClock Clock = realClock{}

// maxSchedWait acota cada espera: un salto del reloj del sistema se corrige en ≤ 1 min.
const maxSchedWait = time.Minute

// maxLate es la tardanza máxima con la que aún se dispara una ejecución: si el agente (o el
// equipo) estuvo suspendido más tiempo, la ejecución se salta y se recalcula la siguiente.
const maxLate = 5 * time.Minute

type schedEntry struct {
	expr  string
	sched cron.Schedule
	next  time.Time
}

// Scheduler dispara fire(serverID) según la expresión cron de cada servidor. Usa
// cron.ParseStandard de robfig/cron para calcular la siguiente ejecución y un bucle propio
// con reloj inyectable (el runner de robfig usa el reloj real y no se puede probar). Una
// ejecución perdida (agente parado) no se recupera.
type Scheduler struct {
	clock   Clock
	fire    func(serverID string)
	mu      sync.Mutex
	entries map[string]*schedEntry
	wake    chan struct{}
}

// NewScheduler crea el planificador. fire se llama desde el bucle: debe volver enseguida.
func NewScheduler(clock Clock, fire func(serverID string)) *Scheduler {
	return &Scheduler{clock: clock, fire: fire, entries: map[string]*schedEntry{}, wake: make(chan struct{}, 1)}
}

// Set programa un servidor o lo reprograma si cambió la expresión (si no cambió, conserva
// la próxima ejecución). Una expresión vacía lo desprograma.
func (s *Scheduler) Set(serverID, expr string) error {
	if expr == "" {
		s.Remove(serverID)
		return nil
	}
	// ValidCron aplica el mismo criterio que el panel (sin @daily, nombres, ? ni CRON_TZ,
	// solo ASCII); ParseStandard sola los aceptaría. Valida la expresión original, antes de
	// normalizar. Ver TestSchedulerSetMatchesPanelFixture.
	if err := spec.ValidCron(expr); err != nil {
		return err
	}
	expr = strings.Join(strings.Fields(expr), " ") // una variante con espacios no reprograma
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.entries[serverID]; ok && e.expr == expr {
		return nil
	}
	sched, err := cron.ParseStandard(expr)
	if err != nil {
		return err
	}
	s.entries[serverID] = &schedEntry{expr: expr, sched: sched, next: sched.Next(s.clock.Now())}
	s.poke()
	return nil
}

// Remove desprograma un servidor.
func (s *Scheduler) Remove(serverID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.entries[serverID]; ok {
		delete(s.entries, serverID)
		s.poke()
	}
}

// IDs devuelve los servidores programados, ordenados.
func (s *Scheduler) IDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.entries))
	for id := range s.entries {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Next devuelve la próxima ejecución de un servidor.
func (s *Scheduler) Next(serverID string) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[serverID]
	if !ok {
		return time.Time{}, false
	}
	return e.next, true
}

func (s *Scheduler) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run ejecuta el bucle hasta que ctx termina.
func (s *Scheduler) Run(ctx context.Context) {
	for {
		now := s.clock.Now()
		wakeAt := now.Add(maxSchedWait)
		type dueItem struct {
			id    string
			entry *schedEntry
		}
		var due []dueItem
		s.mu.Lock()
		for id, e := range s.entries {
			if !e.next.After(now) {
				if late := now.Sub(e.next); late > maxLate {
					slog.Warn("copia programada saltada: el planificador despertó tarde", "serverId", id, "late", late.Round(time.Second))
				} else {
					due = append(due, dueItem{id, e})
				}
				e.next = e.sched.Next(now)
			}
			if e.next.Before(wakeAt) {
				wakeAt = e.next
			}
		}
		s.mu.Unlock()
		sort.Slice(due, func(i, j int) bool { return due[i].id < due[j].id })
		for _, d := range due {
			// Un Remove o Set posterior al vencimiento anula el disparo (la ventana restante
			// es la de un Remove concurrente a la propia llamada a fire).
			s.mu.Lock()
			current := s.entries[d.id] == d.entry
			s.mu.Unlock()
			if current {
				s.fire(d.id)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-s.clock.Until(wakeAt):
		}
	}
}

// ShouldRun decide si un backup programado se hace (onlyIfPlayersSince, spec §6.5). Se
// omite solo si: hay un backup anterior, el agente ha observado el servidor desde antes de
// ese backup y nadie se ha conectado desde entonces. lastBackup debe ser el INICIO de la última
// copia (con el fin, un jugador que entró durante la copia contaría como anterior y se omitiría
// la siguiente). PlayerWatch muestrea cada ~10 s: una conexión más corta puede pasar inadvertida. Ante la duda (agente reiniciado), se hace.
func ShouldRun(onlyIfPlayersSince bool, lastBackup, playersSeen, watchingSince time.Time) bool {
	if !onlyIfPlayersSince || lastBackup.IsZero() {
		return true
	}
	if watchingSince.After(lastBackup) {
		return true
	}
	return playersSeen.After(lastBackup)
}

// PlayerWatch recuerda cuándo se vio por última vez a algún jugador en cada servidor (con
// cada estado observado, cada ~10 s). Solo en memoria: Since indica desde cuándo observa.
type PlayerWatch struct {
	now   func() time.Time
	since time.Time
	mu    sync.Mutex
	seen  map[string]time.Time
}

// NewPlayerWatch empieza a observar ahora.
func NewPlayerWatch(now func() time.Time) *PlayerWatch {
	return &PlayerWatch{now: now, since: now(), seen: map[string]time.Time{}}
}

// Observe anota el número de jugadores conectados de un servidor.
func (w *PlayerWatch) Observe(serverID string, playersOnline uint32) {
	if playersOnline == 0 {
		return
	}
	t := w.now()
	w.mu.Lock()
	w.seen[serverID] = t
	w.mu.Unlock()
}

// LastSeen es la última vez que el servidor tenía jugadores (cero si nunca desde Since).
func (w *PlayerWatch) LastSeen(serverID string) time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.seen[serverID]
}

// Since es desde cuándo se observa.
func (w *PlayerWatch) Since() time.Time { return w.since }
