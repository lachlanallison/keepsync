package tests_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"keepsync-server/internal/api"
	"keepsync-server/internal/config"
	"keepsync-server/internal/models"
	"keepsync-server/internal/storage"
)

// setupTestServerWith constructs a TestServer with config overrides applied
// before the router is built, which is necessary because middleware captures
// config values at construction time (rate limiter in particular).
func setupTestServerWith(t *testing.T, mutate func(*config.Config)) *TestServer {
	t.Helper()

	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")

	cfg := &config.Config{
		ServerAddress:      ":0",
		DatabaseURL:        dbPath,
		JWTSecret:          "test-secret-key-for-testing-only",
		QuotaLimitMB:       10,
		TokenTTL:           time.Hour,
		SMTPHost:           "",
		AllowedOrigins:     []string{"*"},
		MaxBodyBytes:       2 * 1024 * 1024,
		RateLimitPerMinute: 120,
	}
	if mutate != nil {
		mutate(cfg)
	}

	db, err := storage.NewDB(cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("create test db: %v", err)
	}
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("run migrations: %v", err)
	}

	router := api.NewRouter(db, cfg)
	server := httptest.NewServer(router)

	return &TestServer{
		Server: server,
		DB:     db,
		Config: cfg,
	}
}

// TestEmailValidation asserts the magic-link endpoint rejects malformed
// email addresses with a 400 response before ever generating a token.
func TestEmailValidation(t *testing.T) {
	server := setupTestServerWith(t, nil)
	defer server.Close()
	defer server.DB.Close()

	bogusEmails := []string{
		"not-an-email",
		"missing@",
		"@nodomain.com",
		"spaces in@email.com",
	}

	for _, email := range bogusEmails {
		t.Run("reject_"+email, func(t *testing.T) {
			body, _ := json.Marshal(models.MagicLinkRequest{Email: email})
			resp, err := http.Post(server.URL+"/auth/magic-link",
				"application/json", bytes.NewBuffer(body))
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("expected 400, got %d", resp.StatusCode)
			}
		})
	}
}

// TestPairingCodeFlow exercises the SMTP-free device registration path:
// request a pairing code, redeem it for a device JWT, and use the JWT
// against a protected endpoint.
func TestPairingCodeFlow(t *testing.T) {
	server := setupTestServerWith(t, nil)
	defer server.Close()
	defer server.DB.Close()

	codeBody, _ := json.Marshal(map[string]string{"email": "pair@example.com"})
	resp, err := http.Post(server.URL+"/auth/pairing",
		"application/json", bytes.NewBuffer(codeBody))
	if err != nil {
		t.Fatalf("pairing request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var codeResp map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&codeResp); err != nil {
		t.Fatalf("decode pairing response: %v", err)
	}
	pairingCode := codeResp["pairing_code"]
	if pairingCode == "" {
		t.Fatal("expected pairing_code in response")
	}

	regBody, _ := json.Marshal(models.PairingRequest{
		PairingCode: pairingCode,
		DeviceName:  "Paired Device",
	})
	regReq, _ := http.NewRequest("POST", server.URL+"/devices/register",
		bytes.NewBuffer(regBody))
	regReq.Header.Set("Content-Type", "application/json")
	regReq.Header.Set("X-Browser", "firefox")

	regResp, err := http.DefaultClient.Do(regReq)
	if err != nil {
		t.Fatalf("device register failed: %v", err)
	}
	defer regResp.Body.Close()
	if regResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from /devices/register, got %d", regResp.StatusCode)
	}

	var activate models.ActivateResponse
	if err := json.NewDecoder(regResp.Body).Decode(&activate); err != nil {
		t.Fatalf("decode activate response: %v", err)
	}
	if activate.DeviceToken == "" {
		t.Fatal("expected device_token from pairing flow")
	}

	req, _ := http.NewRequest("GET", server.URL+"/devices", nil)
	req.Header.Set("Authorization", "Bearer "+activate.DeviceToken)
	listResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /devices failed: %v", err)
	}
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", listResp.StatusCode)
	}

	badBody, _ := json.Marshal(models.PairingRequest{
		PairingCode: "000000",
		DeviceName:  "Attacker",
	})
	badResp, err := http.Post(server.URL+"/devices/register",
		"application/json", bytes.NewBuffer(badBody))
	if err != nil {
		t.Fatalf("bad register request failed: %v", err)
	}
	defer badResp.Body.Close()
	if badResp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401 for bad code, got %d", badResp.StatusCode)
	}
}

// TestBodySizeLimit ensures oversized uploads return 413 instead of crashing
// downstream handlers.
func TestBodySizeLimit(t *testing.T) {
	server := setupTestServerWith(t, func(c *config.Config) {
		c.MaxBodyBytes = 256
	})
	defer server.Close()
	defer server.DB.Close()

	deviceToken := mintDeviceToken(t, server)

	big := strings.Repeat("a", 2048)
	payload, _ := json.Marshal(models.SnapshotRequest{
		Tabs: []models.TabInfo{{
			URL:          "https://example.com/" + big,
			Title:        big,
			WindowID:     1,
			LastActiveAt: time.Now(),
		}},
	})

	req, _ := http.NewRequest("POST", server.URL+"/tabs/snapshot", bytes.NewBuffer(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+deviceToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("snapshot upload failed: %v", err)
	}
	defer resp.Body.Close()

	// MaxBytesReader surfaces the violation when the handler reads the body,
	// which our handlers report as 400 via json decoder error. We accept
	// either 400 or 413 because the exact layer depends on handler order.
	if resp.StatusCode != http.StatusRequestEntityTooLarge && resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 413 or 400 for oversized body, got %d", resp.StatusCode)
	}
}

// TestRateLimit verifies authenticated endpoints return 429 once a device
// has exceeded its per-minute quota. We configure a tiny limit so the test
// doesn't need hundreds of requests.
func TestRateLimit(t *testing.T) {
	server := setupTestServerWith(t, func(c *config.Config) {
		c.RateLimitPerMinute = 5
	})
	defer server.Close()
	defer server.DB.Close()

	deviceToken := mintDeviceToken(t, server)

	var saw429 bool
	for i := 0; i < 20; i++ {
		req, _ := http.NewRequest("GET", server.URL+"/quota", nil)
		req.Header.Set("Authorization", "Bearer "+deviceToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request %d failed: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			if resp.Header.Get("Retry-After") == "" {
				t.Errorf("expected Retry-After header on 429")
			}
			saw429 = true
			break
		}
	}
	if !saw429 {
		t.Error("expected at least one 429 under rate-limit load")
	}
}

// TestSecurityHeaders asserts the baseline security headers are emitted on
// every response.
func TestSecurityHeaders(t *testing.T) {
	server := setupTestServerWith(t, nil)
	defer server.Close()
	defer server.DB.Close()

	resp, err := http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatalf("health check failed: %v", err)
	}
	defer resp.Body.Close()

	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	}
	for h, expected := range want {
		if got := resp.Header.Get(h); got != expected {
			t.Errorf("%s = %q, want %q", h, got, expected)
		}
	}
}

// mintDeviceToken runs the magic-link + activate handshake to obtain a
// device JWT for the provided server. The server must be configured without
// SMTP (the default in tests) so the token is returned directly.
func mintDeviceToken(t *testing.T, server *TestServer) string {
	t.Helper()

	email := fmt.Sprintf("helper-%d@example.com", time.Now().UnixNano())
	body, _ := json.Marshal(models.MagicLinkRequest{Email: email, DeviceName: "Helper"})
	resp, err := http.Post(server.URL+"/auth/magic-link", "application/json", bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("magic-link request failed: %v", err)
	}
	defer resp.Body.Close()

	var mlResp map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&mlResp); err != nil {
		t.Fatalf("decode magic-link response: %v", err)
	}
	token, _ := mlResp["token"].(string)
	if token == "" {
		t.Fatal("expected token in magic-link response (SMTP should be disabled in tests)")
	}

	activate, _ := json.Marshal(models.ActivateRequest{Token: token})
	req, _ := http.NewRequest("POST", server.URL+"/auth/activate", bytes.NewBuffer(activate))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Browser", "chrome")
	req.Header.Set("X-Device-Name", "Helper Browser")

	actResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("activate failed: %v", err)
	}
	defer actResp.Body.Close()

	var result models.ActivateResponse
	if err := json.NewDecoder(actResp.Body).Decode(&result); err != nil {
		t.Fatalf("decode activate response: %v", err)
	}
	if result.DeviceToken == "" {
		t.Fatal("expected device token from activate")
	}
	return result.DeviceToken
}

func TestAccountPurgeSyncedData(t *testing.T) {
	server := setupTestServer(t)
	defer server.Close()
	defer server.DB.Close()

	token := mintDeviceToken(t, server)

	ev, _ := json.Marshal(map[string]interface{}{
		"events": []map[string]interface{}{
			{
				"event_type":         "history",
				"url":                "https://purge-test.example/x",
				"title":              "hi",
				"window_id":          0,
				"tab_correlation_id": "hist:purge1",
				"occurred_at":        time.Now().Format(time.RFC3339Nano),
				"update_triggers":    "source:browser_history",
			},
		},
	})
	st, body := authedRequest(t, "POST", server.URL+"/tabs/events", token, ev)
	if st != http.StatusOK {
		t.Fatalf("POST /tabs/events: %d %s", st, body)
	}

	st, body = authedRequest(t, "POST", server.URL+"/account/purge-synced-data", token, nil)
	if st != http.StatusOK {
		t.Fatalf("POST /account/purge-synced-data: %d %s", st, body)
	}

	st, body = authedRequest(t, "GET", server.URL+"/history?limit=50", token, nil)
	if st != http.StatusOK {
		t.Fatalf("GET /history: %d %s", st, body)
	}
	var hist models.HistoryResponse
	if err := json.Unmarshal(body, &hist); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	if len(hist.Items) != 0 {
		t.Fatalf("expected empty history after purge, got %d rows", len(hist.Items))
	}
}
