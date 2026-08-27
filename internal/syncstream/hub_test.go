package syncstream

import "testing"

func TestHubCoalescesWakeups(t *testing.T) {
	hub := NewHub()
	ch, unsubscribe := hub.Subscribe("project-1")
	defer unsubscribe()
	hub.Publish("project-1")
	hub.Publish("project-1")
	select {
	case <-ch:
	default:
		t.Fatal("expected wakeup")
	}
	select {
	case <-ch:
		t.Fatal("wakeups should coalesce")
	default:
	}
}
