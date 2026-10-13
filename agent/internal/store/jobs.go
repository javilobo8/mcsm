package store

import (
	"errors"
	"time"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

// bJobs stores the long jobs (backup, restore) by job_id: this way the agent answers a repeated
// job_id with its result (spec §5.4) and informs the panel after reconnecting. The bucket
// is created on first use so as not to touch Open's bucket list.
var bJobs = []byte("jobs")

// PutJob stores (or replaces) a job's record.
func (s *Store) PutJob(j *mcsmv1.JobRecord) error {
	if j.GetJobId() == "" {
		return errors.New("store: job without id")
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

// GetJob returns the job or nil if it does not exist.
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

// ListJobs returns all the stored jobs.
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

// PruneJobs deletes the jobs finished before before (RUNNING ones never). It returns how many.
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
				end = j.StartedUnixMs // finished without an end time: pruned by its start time
			}
			if j.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING && end > 0 && end < before.UnixMilli() {
				del = append(del, append([]byte(nil), k...)) // k is only valid inside the transaction
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
