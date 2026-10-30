package store

import (
	"encoding/json"
	"errors"
	"slices"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// plan-11: modpack platforms whose files the agent still has to delete from a server's data folder
// before creating its next container (uninstall or platform switch). Value: JSON array, sorted
// and without duplicates. It is set in the same transaction as the spec that requires it, so that a
// crash between storing the spec and cleaning does not lose the cleanup. Created on first use.
var bPackCleanup = []byte("pack_cleanup")

// PutSpecMarkingPackCleanup is PutSpec plus, with platform ≠ "", adding platform to id's pending pack
// cleanups, in a single transaction. With platform == "" it behaves exactly like PutSpec.
func (s *Store) PutSpecMarkingPackCleanup(sp *mcsmv1.ServerSpec, platform string) error {
	if sp.GetServerId() == "" {
		return errors.New("store: spec without server_id")
	}
	raw, err := proto.Marshal(sp)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		if err := putSpec(tx, sp.ServerId, raw); err != nil {
			return err
		}
		if platform == "" {
			return nil
		}
		b, err := tx.CreateBucketIfNotExists(bPackCleanup)
		if err != nil {
			return err
		}
		set, err := decodePlatforms(b.Get([]byte(sp.ServerId)))
		if err != nil {
			return err
		}
		if slices.Contains(set, platform) {
			return nil
		}
		set = append(set, platform)
		slices.Sort(set)
		out, err := json.Marshal(set)
		if err != nil {
			return err
		}
		return b.Put([]byte(sp.ServerId), out)
	})
}

// PackCleanups returns id's pending pack cleanups (sorted; empty if none).
func (s *Store) PackCleanups(id string) ([]string, error) {
	var out []string
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bPackCleanup)
		if b == nil {
			return nil
		}
		var err error
		out, err = decodePlatforms(b.Get([]byte(id)))
		return err
	})
	return out, err
}

// ClearPackCleanup removes id's pending pack cleanups (idempotent).
func (s *Store) ClearPackCleanup(id string) error {
	return s.db.Update(func(tx *bbolt.Tx) error { return deletePackCleanup(tx, id) })
}

func deletePackCleanup(tx *bbolt.Tx, id string) error {
	if b := tx.Bucket(bPackCleanup); b != nil {
		return b.Delete([]byte(id))
	}
	return nil
}

func decodePlatforms(raw []byte) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	var set []string
	if err := json.Unmarshal(raw, &set); err != nil {
		return nil, err
	}
	return set, nil
}
