package store

import (
	"encoding/json"
	"errors"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// bAdoptions guarda las adopciones (plan-6, spec §6.7): servidor importado → contenedor original que
// el agente sigue sin recrear hasta el primer cambio de spec. Sobrevive a DeleteSpec y a
// ForgetWithTombstone a propósito: el borrado pendiente de un importado necesita saber qué contenedor
// parar. La quita quien borra o sustituye ese contenedor (DeleteAdoption). El bucket se crea al
// primer uso (no toca la lista de buckets de Open).
var bAdoptions = []byte("adoptions")

// Adoption es un contenedor adoptado: su id, el slug del servidor (alias de red y etiquetas
// sintetizadas) y la versión de la spec con la que se adoptó (una mayor lo recrea).
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

// PutAdoption guarda (o sustituye) la adopción de serverID y, si externalPath no es "", la carpeta
// externa verificada (ver PutExternalPath), en una transacción.
func (s *Store) PutAdoption(serverID string, a Adoption, externalPath string) error {
	if serverID == "" || a.ContainerID == "" {
		return errors.New("store: adopción sin servidor o sin contenedor")
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		if err := putAdoption(tx, serverID, a); err != nil {
			return err
		}
		return putExternalPath(tx, serverID, externalPath)
	})
}

// AdoptWithSpec guarda la adopción, la carpeta externa verificada (si externalPath no es "") y la spec
// (anulando su lápida, como PutSpec) en una transacción: nunca queda una adopción sin la spec que la
// pidió. Si ya hay guardada una spec más nueva (un SyncSpecs con la v2 de «Adoptar y aplicar» se
// adelantó a un ImportAdopt v1 tardío), se conserva esa: la adopción v1 hará que se recree.
func (s *Store) AdoptWithSpec(sp *mcsmv1.ServerSpec, a Adoption, externalPath string) error {
	if sp.GetServerId() == "" || a.ContainerID == "" {
		return errors.New("store: adopción sin servidor o sin contenedor")
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

// Adoption devuelve la adopción de serverID, o nil si no hay.
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

// Adoptions devuelve todas las adopciones por server_id.
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

// AdoptedBy devuelve el servidor que adoptó containerID, o "" si ninguno.
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

// DeleteAdoption quita la adopción de serverID (idempotente).
func (s *Store) DeleteAdoption(serverID string) error {
	return s.db.Update(func(tx *bbolt.Tx) error {
		if b := tx.Bucket(bAdoptions); b != nil {
			return b.Delete([]byte(serverID))
		}
		return nil
	})
}
