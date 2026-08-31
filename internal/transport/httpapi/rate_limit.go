package httpapi

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type rateBucket struct {
	tokens  float64
	updated time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]rateBucket
	limits  map[string]ratePolicy
	pruned  time.Time
}

type ratePolicy struct {
	capacity  float64
	perSecond float64
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{
		buckets: make(map[string]rateBucket),
		limits: map[string]ratePolicy{
			"read":     {capacity: 300, perSecond: 100},
			"mutation": {capacity: 30, perSecond: 2},
			"comment":  {capacity: 20, perSecond: 1},
			// The frontend's SSE client backs off up to 10s between reconnect
			// attempts (features/realtime/use-project-events.ts); refill must
			// stay faster than that floor or a client that's actually behaving
			// correctly can never catch back up once the bucket empties. This
			// also has to absorb every open tab/project reconnecting at once
			// after a real disruption (e.g. an API restart), since the bucket
			// is shared per source IP, not per connection.
			"sse": {capacity: 20, perSecond: 1},
		},
	}
}

func (l *rateLimiter) allow(key, category string, now time.Time) bool {
	policy := l.limits[category]
	l.mu.Lock()
	defer l.mu.Unlock()
	bucketKey := key + ":" + category
	entry, exists := l.buckets[bucketKey]
	if !exists {
		entry = rateBucket{tokens: policy.capacity, updated: now}
	}
	entry.tokens = minFloat(policy.capacity, entry.tokens+now.Sub(entry.updated).Seconds()*policy.perSecond)
	entry.updated = now
	if entry.tokens < 1 {
		l.buckets[bucketKey] = entry
		return false
	}
	entry.tokens--
	l.buckets[bucketKey] = entry
	if len(l.buckets) > 4096 && now.Sub(l.pruned) > time.Minute {
		for staleKey, staleBucket := range l.buckets {
			if now.Sub(staleBucket.updated) > 10*time.Minute {
				delete(l.buckets, staleKey)
			}
		}
		l.pruned = now
	}
	return true
}

func minFloat(left, right float64) float64 {
	if left < right {
		return left
	}
	return right
}

func rateLimitCategory(r *http.Request) string {
	if strings.HasSuffix(r.URL.Path, "/events") {
		return "sse"
	}
	if strings.Contains(r.URL.Path, "/comments") && r.Method != http.MethodGet {
		return "comment"
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		return "mutation"
	}
	return "read"
}

func rateLimitKey(r *http.Request) string {
	if actor := strings.TrimSpace(r.Header.Get("X-Actor-ID")); actor != "" {
		return actor
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
