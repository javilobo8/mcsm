package app

import (
	"fmt"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/crashloop"
	"mcsm/agent/internal/docker"
)

// Tipos de Event que emite el agente (ver el comentario de `message Event` en agent.proto). El drift lo emite el
// reconciliador (reconcile.KindDrift).
const (
	KindCrash           = "crash"
	KindOOM             = "oom"
	KindCrashLoop       = "crash_loop"
	KindCrashLoopFailed = "crash_loop_failed"
	KindSaveOnPending   = "save_on_pending"
	KindSaveOnResumed   = "save_on_resumed"
)

// emitEvent encola un Event para el panel sin bloquear nunca (cola FIFO propia, como los avisos de copias). Sin
// conexión se pierde: lo que importa también queda en Observed.error.
func (a *App) emitEvent(serverID string, level mcsmv1.EventLevel, kind, msg string) {
	_ = a.events.post(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_Event{Event: &mcsmv1.Event{
		Level: level, ServerId: serverID, Kind: kind, Message: validUTF8(msg), TsUnixMs: time.Now().UnixMilli(),
	}}})
}

// onDie cuenta los cierres con error que no pidió nadie (spec §10). No son crashes: la salida limpia (código 0:
// /stop, la parada de mc-router por inactividad), una parada que pidió el agente o el proxy del router en los
// últimos minutos (Intents), nada mientras el servidor está reservado (copia, restauración, migración) ni los
// contenedores de servidores que este agente no conoce. Con más
// de crashloop.MaxCrashes en una hora para y retiene el servidor en segundo plano, con el contexto de vida.
func (a *App) onDie(serverID string, ev docker.Event) {
	code, ok := crashloop.ExitCode(ev)
	if !ok || code == 0 || a.intents.Expected(ev.ContainerID) || a.rec.Held(serverID) {
		return
	}
	if sp, err := a.st.GetSpec(serverID); err != nil || sp == nil {
		return // contenedor de otro agente sobre el mismo Docker (p. ej. las pruebas): no es nuestro
	}
	n, tripped := a.crashes.Record(serverID)
	a.emitEvent(serverID, mcsmv1.EventLevel_EVENT_LEVEL_WARN, KindCrash,
		fmt.Sprintf("El servidor se ha cerrado con el código %d (%d en la última hora)", code, n))
	if !tripped {
		return
	}
	life := a.life
	gen := a.rec.StartGen(serverID) // un arranque manual posterior deja sin efecto esta parada
	a.dispatch(life, "crashloop:"+serverID, func() {
		stopped, err := a.rec.CrashLoopStopUnlessStarted(life, serverID, n, gen)
		if err == nil && !stopped {
			a.log.Info("bucle de crash descartado: el servidor se arrancó a mano después", "server", serverID)
			return
		}
		if err != nil {
			a.log.Warn("parar un servidor en bucle de crash", "server", serverID, "err", err)
			a.emitEvent(serverID, mcsmv1.EventLevel_EVENT_LEVEL_ERROR, KindCrashLoopFailed,
				fmt.Sprintf("Bucle de crash (%d cierres con error en una hora), pero no se pudo parar: %v", n, err))
			return
		}
		a.log.Warn("servidor parado por bucle de crash", "server", serverID, "crashes", n)
		a.emitEvent(serverID, mcsmv1.EventLevel_EVENT_LEVEL_ERROR, KindCrashLoop,
			fmt.Sprintf("Bucle de crash: %d cierres con error en menos de una hora. El servidor se ha parado; revisa la consola y pulsa Arrancar para volver a intentarlo", n))
	})
}
