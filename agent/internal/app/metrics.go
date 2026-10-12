package app

import (
	"context"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/mc"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/stats"
)

// dialRcon abre una sesión RCON persistente para el sondeo de TPS.
func dialRcon(ctx context.Context, host string, port uint16, password string) (stats.Rcon, error) {
	c, err := mc.DialRcon(ctx, host, port, password)
	if err != nil {
		return nil, err // nunca un *RconConn nil dentro de la interfaz
	}
	return c, nil
}

// newSampler construye el muestreador de métricas (spec §6.4) sobre el store, Docker
// y el ping de estado de la App. Host, reloj y RCON se inyectan para los tests.
func (a *App) newSampler(host stats.HostReader, clock stats.Clock, dial stats.DialRcon) *stats.Sampler {
	return stats.New(stats.Options{
		Containers: a.eng,
		Host:       host,
		DataRoot:   a.cfg.DataRoot,
		Status: func(ctx context.Context, h string, p uint16) *mcsmv1.McStatus {
			return a.status(ctx, h, p)
		},
		Spec: func(serverID string) (spec.Spec, bool) {
			sp, err := a.st.GetSpec(serverID)
			if err != nil || sp == nil {
				return spec.Spec{}, false
			}
			parsed, err := spec.Parse(sp.SpecJson)
			if err != nil {
				return spec.Spec{}, false
			}
			return parsed, true
		},
		Dial:  dial,
		Send:  func(e *mcsmv1.Envelope) error { return a.send(e) },
		Clock: clock,
		Log:   a.log.With("component", "stats"),
	})
}

// runMetrics muestrea y envía un MetricBatch cada 10 s hasta que ctx termina.
func (a *App) runMetrics(ctx context.Context) {
	a.newSampler(stats.GopsutilHost{}, stats.RealClock, dialRcon).Run(ctx)
}
