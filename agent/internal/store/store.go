// Package store persiste credenciales, specs y versiones aplicadas en bbolt.
package store

import (
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

var (
	bMeta    = []byte("meta")
	bSpecs   = []byte("specs")
	bApplied = []byte("applied")

	kNodeID = []byte("node_id")
	kToken  = []byte("node_token")
)

type Store struct{ db *bbolt.DB }

type Credentials struct {
	NodeID string
	Token  string
}

func Open(path string) (*Store, error) {
	db, err := bbolt.Open(path, 0o600, &bbolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, fmt.Errorf("store: abrir %s: %w", path, err)
	}
	err = db.Update(func(tx *bbolt.Tx) error {
		for _, b := range [][]byte{bMeta, bSpecs, bApplied} {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Credentials() (*Credentials, error) {
	var c *Credentials
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bMeta)
		id, tok := b.Get(kNodeID), b.Get(kToken)
		if id == nil || tok == nil {
			return nil
		}
		c = &Credentials{NodeID: string(id), Token: string(tok)}
		return nil
	})
	return c, err
}

func (s *Store) SaveCredentials(c Credentials) error {
	if c.NodeID == "" || c.Token == "" {
		return errors.New("store: credenciales vacías")
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bMeta)
		if err := b.Put(kNodeID, []byte(c.NodeID)); err != nil {
			return err
		}
		return b.Put(kToken, []byte(c.Token))
	})
}

func (s *Store) PutSpec(sp *mcsmv1.ServerSpec) error {
	if sp.GetServerId() == "" {
		return errors.New("store: spec sin server_id")
	}
	raw, err := proto.Marshal(sp)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		if err := tx.Bucket(bSpecs).Put([]byte(sp.ServerId), raw); err != nil {
			return err
		}
		return deleteTombstone(tx, sp.ServerId) // spec y lápida del mismo id no conviven
	})
}

func (s *Store) GetSpec(id string) (*mcsmv1.ServerSpec, error) {
	var out *mcsmv1.ServerSpec
	err := s.db.View(func(tx *bbolt.Tx) error {
		raw := tx.Bucket(bSpecs).Get([]byte(id))
		if raw == nil {
			return nil
		}
		sp := &mcsmv1.ServerSpec{}
		if err := proto.Unmarshal(raw, sp); err != nil {
			return err
		}
		out = sp
		return nil
	})
	return out, err
}

func (s *Store) ListSpecs() ([]*mcsmv1.ServerSpec, error) {
	var out []*mcsmv1.ServerSpec
	err := s.db.View(func(tx *bbolt.Tx) error {
		return tx.Bucket(bSpecs).ForEach(func(_, raw []byte) error {
			sp := &mcsmv1.ServerSpec{}
			if err := proto.Unmarshal(raw, sp); err != nil {
				return err
			}
			out = append(out, sp)
			return nil
		})
	})
	return out, err
}

func (s *Store) DeleteSpec(id string) error {
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
		return deleteSaveOn(tx, id)
	})
}

func (s *Store) SpecVersions() (map[string]uint64, error) {
	list, err := s.ListSpecs()
	if err != nil {
		return nil, err
	}
	out := make(map[string]uint64, len(list))
	for _, sp := range list {
		out[sp.ServerId] = sp.Version
	}
	return out, nil
}

func (s *Store) SetApplied(id string, v uint64) error {
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, v)
	return s.db.Update(func(tx *bbolt.Tx) error {
		return tx.Bucket(bApplied).Put([]byte(id), buf)
	})
}

func (s *Store) Applied(id string) (uint64, error) {
	var v uint64
	err := s.db.View(func(tx *bbolt.Tx) error {
		raw := tx.Bucket(bApplied).Get([]byte(id))
		if len(raw) == 8 {
			v = binary.BigEndian.Uint64(raw)
		}
		return nil
	})
	return v, err
}
