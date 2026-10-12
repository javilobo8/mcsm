package reconcile

import (
	"context"
	"errors"
	"fmt"

	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
)

// SetOnDemand fija qué servidores están «bajo demanda» (plan-8): los que arranca y para mc-router con
// su autoscale. Para ellos la reconciliación crea y recrea el contenedor, pero no para uno en marcha
// ni arranca uno parado: el estado deseado solo se aplica con las acciones de encendido (Power). Un
// contenedor que nunca arrancó sí se arranca, porque mc-router no lo vería (comprobado con mc-router
// 1.47.1: solo conoce los que vio arrancar o encontró parados al arrancar él) y lo duerme sin
// jugadores. Se llama antes de lanzar goroutines (App.New); después es de solo lectura. fn se invoca
// con el lock del servidor tomado: no puede llamar al reconciliador.
func (r *Reconciler) SetOnDemand(fn func(spec.Spec) bool) { r.onDemand = fn }

// Park aparca un servidor bajo demanda mientras está reservado (Hold): la reserva solo frena al
// agente, y mc-router, con su autoscale, arranca por su cuenta cualquier contenedor parado con
// hostname en cuanto un jugador intenta entrar (p. ej. sobre el mundo viejo a mitad de una
// restauración). Park lo para (con su espera) y lo borra: sin contenedor no hay nada que arrancar.
// Los datos están en el bind; al liberar la reserva, reconcileLocked lo recrea y lo arranca (ver
// SetOnDemand: mc-router lo vuelve a dormir sin jugadores). Devuelve false sin tocar nada si el
// servidor no está bajo demanda. Exige la reserva tomada: sin ella, un tick lo recrearía.
func (r *Reconciler) Park(ctx context.Context, serverID string) (bool, error) {
	unlock := r.lock(serverID)
	defer unlock()
	if r.heldReason(serverID) == "" {
		return false, errors.New("aparcar un servidor exige tenerlo reservado")
	}
	if r.onDemand == nil {
		return false, nil
	}
	sp, err := r.st.GetSpec(serverID)
	if err != nil || sp == nil {
		return false, err
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return false, err
	}
	if !r.onDemand(parsed) {
		return false, nil
	}
	c, err := r.find(ctx, serverID)
	if err != nil {
		return false, err
	}
	if c == nil {
		return true, nil // ya aparcado (o sin crear)
	}
	if err := r.eng.Stop(ctx, c.ID, StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return false, fmt.Errorf("parar: %w", err)
	}
	if err := r.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, docker.ErrNotFound) {
		return false, fmt.Errorf("eliminar: %w", err)
	}
	r.log.Info("servidor bajo demanda aparcado mientras está reservado", "server", sp.Slug)
	return true, nil
}
