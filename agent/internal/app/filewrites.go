package app

import "sync"

// fileWrites cuenta, por servidor, las mutaciones de archivos (Files* que escriben) en curso.
// Cierra la carrera entre una mutación que empezó antes de la reserva de una restauración y el
// intercambio de data: una subida que ya tenía abierto el os.Root del data viejo acabaría, tras
// el rename de la restauración, en el pre-restore (o un borrado recursivo seguiría vaciando el
// pre-restore, que es la red de seguridad), y el panel la daría por buena.
//
// Protocolo (sin carreras por el orden de los locks):
//   - la mutación hace enter ANTES de mirar rec.Held y, si está reservado, responde busy;
//   - la restauración hace rec.Hold ANTES de mirar drained y espera a que se cierre.
//
// O la mutación ve la reserva, o la restauración la ve en el contador y la espera. El valor
// cero es utilizable.
type fileWrites struct {
	mu   sync.Mutex
	n    map[string]int
	idle map[string]chan struct{} // se cierra cuando n[id] vuelve a 0
}

// enter registra una mutación en curso en serverID; leave (idempotente) la da por terminada.
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

// drained devuelve un canal que se cierra cuando no queda ninguna mutación en curso en
// serverID (ya cerrado si no hay ninguna).
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

// count es el número de mutaciones en curso en serverID.
func (w *fileWrites) count(serverID string) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.n[serverID]
}
