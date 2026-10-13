package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"go.etcd.io/bbolt"
)

// plan-9: retención por bucle de crash (spec §10) y servidores con save-on pendiente (m6/m7 del Plan 4).
// Los buckets se crean al primer uso, como router y tombstones, para no tocar la lista de Open.
var (
	bCrashLatch = []byte("crash_latch")
	bSaveOn     = []byte("saveon_pending")
)

// CrashLatch marca un servidor parado por bucle de crash. Mientras su spec siga en Version, la reconciliación
// no lo arranca; lo levantan una acción de encendido (Power start/restart) o una versión nueva de la spec.
type CrashLatch struct {
	Version uint64    `json:"version"`
	Crashes int       `json:"crashes"`
	At      time.Time `json:"at"`
}

// PutCrashLatch guarda (o sustituye) la retención de id.
func (s *Store) PutCrashLatch(id string, l CrashLatch) error {
	if id == "" {
		return errors.New("store: retención sin server_id")
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

// CrashLatch devuelve la retención de id, o nil si no tiene.
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

// DeleteCrashLatch borra la retención de id (idempotente).
func (s *Store) DeleteCrashLatch(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error { return deleteCrashLatch(tx, id) })
}

func deleteCrashLatch(tx *bbolt.Tx, id string) error {
	if b := tx.Bucket(bCrashLatch); b != nil {
		return b.Delete([]byte(id))
	}
	return nil
}

// MarkSaveOnPending anota que el guardado automático de id pudo quedar desactivado (save-on falló).
func (s *Store) MarkSaveOnPending(id string, at time.Time) error {
	if id == "" {
		return errors.New("store: save-on pendiente sin server_id")
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

// SaveOnPending lista, ordenados, los servidores con save-on pendiente.
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

// ClearSaveOnPending quita a id de los pendientes (idempotente).
func (s *Store) ClearSaveOnPending(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error { return deleteSaveOn(tx, id) })
}

func deleteSaveOn(tx *bbolt.Tx, id string) error {
	if b := tx.Bucket(bSaveOn); b != nil {
		return b.Delete([]byte(id))
	}
	return nil
}
