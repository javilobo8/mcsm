package reconcile

import (
	"context"
)

// Lápidas de servidores retirados.
//
// SyncSpecs.removed_ids llega con Forget, que borra la spec al instante (nada debe
// resucitar el servidor ni anunciarlo en el Hello), y el contenedor se borra después, en
// segundo plano, con Remove. Si ese borrado falla, sin lápida nadie lo reintentaría: el
// Hello siguiente ya no lleva el id y el panel no vuelve a mandarlo en removed_ids, así que
// el contenedor quedaría huérfano para siempre.
//
// Por eso Forget borra la spec y deja una lápida explícita en el store en una sola
// transacción (store.ForgetWithTombstone). El tick recorre las lápidas (RetryRemovals) y
// reintenta el borrado hasta que termina bien; entonces la quita. Guardar una spec del mismo
// id (Apply, StoreForce) la anula en la misma transacción (store.PutSpec). Las lápidas no
// aparecen en ListSpecs: ni en el Hello, ni en los ticks, ni en el inventario.

// maxRemovalsPerTick acota los borrados que intenta cada pasada de RetryRemovals: cada uno
// puede tardar hasta StopTimeout, y varios contenedores atascados no deben retener el tick
// N×60 s. Los que fallan quedan en backoff y no cuentan en las pasadas siguientes.
const maxRemovalsPerTick = 3

// RetryRemovals reintenta borrar los contenedores de los servidores con lápida y devuelve
// los ids cuyo borrado terminó (también los que ya no tenían contenedor). Respeta el
// backoff de cada lápida (spec §6.2: 30 s, 60 s, … máx. 5 min) e intenta como mucho
// maxRemovalsPerTick por pasada. Los reservados (Hold) esperan a que se libere la reserva,
// que completa el borrado. Solo actúa sobre ids con lápida explícita: un contenedor mcsm.*
// sin spec ni lápida no se toca nunca (invariante §6.2).
func (r *Reconciler) RetryRemovals(ctx context.Context) []string {
	list, err := r.st.ListTombstones()
	if err != nil {
		r.log.Warn("listar lápidas", "err", err)
		return nil
	}
	var done []string
	attempts := 0
	for _, t := range list {
		if attempts >= maxRemovalsPerTick {
			break
		}
		tried, err := r.retryRemoval(ctx, t.ServerID)
		if !tried {
			continue
		}
		attempts++
		if err != nil {
			r.log.Warn("reintentar el borrado de un servidor retirado", "server", t.ServerID, "retirado", t.Since, "err", err)
			continue
		}
		r.log.Info("borrado pendiente de un servidor retirado completado", "server", t.ServerID)
		done = append(done, t.ServerID)
	}
	return done
}

// retryRemoval intenta borrar el contenedor de id si sigue con lápida (comprobado bajo el
// lock del servidor: un Apply o StoreForce pudo anularla después de listarla), no está
// reservado y su backoff venció. tried indica si hubo intento; err, si falló.
func (r *Reconciler) retryRemoval(ctx context.Context, id string) (tried bool, err error) {
	unlock := r.lock(id)
	defer unlock()
	if r.heldReason(id) != "" {
		return false, nil
	}
	r.mu.Lock()
	until, waiting := r.retryAt[id]
	r.mu.Unlock()
	if waiting && r.now().Before(until) {
		return false, nil
	}
	tomb, err := r.st.HasTombstone(id)
	if err != nil || !tomb {
		return false, err
	}
	sp, err := r.st.GetSpec(id)
	if err != nil {
		return false, err
	}
	if sp != nil {
		// No debería pasar (PutSpec borra la lápida): la spec manda y el servidor vive.
		return false, r.st.DeleteTombstone(id)
	}
	return true, r.removeTombstoned(ctx, id)
}

// removeTombstoned borra el contenedor de un servidor con lápida (sin sus datos) y quita la
// lápida; si falla, programa el siguiente intento con backoff. Requiere el lock del servidor.
func (r *Reconciler) removeTombstoned(ctx context.Context, id string) error {
	if err := r.removeLocked(ctx, id, false); err != nil {
		r.markFailure(id, 0, err.Error())
		return err
	}
	return nil
}
