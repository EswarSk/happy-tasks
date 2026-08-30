package syncstream

import (
	"sync"

	"github.com/eswaravegi/happy-task-management/internal/domain"
)

// Hub carries coalescible wake-up hints, never authoritative events. A slow
// subscriber can miss hints safely because handlers always resume from durable
// project sequence numbers in PostgreSQL.
type Hub struct {
	mu          sync.RWMutex
	subscribers map[string]map[chan Notice]struct{}
}

type Notice struct {
	Event *domain.Event
}

func NewHub() *Hub {
	return &Hub{subscribers: make(map[string]map[chan Notice]struct{})}
}

func (h *Hub) Subscribe(projectID string) (<-chan Notice, func()) {
	ch := make(chan Notice, 256)
	h.mu.Lock()
	if h.subscribers[projectID] == nil {
		h.subscribers[projectID] = make(map[chan Notice]struct{})
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
		if len(subscriber) > 0 {
			continue
		}
		select {
		case subscriber <- Notice{}:
		default:
		}
	}
}

// PublishEvent is the cross-instance fast path. A dropped notice is safe: SSE
// clients retain their cursor and the periodic durable replay fills any gap.
func (h *Hub) PublishEvent(event domain.Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for subscriber := range h.subscribers[event.ProjectID] {
		copy := event
		select {
		case subscriber <- Notice{Event: &copy}:
		default:
		}
	}
}
