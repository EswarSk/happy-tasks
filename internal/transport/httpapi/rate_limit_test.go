package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimiterRefillsAndSeparatesBudgets(t *testing.T) {
	limiter := &rateLimiter{
		buckets: make(map[string]rateBucket),
		limits:  map[string]ratePolicy{"read": {capacity: 2, perSecond: 1}},
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
	request.Header.Set("X-Actor-ID", "actor")
	if got := rateLimitKey(request); got != "actor" || rateLimitCategory(request) != "read" {
		t.Fatalf("unexpected rate-limit key/category: %q/%q", got, rateLimitCategory(request))
	}
}
