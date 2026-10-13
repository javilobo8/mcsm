package docker

import "context"

// Stats returns the reading set with SetStats (zero if none was set).
// Like Inspect, it is not recorded in Calls.
func (f *Fake) Stats(_ context.Context, id string) (Stats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.Containers[id]; !ok {
		return Stats{}, ErrNotFound
	}
	if f.StatsErr != nil {
		return Stats{}, f.StatsErr
	}
	return f.stats[id], nil
}

// SetStats sets the next Stats reading for a container.
func (f *Fake) SetStats(id string, s Stats) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stats == nil {
		f.stats = map[string]Stats{}
	}
	f.stats[id] = s
}
