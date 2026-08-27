package app

import (
	"testing"
	"time"
)

func TestTaskCursorRoundTrip(t *testing.T) {
	wantTime := time.Date(2026, 8, 26, 12, 30, 0, 123, time.UTC)
	wantID := "00000000-0000-7000-8000-000000000001"
	got, err := DecodeTaskCursor(EncodeTaskCursor(wantTime, wantID))
	if err != nil {
		t.Fatal(err)
	}
	if !got.UpdatedAt.Equal(wantTime) || got.ID != wantID {
		t.Fatalf("unexpected cursor: %#v", got)
	}
}

func TestInvalidCursor(t *testing.T) {
	if _, err := DecodeTaskCursor("not-base64!"); err == nil {
		t.Fatal("expected invalid cursor error")
	}
}
