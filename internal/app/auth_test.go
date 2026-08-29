package app

import "testing"

func TestSessionTokenIsRandomAndHashed(t *testing.T) {
	first, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || len(hashSessionToken(first)) != 32 {
		t.Fatal("session tokens must be random and stored as SHA-256 digests")
	}
	if normalized, err := normalizeEmail(" Maya@Example.Test "); err != nil || normalized != "maya@example.test" {
		t.Fatalf("email normalization failed: %q, %v", normalized, err)
	}
}
