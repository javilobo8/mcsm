package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"go.etcd.io/bbolt"
)

// plan-9: crash loop latch (spec §10) and servers with a pending save-on (m6/m7 of Plan 4).
// The buckets are created on first use, like router and tombstones, so as not to touch Open's list.
var (
	bCrashLatch = []byte("crash_latch")
	bSaveOn     = []byte("saveon_pending")
)

// CrashLatch marks a server stopped by a crash loop. While its spec stays at Version, the reconciliation
// does not start it; a power action (Power start/restart) or a new spec version lifts it.
type CrashLatch struct {
	Version uint64    `json:"version"`
	Crashes int       `json:"crashes"`
	At      time.Time `json:"at"`
}

// PutCrashLatch stores (or replaces) id's latch.
func (s *Store) PutCrashLatch(id string, l CrashLatch) error {
	if id == "" {
		return errors.New("store: latch without server_id")
	}
	raw, err := json.Marshal(l)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists(bCrashLatch)
		if err != nil {
			return err
		}
		return b.Put([]byte(id), raw)
	})
}

// CrashLatch returns id's latch, or nil if it has none.
func (s *Store) CrashLatch(id string) (*CrashLatch, error) {
	var out *CrashLatch
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bCrashLatch)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte(id))
		if raw == nil {
			return nil
		}
		var l CrashLatch
		if err := json.Unmarshal(raw, &l); err != nil {
			return err
		}
		out = &l
		return nil
	})
	return out, err
}

// DeleteCrashLatch deletes id's latch (idempotent).
func (s *Store) DeleteCrashLatch(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error { return deleteCrashLatch(tx, id) })
}

func deleteCrashLatch(tx *bbolt.Tx, id string) error {
	if b := tx.Bucket(bCrashLatch); b != nil {
		return b.Delete([]byte(id))
	}
	return nil
}

// MarkSaveOnPending records that id's autosave may have been left disabled (save-on failed).
func (s *Store) MarkSaveOnPending(id string, at time.Time) error {
	if id == "" {
		return errors.New("store: pending save-on without server_id")
	}
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, uint64(at.UnixMilli()))
	return s.db.Update(func(tx *bbolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists(bSaveOn)
		if err != nil {
			return err
		}
		return b.Put([]byte(id), buf)
	})
}

// SaveOnPending lists, sorted, the servers with a pending save-on.
func (s *Store) SaveOnPending() ([]string, error) {
	var ids []string
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bSaveOn)
		if b == nil {
			return nil
		}
		return b.ForEach(func(k, _ []byte) error {
			ids = append(ids, string(k))
			return nil
		})
	})
	sort.Strings(ids)
	return ids, err
}

// ClearSaveOnPending removes id from the pending ones (idempotent).
func (s *Store) ClearSaveOnPending(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error { return deleteSaveOn(tx, id) })
}

func deleteSaveOn(tx *bbolt.Tx, id string) error {
	if b := tx.Bucket(bSaveOn); b != nil {
		return b.Delete([]byte(id))
	}
	return nil
}
