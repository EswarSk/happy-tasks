package httpapi

import "testing"

func TestDescriptionHubCapsEditorsAndKeepsObservers(t *testing.T) {
	hub := newDescriptionHub()
	for index := 0; index < maxDescriptionEditors; index++ {
		client := &descriptionClient{}
		if !hub.join("room", client) || !client.editor {
			t.Fatalf("client %d should be an editor", index)
		}
	}
	observer := &descriptionClient{}
	if hub.join("room", observer) || observer.editor {
		t.Fatal("client over the editor cap should be a read-only observer")
	}
	viewer := &descriptionClient{}
	if hub.join("another-room", viewer, false) || viewer.editor {
		t.Fatal("viewer role must never receive an editor slot")
	}
}
