package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimiterRefillsAndSeparatesBudgets(t *testing.T) {
	limiter := &rateLimiter{
		buckets: make(map[string]rateBucket),
		limits:  map[string]RatePolicy{"read": {Capacity: 2, PerSecond: 1}},
	}
	now := time.Unix(100, 0)
	if !limiter.allow("actor", "read", now) || !limiter.allow("actor", "read", now) {
		t.Fatal("expected initial burst")
	}
	if limiter.allow("actor", "read", now) {
		t.Fatal("expected exhausted bucket")
	}
	if !limiter.allow("actor", "read", now.Add(time.Second)) {
		t.Fatal("expected refill")
	}
	request := httptest.NewRequest("GET", "/v1/projects/1/tasks", nil)
	request.RemoteAddr = "203.0.113.9:5555"
	request.Header.Set("X-Actor-ID", "00000000-0000-7000-8000-000000000001")
	if got := rateLimitKey(request, true); got != "00000000-0000-7000-8000-000000000001" || rateLimitCategory(request) != "read" {
		t.Fatalf("unexpected rate-limit key/category: %q/%q", got, rateLimitCategory(request))
	}
}

func TestRateLimitKeyIgnoresActorOverrideUnlessAllowed(t *testing.T) {
	request := httptest.NewRequest("GET", "/v1/projects/1/tasks", nil)
	request.RemoteAddr = "203.0.113.9:5555"
	request.Header.Set("X-Actor-ID", "00000000-0000-7000-8000-000000000001")
	// A client can always set X-Actor-ID (it's allowed through CORS for the
	// legitimate dev override); without allowActorOverride it must never
	// let them pick their own rate-limit identity.
	if got := rateLimitKey(request, false); got != "203.0.113.9" {
		t.Fatalf("expected the actor override to be ignored, got key %q", got)
	}
}

func TestRateLimitKeyRejectsInvalidActorOverride(t *testing.T) {
	request := httptest.NewRequest("GET", "/v1/projects/1/tasks", nil)
	request.RemoteAddr = "203.0.113.9:5555"
	request.Header.Set("X-Actor-ID", "not-a-uuid")
	if got := rateLimitKey(request, true); got != "203.0.113.9" {
		t.Fatalf("expected a non-UUID actor override to fall back to client IP, got %q", got)
	}
}

func TestClientIPPrefersRightmostPublicForwardedForEntry(t *testing.T) {
	cases := []struct {
		name       string
		forwarded  string
		remoteAddr string
		want       string
	}{
		{
			name:       "single hop from the trusted proxy",
			forwarded:  "198.51.100.7",
			remoteAddr: "10.0.0.5:443",
			want:       "198.51.100.7",
		},
		{
			name:       "client-supplied prefix is ignored in favor of the trusted proxy's own append",
			forwarded:  "6.6.6.6, 198.51.100.7",
			remoteAddr: "10.0.0.5:443",
			want:       "198.51.100.7",
		},
		{
			name:       "trailing private hop is skipped for the real public client",
			forwarded:  "198.51.100.7, 10.0.0.9",
			remoteAddr: "10.0.0.5:443",
			want:       "198.51.100.7",
		},
		{
			name:       "no header falls back to RemoteAddr",
			forwarded:  "",
			remoteAddr: "203.0.113.9:5555",
			want:       "203.0.113.9",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "/v1/projects/1/tasks", nil)
			request.RemoteAddr = testCase.remoteAddr
			if testCase.forwarded != "" {
				request.Header.Set("X-Forwarded-For", testCase.forwarded)
			}
			if got := clientIP(request); got != testCase.want {
				t.Fatalf("clientIP() = %q, want %q", got, testCase.want)
			}
		})
	}
}
