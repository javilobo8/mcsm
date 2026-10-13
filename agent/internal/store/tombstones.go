package store

import (
	"encoding/binary"
	"errors"
	"time"

	"go.etcd.io/bbolt"
)

// bTombstones guarda las lápidas: ids de servidores retirados por el panel cuya spec ya
// se borró pero cuyo contenedor queda por borrar (el reconciliador lo reintenta hasta
// conseguirlo). Valor: instante de la retirada (ms Unix, big endian).
//
// Una spec y una lápida del mismo id nunca conviven: ForgetWithTombstone borra la spec al
// poner la lápida y PutSpec borra la lápida al guardar la spec, cada uno en una sola
// transacción. Las lápidas no aparecen en ListSpecs (ni, por tanto, en el Hello ni en los
// ticks). El bucket se crea al primer uso para no tocar la lista de buckets de Open.
var bTombstones = []byte("tombstones")

// Tombstone es una lápida: el servidor ServerID se retiró en Since.
type Tombstone struct {
	ServerID string
	Since    time.Time
}

// ForgetWithTombstone borra la spec y la versión aplicada de id y deja su lápida, en una
// sola transacción: o queda la spec, o queda la lápida.
func (s *Store) ForgetWithTombstone(id string, at time.Time) error {
	if id == "" {
		return errors.New("store: lápida sin server_id")
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
		// plan-9: sin spec sobran su retención por bucle de crash y su save-on pendiente.
		if err := deleteCrashLatch(tx, id); err != nil {
			return err
		}
		if err := deleteSaveOn(tx, id); err != nil {
			return err
		}
		b, err := tx.CreateBucketIfNotExists(bTombstones)
		if err != nil {
			return err
		}
		return b.Put([]byte(id), buf)
	})
}

// HasTombstone indica si id tiene lápida.
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

// ListTombstones devuelve todas las lápidas.
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

// DeleteTombstone quita la lápida de id (idempotente).
func (s *Store) DeleteTombstone(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		return deleteTombstone(tx, id)
	})
}

// deleteTombstone quita la lápida de id dentro de una transacción de escritura.
func deleteTombstone(tx *bbolt.Tx, id string) error {
	if b := tx.Bucket(bTombstones); b != nil {
		return b.Delete([]byte(id))
	}
	return nil
}
