package store

import (
	"errors"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// bRouter stores the node's mc-router spec (plan-8) under the "spec" key. No key = the node
// has no router. The bucket is created on first use so as not to touch Open's bucket list.
var (
	bRouter     = []byte("router")
	kRouterSpec = []byte("spec")
)

// RouterSpec returns the stored router spec, or nil if there is none.
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

// PutRouterSpec stores (or replaces) the router spec.
func (s *Store) PutRouterSpec(sp *mcsmv1.RouterSpec) error {
	if sp == nil {
		return errors.New("store: empty router spec")
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

// DeleteRouterSpec deletes the router spec (idempotent).
func (s *Store) DeleteRouterSpec() error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bRouter)
		if b == nil {
			return nil
		}
		return b.Delete(kRouterSpec)
	})
}
