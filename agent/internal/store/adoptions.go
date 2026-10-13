package store

import (
	"encoding/json"
	"errors"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// bAdoptions stores the adoptions (plan-6, spec §6.7): imported server → original container that
// the agent keeps without recreating until the first spec change. It survives DeleteSpec and
// ForgetWithTombstone on purpose: the pending deletion of an imported server needs to know which container
// to stop. Whoever deletes or replaces that container removes it (DeleteAdoption). The bucket is created on
// first use (it does not touch Open's bucket list).
var bAdoptions = []byte("adoptions")

// Adoption is an adopted container: its id, the server's slug (network alias and synthesized
// labels) and the spec version it was adopted with (a higher one recreates it).
type Adoption struct {
	ContainerID string `json:"containerId"`
	Slug        string `json:"slug"`
	Version     uint64 `json:"version"`
}

func putAdoption(tx *bbolt.Tx, serverID string, a Adoption) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	b, err := tx.CreateBucketIfNotExists(bAdoptions)
	if err != nil {
		return err
	}
	return b.Put([]byte(serverID), raw)
}

// PutAdoption stores (or replaces) serverID's adoption and, if externalPath is not "", the verified
// external folder (see PutExternalPath), in one transaction.
func (s *Store) PutAdoption(serverID string, a Adoption, externalPath string) error {
	if serverID == "" || a.ContainerID == "" {
		return errors.New("store: adoption without server or container")
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		if err := putAdoption(tx, serverID, a); err != nil {
			return err
		}
		return putExternalPath(tx, serverID, externalPath)
	})
}

// AdoptWithSpec stores the adoption, the verified external folder (if externalPath is not "") and the spec
// (clearing its tombstone, like PutSpec) in one transaction: an adoption never exists without the spec that
// requested it. If a newer spec is already stored (a SyncSpecs with v2 from "Adopt and apply" got
// ahead of a late ImportAdopt v1), that one is kept: the v1 adoption will cause it to be recreated.
func (s *Store) AdoptWithSpec(sp *mcsmv1.ServerSpec, a Adoption, externalPath string) error {
	if sp.GetServerId() == "" || a.ContainerID == "" {
		return errors.New("store: adoption without server or container")
	}
	raw, err := proto.Marshal(sp)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		newer := false
		if cur := tx.Bucket(bSpecs).Get([]byte(sp.ServerId)); cur != nil {
			stored := &mcsmv1.ServerSpec{}
			if err := proto.Unmarshal(cur, stored); err != nil {
				return err
			}
			newer = stored.Version > sp.Version
		}
		if !newer {
			if err := tx.Bucket(bSpecs).Put([]byte(sp.ServerId), raw); err != nil {
				return err
			}
			if err := deleteTombstone(tx, sp.ServerId); err != nil {
				return err
			}
		}
		if err := putAdoption(tx, sp.ServerId, a); err != nil {
			return err
		}
		return putExternalPath(tx, sp.ServerId, externalPath)
	})
}

// Adoption returns serverID's adoption, or nil if there is none.
func (s *Store) Adoption(serverID string) (*Adoption, error) {
	var out *Adoption
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bAdoptions)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte(serverID))
		if raw == nil {
			return nil
		}
		var a Adoption
		if err := json.Unmarshal(raw, &a); err != nil {
			return err
		}
		out = &a
		return nil
	})
	return out, err
}

// Adoptions returns all the adoptions by server_id.
func (s *Store) Adoptions() (map[string]Adoption, error) {
	out := map[string]Adoption{}
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bAdoptions)
		if b == nil {
			return nil
		}
		return b.ForEach(func(k, v []byte) error {
			var a Adoption
			if err := json.Unmarshal(v, &a); err != nil {
				return err
			}
			out[string(k)] = a
			return nil
		})
	})
	return out, err
}

// AdoptedBy returns the server that adopted containerID, or "" if none.
func (s *Store) AdoptedBy(containerID string) (string, error) {
	all, err := s.Adoptions()
	if err != nil {
		return "", err
	}
	for id, a := range all {
		if a.ContainerID == containerID {
			return id, nil
		}
	}
	return "", nil
}

// DeleteAdoption removes serverID's adoption (idempotent).
func (s *Store) DeleteAdoption(serverID string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		if b := tx.Bucket(bAdoptions); b != nil {
			return b.Delete([]byte(serverID))
		}
		return nil
	})
}
