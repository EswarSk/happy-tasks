package syncstream

import "sync"

// Hub carries coalescible wake-up hints, never authoritative events. A slow
// subscriber can miss hints safely because handlers always resume from durable
// project sequence numbers in PostgreSQL.
type Hub struct {
	mu          sync.RWMutex
	subscribers map[string]map[chan struct{}]struct{}
}

func NewHub() *Hub {
	return &Hub{subscribers: make(map[string]map[chan struct{}]struct{})}
}

func (h *Hub) Subscribe(projectID string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	if h.subscribers[projectID] == nil {
		h.subscribers[projectID] = make(map[chan struct{}]struct{})
	}
	h.subscribers[projectID][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subscribers[projectID], ch)
		if len(h.subscribers[projectID]) == 0 {
			delete(h.subscribers, projectID)
		}
		h.mu.Unlock()
	}
}

func (h *Hub) Publish(projectID string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for subscriber := range h.subscribers[projectID] {
		select {
		case subscriber <- struct{}{}:
		default:
		}
	}
}
