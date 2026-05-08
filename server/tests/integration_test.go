package tests_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"keepsync-server/internal/api"
	"keepsync-server/internal/config"
	"keepsync-server/internal/models"
	"keepsync-server/internal/storage"
)

// TestServer wraps the HTTP server for testing
type TestServer struct {
	*httptest.Server
	DB     *storage.DB
	Config *config.Config
}

// setupTestServer creates a test server with in-memory database
func setupTestServer(t *testing.T) *TestServer {
	// Create temporary database file
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")

	// Create test configuration
	cfg := &config.Config{
		ServerAddress: ":0", // Let system choose port
		DatabaseURL:   dbPath,
		JWTSecret:     "test-secret-key-for-testing-only",
		QuotaLimitMB:  10, // Small quota for testing
		TokenTTL:      time.Hour,
		SMTPHost:      "", // No SMTP for testing
		AllowedOrigins: []string{"*"},
	}

	// Initialize database
	db, err := storage.NewDB(cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("Failed to create test database: %v", err)
	}

	// Run migrations
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("Failed to run migrations: %v", err)
	}

	// Create API router
	router := api.NewRouter(db, cfg)

	// Create test server
	server := httptest.NewServer(router)

	return &TestServer{
		Server: server,
		DB:     db,
		Config: cfg,
	}
}

func TestCompleteUserFlow(t *testing.T) {
	server := setupTestServer(t)
	defer server.Close()
	defer server.DB.Close()

	// Test data
	email := "test@example.com"
	deviceName := "Test Chrome Browser"
	browser := "chrome"

	t.Run("HealthCheck", func(t *testing.T) {
		resp, err := http.Get(server.URL + "/healthz")
		if err != nil {
			t.Fatalf("Health check failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}
	})

	// Step 1: Request magic link
	var magicToken string
	t.Run("RequestMagicLink", func(t *testing.T) {
		payload := models.MagicLinkRequest{
			Email:      email,
			DeviceName: deviceName,
		}

		body, _ := json.Marshal(payload)
		resp, err := http.Post(server.URL+"/auth/magic-link", "application/json", bytes.NewBuffer(body))
		if err != nil {
			t.Fatalf("Magic link request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&result)

		// In test mode (no SMTP), the token should be returned directly
		if token, exists := result["token"]; exists {
			magicToken = token.(string)
		} else {
			t.Error("Expected magic token in response")
		}
	})

	// Step 2: Activate device
	var deviceToken string
	var userID, deviceID string
	t.Run("ActivateDevice", func(t *testing.T) {
		payload := models.ActivateRequest{
			Token: magicToken,
		}

		body, _ := json.Marshal(payload)
		req, _ := http.NewRequest("POST", server.URL+"/auth/activate", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Browser", browser)
		req.Header.Set("X-Device-Name", deviceName)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Device activation failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result models.ActivateResponse
		json.NewDecoder(resp.Body).Decode(&result)

		deviceToken = result.DeviceToken
		userID = result.UserID
		deviceID = result.DeviceID

		if deviceToken == "" || userID == "" || deviceID == "" {
			t.Error("Expected device token, user ID, and device ID in response")
		}
	})

	// Step 3: Upload tab snapshot
	t.Run("UploadSnapshot", func(t *testing.T) {
		tabs := []models.TabInfo{
			{
				URL:          "https://example.com",
				Title:        "Example Site",
				FaviconURL:   "https://example.com/favicon.ico",
				WindowID:     1,
				Pinned:       false,
				Discarded:    false,
				LastActiveAt: time.Now(),
			},
			{
				URL:          "https://github.com",
				Title:        "GitHub",
				FaviconURL:   "https://github.com/favicon.ico",
				WindowID:     1,
				Pinned:       true,
				Discarded:    false,
				LastActiveAt: time.Now(),
			},
		}

		payload := models.SnapshotRequest{
			Version: 1,
			Tabs:    tabs,
		}

		body, _ := json.Marshal(payload)
		req, _ := http.NewRequest("POST", server.URL+"/tabs/snapshot", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+deviceToken)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Snapshot upload failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result models.SnapshotResponse
		json.NewDecoder(resp.Body).Decode(&result)

		if !result.Acknowledged {
			t.Error("Expected snapshot to be acknowledged")
		}

		if result.ServerVersion == 0 {
			t.Error("Expected server version to be set")
		}
	})

	// Step 4: Upload tab events
	t.Run("UploadEvents", func(t *testing.T) {
		events := []models.TabEvent{
			{
				EventType:        "create",
				URL:              "https://stackoverflow.com",
				Title:            "Stack Overflow",
				FaviconURL:       "https://stackoverflow.com/favicon.ico",
				WindowID:         1,
				TabCorrelationID: "abc123",
				OccurredAt:       time.Now(),
			},
		}

		payload := models.EventsRequest{
			Events: events,
		}

		body, _ := json.Marshal(payload)
		req, _ := http.NewRequest("POST", server.URL+"/tabs/events", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+deviceToken)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Events upload failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result models.EventsResponse
		json.NewDecoder(resp.Body).Decode(&result)

		if !result.Acknowledged {
			t.Error("Expected events to be acknowledged")
		}

		if result.AppliedCount != 1 {
			t.Errorf("Expected 1 applied event, got %d", result.AppliedCount)
		}
	})

	// Step 5: Get current tabs
	t.Run("GetCurrentTabs", func(t *testing.T) {
		req, _ := http.NewRequest("GET", server.URL+"/tabs/current", nil)
		req.Header.Set("Authorization", "Bearer "+deviceToken)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Get current tabs failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result models.TabsCurrentResponse
		json.NewDecoder(resp.Body).Decode(&result)

		if len(result.Devices) == 0 {
			t.Error("Expected at least one device in response")
		}

		// Find our device
		found := false
		for _, device := range result.Devices {
			if device.DeviceID == deviceID {
				found = true
				if len(device.Tabs) < 2 {
					t.Errorf("Expected at least 2 tabs for device, got %d", len(device.Tabs))
				}
			}
		}

		if !found {
			t.Error("Expected to find our device in the response")
		}
	})

	// Step 6: Get devices
	t.Run("GetDevices", func(t *testing.T) {
		req, _ := http.NewRequest("GET", server.URL+"/devices", nil)
		req.Header.Set("Authorization", "Bearer "+deviceToken)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Get devices failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result models.DeviceListResponse
		json.NewDecoder(resp.Body).Decode(&result)

		if len(result.Devices) != 1 {
			t.Errorf("Expected 1 device, got %d", len(result.Devices))
		}

		device := result.Devices[0]
		if device.ID != deviceID {
			t.Errorf("Expected device ID %s, got %s", deviceID, device.ID)
		}

		if device.Browser != browser {
			t.Errorf("Expected browser %s, got %s", browser, device.Browser)
		}
	})

	// Step 7: Get quota
	t.Run("GetQuota", func(t *testing.T) {
		req, _ := http.NewRequest("GET", server.URL+"/quota", nil)
		req.Header.Set("Authorization", "Bearer "+deviceToken)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Get quota failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result models.QuotaStatus
		json.NewDecoder(resp.Body).Decode(&result)

		if result.LimitMB != server.Config.QuotaLimitMB {
			t.Errorf("Expected quota limit %d MB, got %d MB", server.Config.QuotaLimitMB, result.LimitMB)
		}

		if result.Status != "ok" && result.Status != "warn" {
			t.Errorf("Expected quota status 'ok' or 'warn', got '%s'", result.Status)
		}
	})

	// Step 8: Get history
	t.Run("GetHistory", func(t *testing.T) {
		req, _ := http.NewRequest("GET", server.URL+"/history?limit=10", nil)
		req.Header.Set("Authorization", "Bearer "+deviceToken)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Get history failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected status 200, got %d", resp.StatusCode)
		}

		var result models.HistoryResponse
		json.NewDecoder(resp.Body).Decode(&result)

		// Should have at least some history entries from our operations
		if len(result.Items) == 0 {
			t.Error("Expected some history entries")
		}
	})
}

func TestAuthenticationFailures(t *testing.T) {
	server := setupTestServer(t)
	defer server.Close()
	defer server.DB.Close()

	t.Run("InvalidMagicToken", func(t *testing.T) {
		payload := models.ActivateRequest{
			Token: "invalid-token",
		}

		body, _ := json.Marshal(payload)
		resp, err := http.Post(server.URL+"/auth/activate", "application/json", bytes.NewBuffer(body))
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", resp.StatusCode)
		}
	})

	t.Run("MissingAuthHeader", func(t *testing.T) {
		req, _ := http.NewRequest("GET", server.URL+"/devices", nil)

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", resp.StatusCode)
		}
	})

	t.Run("InvalidBearerToken", func(t *testing.T) {
		req, _ := http.NewRequest("GET", server.URL+"/devices", nil)
		req.Header.Set("Authorization", "Bearer invalid-token")

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d", resp.StatusCode)
		}
	})
}

func TestAPIValidation(t *testing.T) {
	server := setupTestServer(t)
	defer server.Close()
	defer server.DB.Close()

	t.Run("InvalidEmailFormat", func(t *testing.T) {
		payload := models.MagicLinkRequest{
			Email:      "invalid-email",
			DeviceName: "Test Device",
		}

		body, _ := json.Marshal(payload)
		resp, err := http.Post(server.URL+"/auth/magic-link", "application/json", bytes.NewBuffer(body))
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("expected 400 for malformed email, got %d", resp.StatusCode)
		}
	})

	t.Run("EmptyEmail", func(t *testing.T) {
		payload := models.MagicLinkRequest{
			Email:      "",
			DeviceName: "Test Device",
		}

		body, _ := json.Marshal(payload)
		resp, err := http.Post(server.URL+"/auth/magic-link", "application/json", bytes.NewBuffer(body))
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("Expected status 400 for empty email, got %d", resp.StatusCode)
		}
	})
}

// TestMain runs the test suite
func TestMain(m *testing.M) {
	// Set up test environment
	os.Setenv("JWT_SECRET", "test-secret-key-for-testing-only")
	
	// Run tests
	code := m.Run()
	
	// Clean up and exit
	os.Exit(code)
}

// BenchmarkCompleteFlow benchmarks the complete user flow
func BenchmarkCompleteFlow(b *testing.B) {
	server := setupTestServer(&testing.T{})
	defer server.Close()
	defer server.DB.Close()

	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		email := fmt.Sprintf("test%d@example.com", i)
		
		// Request magic link
		payload := models.MagicLinkRequest{
			Email:      email,
			DeviceName: "Benchmark Device",
		}
		
		body, _ := json.Marshal(payload)
		resp, _ := http.Post(server.URL+"/auth/magic-link", "application/json", bytes.NewBuffer(body))
		resp.Body.Close()
	}
}
