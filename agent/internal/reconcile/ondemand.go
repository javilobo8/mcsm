package reconcile

import "mcsm/agent/internal/spec"

// SetOnDemand fija qué servidores están «bajo demanda» (plan-8): los que arranca y para mc-router con
// su autoscale. Para ellos la reconciliación crea y recrea el contenedor, pero no arranca uno parado
// ni para uno en marcha: el estado deseado solo se aplica al crearlo y con las acciones de encendido
// (Power). Se llama antes de lanzar goroutines (App.New); después es de solo lectura. fn se invoca
// con el lock del servidor tomado: no puede llamar al reconciliador.
func (r *Reconciler) SetOnDemand(fn func(spec.Spec) bool) { r.onDemand = fn }
