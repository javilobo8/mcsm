// Package crashloop detecta bucles de crash de los servidores (spec §10): un servidor que se cierra con error
// más de MaxCrashes veces en Window se para. Intents distingue las paradas que pidió alguien (cada una explica un die) (el agente al
// parar, recrear o borrar; mc-router a través del proxy del socket) de los crashes.
package crashloop

import (
	"context"
	"strconv"
	"sync"
	"time"

	"mcsm/agent/internal/docker"
)

const (
	// Window es la ventana en la que se cuentan los crashes.
	Window = time.Hour
	// MaxCrashes: con más de estos crashes en Window el servidor está en bucle.
	MaxCrashes = 3
	// IntentTTL: el primer die hasta este tiempo después de un Stop/Kill/Remove pedido no es un crash. Cubre la
	// espera de una parada limpia (reconcile.StopTimeout, 60 s) con margen.
	IntentTTL = 3 * time.Minute
)

// Tracker cuenta los crashes de cada servidor en la última Window. Seguro para uso concurrente.
type Tracker struct {
	mu   sync.Mutex
	now  func() time.Time
	hits map[string][]time.Time
}

// NewTracker crea un contador con el reloj dado (time.Now si es nil).
func NewTracker(now func() time.Time) *Tracker {
	if now == nil {
		now = time.Now
	}
	return &Tracker{now: now, hits: map[string][]time.Time{}}
}

// Record anota un crash de serverID y devuelve cuántos lleva en la última Window y si supera MaxCrashes. Al
// dispararse olvida los anteriores: tras la parada, la cuenta del servidor empieza de cero.
func (t *Tracker) Record(serverID string) (count int, tripped bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	var keep []time.Time
	for _, h := range t.hits[serverID] {
		if now.Sub(h) < Window {
			keep = append(keep, h)
		}
	}
	keep = append(keep, now)
	if len(keep) > MaxCrashes {
		delete(t.hits, serverID)
		return len(keep), true
	}
	t.hits[serverID] = keep
	return len(keep), false
}

// Reset olvida los crashes de serverID (p. ej. al arrancarlo a mano).
func (t *Tracker) Reset(serverID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.hits, serverID)
}

// Intents recuerda, por contenedor, las paradas pedidas (Stop, Kill, Remove) de los últimos IntentTTL. Cada una
// explica un solo die: un bucle que empieza justo después de un Reiniciar se cuenta desde el primer crash.
// Seguro para uso concurrente.
type Intents struct {
	mu  sync.Mutex
	now func() time.Time
	at  map[string][]time.Time // por contenedor, de la más antigua a la más reciente
}

// NewIntents crea el registro con el reloj dado (time.Now si es nil).
func NewIntents(now func() time.Time) *Intents {
	if now == nil {
		now = time.Now
	}
	return &Intents{now: now, at: map[string][]time.Time{}}
}

// Note anota que alguien pidió parar (o matar, o borrar) el contenedor id. Poda las anotaciones caducadas de
// todos los contenedores (una parada sin die, p. ej. sobre uno ya parado o borrado, no se queda para siempre).
func (i *Intents) Note(id string) {
	if id == "" {
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	now := i.now()
	for k := range i.at {
		i.pruneLocked(k, now)
	}
	i.at[id] = append(i.at[id], now)
}

// Consume indica si un die de id lo explica una parada pedida hace como mucho IntentTTL y, si es así, la gasta.
func (i *Intents) Consume(id string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	pending := i.pruneLocked(id, i.now())
	if len(pending) == 0 {
		return false
	}
	if len(pending) == 1 {
		delete(i.at, id)
	} else {
		i.at[id] = pending[1:]
	}
	return true
}

// pruneLocked quita las anotaciones caducadas de id y devuelve las que quedan.
func (i *Intents) pruneLocked(id string, now time.Time) []time.Time {
	list := i.at[id]
	n := 0
	for n < len(list) && now.Sub(list[n]) > IntentTTL {
		n++
	}
	if n == len(list) {
		delete(i.at, id)
		return nil
	}
	if n > 0 {
		list = list[n:]
		i.at[id] = list
	}
	return list
}

// Engine envuelve un docker.Engine y anota en Intents cada parada, muerte o borrado que pide el agente. Todo
// lo demás pasa al motor de debajo.
type Engine struct {
	docker.Engine
	Intents *Intents
}

func (e Engine) Stop(ctx context.Context, id string, timeout time.Duration) error {
	e.Intents.Note(id)
	return e.Engine.Stop(ctx, id, timeout)
}

func (e Engine) Kill(ctx context.Context, id string) error {
	e.Intents.Note(id)
	return e.Engine.Kill(ctx, id)
}

func (e Engine) Remove(ctx context.Context, id string) error {
	e.Intents.Note(id)
	return e.Engine.Remove(ctx, id)
}

// ExitCode devuelve el código de salida de un evento die (atributo exitCode de Docker, que Moby.Events copia
// en Event.Labels). false si no lo trae o no es un número.
func ExitCode(ev docker.Event) (int, bool) {
	v, ok := ev.Labels["exitCode"]
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	return n, err == nil
}
