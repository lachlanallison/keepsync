package api

import (
	"sync"
	"time"
)

// rateLimiter is a small fixed-window counter keyed by an arbitrary string
// (device ID or remote address). It's intentionally lightweight because the
// expected load is small and reverse proxies handle the broader DoS defence.
type rateLimiter struct {
	mu        sync.Mutex
	limit     int
	window    time.Duration
	state     map[string]*limiterBucket
	lastSweep time.Time
}

type limiterBucket struct {
	count     int
	resetAt   time.Time
}

func newRateLimiter(limitPerWindow int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		limit:     limitPerWindow,
		window:    window,
		state:     make(map[string]*limiterBucket),
		lastSweep: time.Now(),
	}
}

// allow returns (true, 0) when the request is permitted, or (false, retryAfter)
// when the caller has exceeded its quota. retryAfter is the duration until the
// current window resets.
func (rl *rateLimiter) allow(key string) (bool, time.Duration) {
	if rl == nil || rl.limit <= 0 {
		return true, 0
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	rl.maybeSweep(now)

	bucket, ok := rl.state[key]
	if !ok || now.After(bucket.resetAt) {
		rl.state[key] = &limiterBucket{count: 1, resetAt: now.Add(rl.window)}
		return true, 0
	}

	if bucket.count >= rl.limit {
		return false, bucket.resetAt.Sub(now)
	}

	bucket.count++
	return true, 0
}

// maybeSweep lazily evicts expired buckets so the map doesn't grow unbounded
// as devices come and go. We only do this at most every `window`.
func (rl *rateLimiter) maybeSweep(now time.Time) {
	if now.Sub(rl.lastSweep) < rl.window {
		return
	}
	rl.lastSweep = now
	for k, bucket := range rl.state {
		if now.After(bucket.resetAt) {
			delete(rl.state, k)
		}
	}
}
