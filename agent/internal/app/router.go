package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/dockerproxy"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/router"
	"mcsm/agent/internal/spec"
)

// plan-8: el mc-router del nodo. La spec vive en el store (sobrevive a reinicios) y el contenedor se
// reconcilia en segundo plano, con el contexto de vida: al recibir RouterApply/RouterRemove, al
// arrancar el agente, cada reconcileEvery y con los eventos de Docker de su contenedor. Cada pasada
// envía RouterObserved (id = 0) por la sesión vigente; sin sesión se pierde y la siguiente lo repone.

// routerFilesDir es el directorio del host con los ficheros del router (la lista de jugadores del
// autoscale). Va dentro de DATA_ROOT porque es lo único del host que el agente ve en la misma ruta
// (montaje espejo, §6.1); empieza por punto, así que nunca coincide con el slug de un servidor.
func routerFilesDir(dataRoot string) string { return filepath.Join(dataRoot, ".mcsm-router") }

// proxySocketPath es el socket del proxy de Docker para el router: en el directorio del router, dentro de
// DATA_ROOT (ruta del host gracias al montaje espejo).
func proxySocketPath(dataRoot string) string {
	return filepath.Join(routerFilesDir(dataRoot), "docker.sock")
}

// routerPolicy decide qué arranques y paradas de mc-router (autoscale) deja pasar el proxy: solo servidores de este
// agente con hostname de router; nunca uno reservado (copia, restauración, migración) y, para arrancar, tampoco uno
// retenido por bucle de crash. Una parada permitida queda anotada: su die no cuenta como crash.
func (a *App) routerPolicy(ctx context.Context, op dockerproxy.Op, container string) error {
	ins, err := a.eng.Inspect(ctx, container)
	if err != nil {
		return fmt.Errorf("contenedor %s: %w", container, err)
	}
	id := ins.Labels[spec.LabelServerID]
	if ins.Labels[spec.LabelManaged] != "true" || id == "" || ins.Labels[spec.LabelRouterHost] == "" {
		return errors.New("no es un servidor con hostname de router de este nodo")
	}
	switch op {
	case dockerproxy.OpStart:
		if msg := a.rec.StartBlocked(id); msg != "" {
			return errors.New(msg)
		}
	case dockerproxy.OpStop:
		if reason := a.rec.HeldReason(id); reason != "" {
			return reconcile.Busy(reason)
		}
		// plan-9 (además del brief): como al arrancar, solo servidores que este agente conoce; las etiquetas
		// mcsm las puede poner cualquiera que cree contenedores en el mismo Docker.
		if sp, err := a.st.GetSpec(id); err != nil || sp == nil {
			return errors.New("servidor desconocido en este nodo")
		}
		a.intents.Note(ins.ID)
	}
	return nil
}

// onDemand indica si un servidor lo arranca y para mc-router (autoscale del router y hostname).
// La invoca el reconciliador con el lock del servidor tomado: solo lee un atómico del router.
func (a *App) onDemand(s spec.Spec) bool { return s.Router.Active() && a.router.Autoscale() }

// handleRouterApply guarda la spec del router y responde; el contenedor se ajusta en segundo plano.
func (a *App) handleRouterApply(id uint64, req *mcsmv1.RouterApply, send func(*mcsmv1.Envelope) error) {
	before := a.router.Autoscale()
	if err := router.Validate(req.GetSpec()); err != nil {
		_ = send(errMsg(id, errcode.InvalidRequest, err))
		return
	}
	if err := a.router.Apply(req.GetSpec()); err != nil {
		_ = send(errMsg(id, errcode.IOError, err)) // el store del agente (bbolt)
		return
	}
	_ = send(ack(id))
	a.routerAsync(a.life)
	if a.router.Autoscale() != before {
		a.reconcileAll(a.life) // cambia qué servidores están bajo demanda
	}
}

// handleRouterRemove borra la spec del router y responde; el contenedor se borra en segundo plano.
func (a *App) handleRouterRemove(id uint64, send func(*mcsmv1.Envelope) error) {
	before := a.router.Autoscale()
	if err := a.router.Clear(); err != nil {
		_ = send(errMsg(id, errcode.IOError, err))
		return
	}
	_ = send(ack(id))
	a.routerAsync(a.life)
	if before {
		a.reconcileAll(a.life) // los servidores bajo demanda vuelven a su estado deseado
	}
}

// routerAsync reconcilia el router sin bloquear (coalescido con el despachador) y publica su estado.
func (a *App) routerAsync(ctx context.Context) {
	a.dispatch(ctx, "router", func() {
		obs := a.router.Reconcile(ctx)
		_ = a.send(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_RouterObserved{RouterObserved: obs}})
	})
}

// routerLoop reconcilia el router al arrancar (reinicio del agente: lo recrea si falta) y cada
// reconcileEvery (borrado a mano, puerto liberado).
func (a *App) routerLoop(ctx context.Context) {
	a.routerAsync(ctx)
	t := time.NewTicker(reconcileEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.routerAsync(ctx)
		}
	}
}

// routerEvent reacciona a un evento de Docker del contenedor del router.
func (a *App) routerEvent(ctx context.Context, action string) {
	switch action {
	case "start", "die", "stop", "kill", "destroy", "oom", "restart":
		a.routerAsync(ctx)
	}
}

// isRouterEvent indica si el evento es del contenedor del router.
func isRouterEvent(labels map[string]string) bool { return labels[router.LabelRouter] == "true" }
