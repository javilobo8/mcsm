package store

import (
	"errors"

	"go.etcd.io/bbolt"
)

// bExternalPaths stores, per server, the data folder outside DATA_ROOT (dataPath) that the agent
// verified when adopting its container: it was the real /data bind of an itzg container (plan-6, H1). The
// reconciler only mounts a dataPath if it matches the one registered for that id, so a
// compromised panel cannot mount /root or any other host folder into a container. The record
// is never deleted: it only identifies the folder verified for that id (ids are not reused) and, if
// the panel sends the server again (a restored copy of its DB), it makes it possible to create it again. The bucket
// is created on first use (it does not touch Open's bucket list).
var bExternalPaths = []byte("external_paths")

// putExternalPath registers path for serverID inside a write transaction ("" = nothing).
func putExternalPath(tx *bbolt.Tx, serverID, path string) error {
	if path == "" {
		return nil
	}
	b, err := tx.CreateBucketIfNotExists(bExternalPaths)
	if err != nil {
		return err
	}
	return b.Put([]byte(serverID), []byte(path))
}

// PutExternalPath registers serverID's verified external folder.
func (s *Store) PutExternalPath(serverID, path string) error {
	if serverID == "" || path == "" {
		return errors.New("store: external folder without server or path")
	}
	return s.db.Update(func(tx *bbolt.Tx) error { return putExternalPath(tx, serverID, path) })
}

// ExternalPath returns serverID's verified external folder, or "" if there is none.
func (s *Store) ExternalPath(serverID string) (string, error) {
	var out string
	err := s.db.View(func(tx *bbolt.Tx) error {
		if b := tx.Bucket(bExternalPaths); b != nil {
			out = string(b.Get([]byte(serverID)))
		}
		return nil
	})
	return out, err
}
