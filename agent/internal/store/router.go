package store

import (
	"errors"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// bRouter guarda la spec del mc-router del nodo (plan-8) bajo la clave "spec". Sin clave = el nodo
// no tiene router. El bucket se crea al primer uso para no tocar la lista de buckets de Open.
var (
	bRouter     = []byte("router")
	kRouterSpec = []byte("spec")
)

// RouterSpec devuelve la spec del router guardada, o nil si no hay.
func (s *Store) RouterSpec() (*mcsmv1.RouterSpec, error) {
	var out *mcsmv1.RouterSpec
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bRouter)
		if b == nil {
			return nil
		}
		raw := b.Get(kRouterSpec)
		if raw == nil {
			return nil
		}
		sp := &mcsmv1.RouterSpec{}
		if err := proto.Unmarshal(raw, sp); err != nil {
			return err
		}
		out = sp
		return nil
	})
	return out, err
}

// PutRouterSpec guarda (o sustituye) la spec del router.
func (s *Store) PutRouterSpec(sp *mcsmv1.RouterSpec) error {
	if sp == nil {
		return errors.New("store: spec de router vacía")
	}
	raw, err := proto.Marshal(sp)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists(bRouter)
		if err != nil {
			return err
		}
		return b.Put(kRouterSpec, raw)
	})
}

// DeleteRouterSpec borra la spec del router (idempotente).
func (s *Store) DeleteRouterSpec() error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bRouter)
		if b == nil {
			return nil
		}
		return b.Delete(kRouterSpec)
	})
}
