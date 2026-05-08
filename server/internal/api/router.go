package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/rs/cors"

	"keepsync-server/internal/auth"
	"keepsync-server/internal/config"
	"keepsync-server/internal/mailer"
	"keepsync-server/internal/storage"
)

// Router represents the API router
type Router struct {
	*mux.Router
	db          *storage.DB
	config      *config.Config
	authService *auth.Service
	mailer      *mailer.Mailer
	rateLimiter *rateLimiter
}

var (
	metricsMu           sync.Mutex
	requestCount        int64
	errorCount          int64
	requestDurationSum  int64
)

// NewRouter creates a new API router
func NewRouter(db *storage.DB, cfg *config.Config) http.Handler {
	r := &Router{
		Router:      mux.NewRouter(),
		db:          db,
		config:      cfg,
		authService: auth.NewService(db, cfg),
		mailer:      mailer.New(cfg),
		rateLimiter: newRateLimiter(cfg.RateLimitPerMinute, time.Minute),
	}

	r.setupRoutes()
	// Middleware order runs from outermost (first) to innermost (last). We
	// want request logging + security headers + body size limits wrapped
	// around everything before handler-specific middleware.
	r.Use(r.requestLogger)
	r.Use(r.securityHeaders)
	r.Use(r.bodySizeLimit)

	allowedOrigins := cfg.AllowedOrigins
	// AllowCredentials must be false when using the "*" wildcard or the
	// browser rejects the preflight. Honour the common case gracefully.
	allowCreds := true
	for _, o := range allowedOrigins {
		if o == "*" {
			allowCreds = false
			break
		}
	}

	c := cors.New(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Browser", "X-Device-Name"},
		ExposedHeaders:   []string{"Retry-After"},
		AllowCredentials: allowCreds,
	})

	return c.Handler(r)
}

func (r *Router) setupRoutes() {
	// Health check
	r.HandleFunc("/healthz", r.healthCheck).Methods("GET")
	r.HandleFunc("/metrics", r.metrics).Methods("GET")

	// Authentication routes
	auth := r.PathPrefix("/auth").Subrouter()
	auth.HandleFunc("/magic-link", r.createMagicLink).Methods("POST")
	auth.HandleFunc("/activate", r.activateDevice).Methods("POST")
	auth.HandleFunc("/pairing", r.createPairingCode).Methods("POST")
	// Invite tokens are the SMTP-free bootstrap path.  Minted by the
	// `keepsync-server invite` CLI and redeemed here.
	auth.HandleFunc("/invite", r.activateInvite).Methods("POST")

	// /devices/register is intentionally NOT under the auth-required subrouter:
	// the pairing flow registers a *new* device, so there is no token yet.
	r.HandleFunc("/devices/register", r.registerDevice).Methods("POST")

	// Device routes (require authentication)
	devices := r.PathPrefix("/devices").Subrouter()
	devices.Use(r.authMiddleware)
	devices.Use(r.rateLimitMiddleware)
	devices.HandleFunc("", r.listDevices).Methods("GET")
	devices.HandleFunc("/{id}", r.updateDevice).Methods("PUT")
	devices.HandleFunc("/{id}", r.revokeDevice).Methods("DELETE")

	// Tab sync routes (require authentication)
	tabs := r.PathPrefix("/tabs").Subrouter()
	tabs.Use(r.authMiddleware)
	tabs.Use(r.rateLimitMiddleware)
	tabs.HandleFunc("/snapshot", r.uploadSnapshot).Methods("POST")
	tabs.HandleFunc("/events", r.uploadEvents).Methods("POST")
	tabs.HandleFunc("/current", r.getCurrentTabs).Methods("GET")

	// Bookmarks (full-tree sync, require authentication)
	bookmarks := r.PathPrefix("/bookmarks").Subrouter()
	bookmarks.Use(r.authMiddleware)
	bookmarks.Use(r.rateLimitMiddleware)
	bookmarks.HandleFunc("", r.getBookmarks).Methods("GET")
	bookmarks.HandleFunc("", r.putBookmarks).Methods("PUT")

	// History routes (require authentication)
	history := r.PathPrefix("/history").Subrouter()
	history.Use(r.authMiddleware)
	history.Use(r.rateLimitMiddleware)
	// More specific paths must register before /history "".
	history.HandleFunc("/sessions", r.getHistorySessions).Methods("GET")
	history.HandleFunc("/visits", r.getHistoryVisits).Methods("GET")
	history.HandleFunc("/clear", r.clearHistory).Methods("POST")
	history.HandleFunc("", r.getHistory).Methods("GET")

	// Quota routes (require authentication)
	quota := r.PathPrefix("/quota").Subrouter()
	quota.Use(r.authMiddleware)
	quota.Use(r.rateLimitMiddleware)
	quota.HandleFunc("", r.getQuota).Methods("GET")

	// Account (authenticated)
	acct := r.PathPrefix("/account").Subrouter()
	acct.Use(r.authMiddleware)
	acct.Use(r.rateLimitMiddleware)
	acct.HandleFunc("/purge-synced-data", r.purgeSyncedData).Methods("POST")

	// Admin routes (require authentication)
	admin := r.PathPrefix("/admin").Subrouter()
	admin.Use(r.authMiddleware)
	admin.Use(r.rateLimitMiddleware)
	admin.HandleFunc("/quota", r.updateQuota).Methods("POST")

	// Real-time routes (require authentication).  We don't apply the per-
	// request rate limiter here because the long-lived connection would be
	// penalised unfairly.
	realtime := r.PathPrefix("/realtime").Subrouter()
	realtime.Use(r.authMiddleware)
	realtime.HandleFunc("/ws", r.handleWebSocket).Methods("GET")
	realtime.HandleFunc("/sse", r.handleSSE).Methods("GET")
}

// Middleware for authentication
func (r *Router) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		authHeader := req.Header.Get("Authorization")
		if authHeader == "" {
			// Allow token via query param (for SSE/EventSource which can't set headers)
			if token := req.URL.Query().Get("token"); token != "" {
				claims, err := r.authService.ValidateDeviceToken(token)
				if err != nil {
					writeDeviceAuthFailure(w, err)
					return
				}

				if err := r.authService.UpdateDeviceLastSeen(claims.DeviceID); err != nil {
					log.Printf("Failed to update device last seen: %v", err)
				}

				ctx := req.Context()
				ctx = setUserID(ctx, claims.UserID)
				ctx = setDeviceID(ctx, claims.DeviceID)
				next.ServeHTTP(w, req.WithContext(ctx))
				return
			}

			writeSimpleUnauthorized(w, "Authorization header required")
			return
		}

		// Extract Bearer token
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || parts[0] != "Bearer" {
			writeSimpleUnauthorized(w, "Invalid authorization header format")
			return
		}

		token := parts[1]
		claims, err := r.authService.ValidateDeviceToken(token)
		if err != nil {
			writeDeviceAuthFailure(w, err)
			return
		}

		// Update device last seen
		if err := r.authService.UpdateDeviceLastSeen(claims.DeviceID); err != nil {
			log.Printf("Failed to update device last seen: %v", err)
		}

		// Add claims to request context
		ctx := req.Context()
		ctx = setUserID(ctx, claims.UserID)
		ctx = setDeviceID(ctx, claims.DeviceID)

		next.ServeHTTP(w, req.WithContext(ctx))
	})
}

// Health check endpoint
func (r *Router) healthCheck(w http.ResponseWriter, req *http.Request) {
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// Basic metrics endpoint
func (r *Router) metrics(w http.ResponseWriter, req *http.Request) {
	w.WriteHeader(http.StatusOK)
	metricsMu.Lock()
	defer metricsMu.Unlock()
	avg := int64(0)
	if requestCount > 0 {
		avg = requestDurationSum / requestCount
	}
	w.Write([]byte("# TYPE keepsync_requests_total counter\n"))
	w.Write([]byte(fmt.Sprintf("keepsync_requests_total %d\n", requestCount)))
	w.Write([]byte("# TYPE keepsync_request_errors_total counter\n"))
	w.Write([]byte(fmt.Sprintf("keepsync_request_errors_total %d\n", errorCount)))
	w.Write([]byte("# TYPE keepsync_request_duration_ms_sum counter\n"))
	w.Write([]byte(fmt.Sprintf("keepsync_request_duration_ms_sum %d\n", requestDurationSum)))
	w.Write([]byte("# TYPE keepsync_request_duration_ms_avg gauge\n"))
	w.Write([]byte(fmt.Sprintf("keepsync_request_duration_ms_avg %d\n", avg)))
}

// requestLogger logs method/path/status for incoming requests.
func (r *Router) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, req)
		duration := time.Since(start).Milliseconds()
		metricsMu.Lock()
		requestCount++
		requestDurationSum += duration
		if rec.status >= 500 {
			errorCount++
		}
		metricsMu.Unlock()
		log.Printf("%s %s %d %dms", req.Method, req.URL.Path, rec.status, duration)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// securityHeaders applies a conservative set of security headers to every
// response. HSTS is only emitted when the request is served over TLS because
// sending it over plain HTTP is ignored by browsers and confusing during
// local development.
func (r *Router) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		if req.TLS != nil {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, req)
	})
}

// bodySizeLimit caps request body size per config. WebSocket upgrades and GET
// requests are passed through unchanged.
func (r *Router) bodySizeLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet && req.Body != nil && r.config.MaxBodyBytes > 0 {
			req.Body = http.MaxBytesReader(w, req.Body, r.config.MaxBodyBytes)
		}
		next.ServeHTTP(w, req)
	})
}

// rateLimitMiddleware enforces a per-device request cap for authenticated
// routes. The underlying limiter is a fixed-window counter keyed by device ID.
func (r *Router) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		deviceID := getDeviceID(req.Context())
		if deviceID == "" {
			// Fall back to remote addr if auth middleware didn't populate a
			// device ID for some reason; still gives us *some* isolation.
			deviceID = req.RemoteAddr
		}
		allowed, retryAfter := r.rateLimiter.allow(deviceID)
		if !allowed {
			seconds := int(retryAfter.Seconds())
			if seconds < 1 {
				seconds = 1
			}
			w.Header().Set("Retry-After", fmt.Sprintf("%d", seconds))
			writeError(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, req)
	})
}

// Helper functions for JSON responses
func writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// writeJSONStatus is writeJSON's cousin for non-200 responses. Useful for
// 409 Conflict payloads that still need a structured body.
func writeJSONStatus(w http.ResponseWriter, statusCode int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(data)
}

// deviceAuthFailureDetail maps ValidateDeviceToken failures to a stable client code.
func deviceAuthFailureDetail(err error) (code string, message string) {
	if err == nil {
		return "", "Invalid or expired token"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "token has been revoked"),
		strings.Contains(msg, "device has been revoked"),
		strings.Contains(msg, "device no longer exists"):
		return "device_revoked", "This device was unpaired or its access was revoked."
	default:
		return "", "Invalid or expired token"
	}
}

func writeDeviceAuthFailure(w http.ResponseWriter, err error) {
	c, m := deviceAuthFailureDetail(err)
	payload := map[string]string{"error": m}
	if c != "" {
		payload["code"] = c
	}
	writeJSONStatus(w, http.StatusUnauthorized, payload)
}

func writeSimpleUnauthorized(w http.ResponseWriter, message string) {
	writeJSONStatus(w, http.StatusUnauthorized, map[string]string{"error": message})
}

func writeError(w http.ResponseWriter, message string, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}
