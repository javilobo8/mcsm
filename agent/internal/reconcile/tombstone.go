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

// RetryRemovals reintenta borrar los contenedores de los servidores con lápida y devuelve
// los ids cuyo borrado terminó (también los que ya no tenían contenedor). Los reservados
// (Hold) esperan al siguiente tick. Solo actúa sobre ids con lápida explícita: un
// contenedor mcsm.* sin spec ni lápida no se toca nunca (invariante §6.2).
func (r *Reconciler) RetryRemovals(ctx context.Context) []string {
	list, err := r.st.ListTombstones()
	if err != nil {
		r.log.Warn("listar lápidas", "err", err)
		return nil
	}
	var done []string
	for _, t := range list {
		ok, err := r.retryRemoval(ctx, t.ServerID)
		if err != nil {
			r.log.Warn("reintentar el borrado de un servidor retirado", "server", t.ServerID, "retirado", t.Since, "err", err)
			continue
		}
		if ok {
			r.log.Info("borrado pendiente de un servidor retirado completado", "server", t.ServerID)
			done = append(done, t.ServerID)
		}
	}
	return done
}

// retryRemoval borra el contenedor de id si sigue con lápida, comprobado bajo el lock del
// servidor (un Apply o StoreForce pudo anularla después de listarla).
func (r *Reconciler) retryRemoval(ctx context.Context, id string) (bool, error) {
	unlock := r.lock(id)
	defer unlock()
	if r.heldReason(id) != "" {
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
	if err := r.removeLocked(ctx, id, false); err != nil {
		return false, err
	}
	return true, nil
}
