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
	limits  map[string]RatePolicy
	pruned  time.Time
}

// RatePolicy is a token bucket's capacity and refill rate for one rate-limit
// category ("read", "mutation", "comment", "sse"). Exported so deployments
// can override the defaults (see cmd/api/main.go's RATE_LIMIT_* env vars)
// without a code change and rebuild — these are operational tuning knobs,
// not values that should require a redeploy to correct.
type RatePolicy struct {
	Capacity  float64
	PerSecond float64
}

// defaultRatePolicies are sane starting points for local/single-instance use.
// The sse category's refill must stay faster than the frontend SSE client's
// backoff ceiling (10s — features/realtime/use-project-events.ts) or a
// correctly-behaving client can never catch back up once its bucket empties,
// and must absorb every open tab/project reconnecting at once after a real
// disruption (e.g. an API restart), since the bucket is shared per client
// identity, not per connection.
func defaultRatePolicies() map[string]RatePolicy {
	return map[string]RatePolicy{
		"read":     {Capacity: 300, PerSecond: 100},
		"mutation": {Capacity: 30, PerSecond: 2},
		"comment":  {Capacity: 20, PerSecond: 1},
		"sse":      {Capacity: 20, PerSecond: 1},
	}
}

// newRateLimiter starts from defaultRatePolicies and applies overrides on
// top, category by category — a nil or partial overrides map is fine.
func newRateLimiter(overrides map[string]RatePolicy) *rateLimiter {
	limits := defaultRatePolicies()
	for category, policy := range overrides {
		limits[category] = policy
	}
	return &rateLimiter{buckets: make(map[string]rateBucket), limits: limits}
}

func (l *rateLimiter) allow(key, category string, now time.Time) bool {
	policy := l.limits[category]
	l.mu.Lock()
	defer l.mu.Unlock()
	bucketKey := key + ":" + category
	entry, exists := l.buckets[bucketKey]
	if !exists {
		entry = rateBucket{tokens: policy.Capacity, updated: now}
	}
	entry.tokens = minFloat(policy.Capacity, entry.tokens+now.Sub(entry.updated).Seconds()*policy.PerSecond)
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

// rateLimitKey identifies who is making the request, for the sole purpose of
// counting their recent requests. allowActorOverride must be the same flag
// the authenticate middleware uses to gate X-Actor-ID (h.allowActorOverride,
// dev/test only) — rate limiting runs before authentication, so without this
// gate any client could send a fresh random X-Actor-ID on every request and
// defeat rate limiting entirely, in any environment, since the header is
// already allowed through CORS for the legitimate dev use case.
func rateLimitKey(r *http.Request, allowActorOverride bool) string {
	if allowActorOverride {
		if actor := strings.TrimSpace(r.Header.Get("X-Actor-ID")); validUUID(actor) {
			return actor
		}
	}
	return clientIP(r)
}

// clientIP finds the request's real origin address for rate-limit identity.
// Behind a reverse proxy (Cloud Run, or any single-hop deployment) the
// client never has a direct TCP connection to this process, so RemoteAddr is
// the proxy's own address — the same for every visitor. The proxy instead
// records what it observed in X-Forwarded-For, appending its own view after
// anything already in the header (which a client can freely fake). With
// exactly one trusted hop in front of this service, the right-most entry
// that isn't a private/loopback/link-local address is the one only that
// trusted hop could have written; anything to its left may be
// attacker-supplied and must never be trusted for rate-limit identity. This
// is intentionally provider-agnostic rather than relying on Cloud
// Run-specific behavior that isn't documented in a verifiable way.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := strings.TrimSpace(parts[i])
			ip := net.ParseIP(candidate)
			if ip == nil || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			return candidate
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
