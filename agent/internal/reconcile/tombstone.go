package reconcile

import (
	"context"
	"math"

	"mcsm/agent/internal/spec"
)

// Lápidas de servidores retirados.
//
// SyncSpecs.removed_ids llega con Forget, que borra la spec al instante (nada debe
// resucitar el servidor ni anunciarlo en el Hello), y el contenedor se borra después, en
// segundo plano, con Remove. Si ese borrado falla, sin lápida nadie lo reintentaría: el
// Hello siguiente ya no lleva el id y el panel no vuelve a mandarlo en removed_ids, así que
// el contenedor quedaría huérfano para siempre. Forget deja por eso una lápida en el store;
// el tick la reintenta (RetryRemovals) hasta que el borrado termina bien y entonces la
// quita. Un Apply o StoreForce del mismo id la anula.
//
// La lápida usa la API existente del store, sin bucket propio: es un valor centinela en la
// versión aplicada de un id SIN spec. Así no aparece en ListSpecs (ni en el Hello, ni en
// los ticks, ni en el inventario) y se enumera a partir de los contenedores mcsm.* vivos,
// que son justo lo que queda por borrar. Toda lectura y escritura de lápidas va bajo el
// lock por servidor (salvo el prefiltro sin lock de RetryRemovals, que se repite con él).
const tombstone uint64 = math.MaxUint64

// tombstoned indica si id tiene lápida: sin spec y con la versión aplicada centinela.
func (r *Reconciler) tombstoned(id string) (bool, error) {
	sp, err := r.st.GetSpec(id)
	if err != nil || sp != nil {
		return false, err
	}
	v, err := r.st.Applied(id)
	return v == tombstone, err
}

// putTombstone marca id para borrar su contenedor. Va tras DeleteSpec, que borra también
// la versión aplicada. Requiere el lock del servidor.
func (r *Reconciler) putTombstone(id string) error {
	return r.st.SetApplied(id, tombstone)
}

// dropTombstone quita la lápida de id, si la tiene. Solo actúa sobre ids sin spec (sin
// spec, DeleteSpec solo borra la versión aplicada). Requiere el lock del servidor.
func (r *Reconciler) dropTombstone(id string) error {
	tomb, err := r.tombstoned(id)
	if err != nil || !tomb {
		return err
	}
	return r.st.DeleteSpec(id)
}

// RetryRemovals reintenta borrar los contenedores de los servidores con lápida y devuelve
// los ids cuyo borrado terminó. Los reservados (Hold) esperan al siguiente tick. Nunca toca
// contenedores sin lápida (invariante §6.2).
func (r *Reconciler) RetryRemovals(ctx context.Context) []string {
	list, err := r.eng.ListManaged(ctx)
	if err != nil {
		r.log.Warn("listar contenedores para reintentar borrados", "err", err)
		return nil
	}
	var done []string
	seen := map[string]bool{}
	for _, c := range list {
		id := c.Labels[spec.LabelServerID]
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		// Prefiltro sin lock: no esperar al lock de servidores vivos en una operación larga.
		if tomb, err := r.tombstoned(id); err != nil || !tomb {
			continue
		}
		ok, err := r.retryRemoval(ctx, id)
		if err != nil {
			r.log.Warn("reintentar el borrado de un servidor retirado", "server", id, "err", err)
			continue
		}
		if ok {
			r.log.Info("contenedor de un servidor retirado borrado al reintentar", "server", id)
			done = append(done, id)
		}
	}
	return done
}

// retryRemoval borra el contenedor de id si sigue con lápida (comprobado bajo el lock: un
// StoreForce pudo anularla entre el prefiltro y aquí).
func (r *Reconciler) retryRemoval(ctx context.Context, id string) (bool, error) {
	unlock := r.lock(id)
	defer unlock()
	if r.heldReason(id) != "" {
		return false, nil
	}
	tomb, err := r.tombstoned(id)
	if err != nil || !tomb {
		return false, err
	}
	if err := r.removeLocked(ctx, id, false); err != nil {
		return false, err
	}
	return true, nil
}
