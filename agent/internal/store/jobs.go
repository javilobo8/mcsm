package store

import (
	"errors"
	"time"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// bJobs guarda los jobs largos (backup, restore) por job_id: así el agente responde a un
// job_id repetido con su resultado (spec §5.4) e informa al panel tras reconectar. El bucket
// se crea al primer uso para no tocar la lista de buckets de Open.
var bJobs = []byte("jobs")

// PutJob guarda (o reemplaza) el registro de un job.
func (s *Store) PutJob(j *mcsmv1.JobRecord) error {
	if j.GetJobId() == "" {
		return errors.New("store: job sin id")
	}
	raw, err := proto.Marshal(j)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists(bJobs)
		if err != nil {
			return err
		}
		return b.Put([]byte(j.JobId), raw)
	})
}

// GetJob devuelve el job o nil si no existe.
func (s *Store) GetJob(id string) (*mcsmv1.JobRecord, error) {
	var out *mcsmv1.JobRecord
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bJobs)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte(id))
		if raw == nil {
			return nil
		}
		j := &mcsmv1.JobRecord{}
		if err := proto.Unmarshal(raw, j); err != nil {
			return err
		}
		out = j
		return nil
	})
	return out, err
}

// ListJobs devuelve todos los jobs guardados.
func (s *Store) ListJobs() ([]*mcsmv1.JobRecord, error) {
	var out []*mcsmv1.JobRecord
	err := s.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bJobs)
		if b == nil {
			return nil
		}
		return b.ForEach(func(_, raw []byte) error {
			j := &mcsmv1.JobRecord{}
			if err := proto.Unmarshal(raw, j); err != nil {
				return err
			}
			out = append(out, j)
			return nil
		})
	})
	return out, err
}

// PruneJobs borra los jobs terminados antes de before (los RUNNING nunca). Devuelve cuántos.
func (s *Store) PruneJobs(before time.Time) (int, error) {
	n := 0
	err := s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bJobs)
		if b == nil {
			return nil
		}
		var del [][]byte
		err := b.ForEach(func(k, raw []byte) error {
			j := &mcsmv1.JobRecord{}
			if err := proto.Unmarshal(raw, j); err != nil {
				return err
			}
			end := j.FinishedUnixMs
			if end == 0 {
				end = j.StartedUnixMs // terminado sin hora de fin: se poda por la de inicio
			}
			if j.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING && end > 0 && end < before.UnixMilli() {
				del = append(del, append([]byte(nil), k...)) // k solo vale dentro de la transacción
			}
			return nil
		})
		if err != nil {
			return err
		}
		for _, k := range del {
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		n = len(del)
		return nil
	})
	return n, err
}
