package store

import (
	"encoding/binary"
	"errors"
	"time"

	"go.etcd.io/bbolt"
)

// bTombstones stores the tombstones: ids of servers withdrawn by the panel whose spec was already
// deleted but whose container is still pending deletion (the reconciler retries until it
// succeeds). Value: the instant of withdrawal (Unix ms, big endian).
//
// A spec and a tombstone for the same id never coexist: ForgetWithTombstone deletes the spec when
// setting the tombstone and PutSpec deletes the tombstone when storing the spec, each in a single
// transaction. Tombstones do not appear in ListSpecs (nor, therefore, in the Hello or in the
// ticks). The bucket is created on first use so as not to touch Open's bucket list.
var bTombstones = []byte("tombstones")

// Tombstone is a tombstone: server ServerID was withdrawn at Since.
type Tombstone struct {
	ServerID string
	Since    time.Time
}

// ForgetWithTombstone deletes id's spec and applied version and leaves its tombstone, in a
// single transaction: either the spec remains, or the tombstone does.
func (s *Store) ForgetWithTombstone(id string, at time.Time) error {
	if id == "" {
		return errors.New("store: tombstone without server_id")
	}
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, uint64(at.UnixMilli()))
	return s.db.Update(func(tx *bbolt.Tx) error {
		if err := tx.Bucket(bSpecs).Delete([]byte(id)); err != nil {
			return err
		}
		if err := tx.Bucket(bApplied).Delete([]byte(id)); err != nil {
			return err
		}
		// plan-9: without a spec, its crash loop latch and its pending save-on are left over.
		if err := deleteCrashLatch(tx, id); err != nil {
			return err
		}
		if err := deleteSaveOn(tx, id); err != nil {
			return err
		}
		if err := deletePackCleanup(tx, id); err != nil { // plan-11
			return err
		}
		b, err := tx.CreateBucketIfNotExists(bTombstones)
		if err != nil {
			return err
		}
		return b.Put([]byte(id), buf)
	})
}

// HasTombstone reports whether id has a tombstone.
func (s *Store) HasTombstone(id string) (bool, error) {
	has := false
	err := s.db.View(func(tx *bbolt.Tx) error {
		if b := tx.Bucket(bTombstones); b != nil {
			has = b.Get([]byte(id)) != nil
		}
		return nil
	})
	return has, err
}

// ListTombstones returns all the tombstones.
func (s *Store) ListTombstones() ([]Tombstone, error) {
	var out []Tombstone
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bTombstones)
		if b == nil {
			return nil
		}
		return b.ForEach(func(k, v []byte) error {
			t := Tombstone{ServerID: string(k)}
			if len(v) == 8 {
				t.Since = time.UnixMilli(int64(binary.BigEndian.Uint64(v)))
			}
			out = append(out, t)
			return nil
		})
	})
	return out, err
}

// DeleteTombstone removes id's tombstone (idempotent).
func (s *Store) DeleteTombstone(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		return deleteTombstone(tx, id)
	})
}

// deleteTombstone removes id's tombstone inside a write transaction.
func deleteTombstone(tx *bbolt.Tx, id string) error {
	if b := tx.Bucket(bTombstones); b != nil {
		return b.Delete([]byte(id))
	}
	return nil
}
