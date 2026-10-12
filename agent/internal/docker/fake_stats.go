package docker

import "context"

// Stats devuelve la lectura fijada con SetStats (cero si no se fijó ninguna).
// Como Inspect, no se anota en Calls.
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

// SetStats fija la próxima lectura de Stats para un contenedor.
func (f *Fake) SetStats(id string, s Stats) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stats == nil {
		f.stats = map[string]Stats{}
	}
	f.stats[id] = s
}
