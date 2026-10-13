package app

import "sync"

// fileWrites counts, per server, the file mutations (Files* that write) in progress.
// It closes the race between a mutation that started before a restore's reservation and the
// swap of data: an upload that already had the old data's os.Root open would end up, after
// the restore's rename, in the pre-restore (or a recursive deletion would keep emptying the
// pre-restore, which is the safety net), and the panel would consider it done.
//
// Protocol (no races thanks to the lock order):
//   - the mutation does enter BEFORE looking at rec.Held and, if reserved, answers busy;
//   - the restore does rec.Hold BEFORE looking at drained and waits for it to close.
//
// Either the mutation sees the reservation, or the restore sees it in the counter and waits for it. The zero
// value is usable.
type fileWrites struct {
	mu   sync.Mutex
	n    map[string]int
	idle map[string]chan struct{} // closed when n[id] returns to 0
}

// enter registers a mutation in progress on serverID; leave (idempotent) marks it as finished.
func (w *fileWrites) enter(serverID string) (leave func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.n == nil {
		w.n = map[string]int{}
		w.idle = map[string]chan struct{}{}
	}
	if w.n[serverID] == 0 {
		w.idle[serverID] = make(chan struct{})
	}
	w.n[serverID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.n[serverID]--
			if w.n[serverID] == 0 {
				close(w.idle[serverID])
				delete(w.n, serverID)
				delete(w.idle, serverID)
			}
		})
	}
}

// drained returns a channel that closes when no mutation is left in progress on
// serverID (already closed if there is none).
func (w *fileWrites) drained(serverID string) <-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	if ch, ok := w.idle[serverID]; ok {
		return ch
	}
	ch := make(chan struct{})
	close(ch)
	return ch
}

// count is the number of mutations in progress on serverID.
func (w *fileWrites) count(serverID string) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.n[serverID]
}
