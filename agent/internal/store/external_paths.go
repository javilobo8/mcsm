package store

import (
	"errors"

	"go.etcd.io/bbolt"
)

// bExternalPaths guarda, por servidor, la carpeta de datos fuera de DATA_ROOT (dataPath) que el agente
// verificó al adoptar su contenedor: era el bind real de /data de un contenedor itzg (plan-6, H1). El
// reconciliador solo monta un dataPath si coincide con el registrado para ese id, así que un panel
// comprometido no puede montar /root ni ninguna otra carpeta del host en un contenedor. El registro
// nunca se borra: solo identifica la carpeta verificada para ese id (los ids no se reutilizan) y, si
// el panel vuelve a enviar el servidor (copia de su BD restaurada), lo vuelve a poder crear. El bucket
// se crea al primer uso (no toca la lista de buckets de Open).
var bExternalPaths = []byte("external_paths")

// putExternalPath registra path para serverID dentro de una transacción de escritura ("" = nada).
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

// PutExternalPath registra la carpeta externa verificada de serverID.
func (s *Store) PutExternalPath(serverID, path string) error {
	if serverID == "" || path == "" {
		return errors.New("store: carpeta externa sin servidor o sin ruta")
	}
	return s.db.Update(func(tx *bbolt.Tx) error { return putExternalPath(tx, serverID, path) })
}

// ExternalPath devuelve la carpeta externa verificada de serverID, o "" si no hay.
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
