package syncstream

import (
	"testing"

	"github.com/eswaravegi/happy-task-management/internal/domain"
)

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

func TestHubDeliversCommittedEvent(t *testing.T) {
	hub := NewHub()
	ch, unsubscribe := hub.Subscribe("project-1")
	defer unsubscribe()
	hub.PublishEvent(domain.Event{ProjectID: "project-1", Sequence: 7})
	notice := <-ch
	if notice.Event == nil || notice.Event.Sequence != 7 {
		t.Fatalf("notice = %#v, want sequence 7", notice)
	}
}
