package tests_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"keepsync-server/internal/auth"
	"keepsync-server/internal/config"
	"keepsync-server/internal/models"
)

// activateDevMode registers a device against the test server using the
// DevLogin shortcut via /auth/magic-link while DEV_MODE is enabled.  It
// returns the device id and the raw device token.
func activateDevMode(t *testing.T, server *TestServer, email string) (deviceID, token string) {
	t.Helper()
	body, _ := json.Marshal(models.MagicLinkRequest{Email: email, DeviceName: "integration"})
	resp, err := http.Post(server.URL+"/auth/magic-link", "application/json", bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("magic-link call failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("magic-link returned %d: %s", resp.StatusCode, raw)
	}
	var out models.ActivateResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode activate response: %v", err)
	}
	if out.DeviceID == "" || out.DeviceToken == "" {
		t.Fatalf("missing device credentials in response: %+v", out)
	}
	return out.DeviceID, out.DeviceToken
}

// authedGET issues a GET with a bearer token and returns the status code
// and raw body so tests can assert on both.
func authedRequest(t *testing.T, method, url, token string, body []byte) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("send request: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

// TestDeviceRevocation walks the full lifecycle: register two devices,
// revoke one, verify the revoked device's token stops working and it
// disappears from the list.
func TestDeviceRevocation(t *testing.T) {
	server := setupTestServerWith(t, func(cfg *config.Config) {
		cfg.DevMode = true
	})
	defer server.Close()
	defer server.DB.Close()

	aliceID, aliceToken := activateDevMode(t, server, "alice@example.com")
	bobID, bobToken := activateDevMode(t, server, "alice@example.com") // second device, same user
	_ = aliceID

	// Sanity: bob can list devices.
	status, body := authedRequest(t, "GET", server.URL+"/devices", bobToken, nil)
	if status != http.StatusOK {
		t.Fatalf("device list pre-revoke: %d %s", status, body)
	}
	var list models.DeviceListResponse
	if err := json.Unmarshal(body, &list); err != nil {
		t.Fatalf("parse device list: %v", err)
	}
	if len(list.Devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(list.Devices))
	}

	// Alice revokes bob (same user, so permitted).
	status, body = authedRequest(t, "DELETE", server.URL+"/devices/"+bobID, aliceToken, nil)
	if status != http.StatusOK {
		t.Fatalf("revoke returned %d: %s", status, body)
	}

	// Bob's token must now fail validation.
	status, body = authedRequest(t, "GET", server.URL+"/devices", bobToken, nil)
	if status != http.StatusUnauthorized {
		t.Errorf("revoked device token should be 401, got %d body=%s", status, body)
	}

	// Alice can still list, and sees only herself.
	status, body = authedRequest(t, "GET", server.URL+"/devices", aliceToken, nil)
	if status != http.StatusOK {
		t.Fatalf("alice list post-revoke: %d %s", status, body)
	}
	if err := json.Unmarshal(body, &list); err != nil {
		t.Fatalf("parse device list: %v", err)
	}
	if len(list.Devices) != 1 || list.Devices[0].ID != aliceID {
		t.Errorf("expected only alice after revoke, got %+v", list.Devices)
	}
}

// TestCrossUserRevocationRejected ensures a device from user B cannot
// revoke user A's device.
func TestCrossUserRevocationRejected(t *testing.T) {
	server := setupTestServerWith(t, func(cfg *config.Config) {
		cfg.DevMode = true
	})
	defer server.Close()
	defer server.DB.Close()

	aliceID, _ := activateDevMode(t, server, "alice@example.com")
	_, mallory := activateDevMode(t, server, "mallory@example.com")

	status, body := authedRequest(t, "DELETE", server.URL+"/devices/"+aliceID, mallory, nil)
	if status != http.StatusNotFound {
		t.Errorf("expected 404 cross-user revoke (scoped query), got %d body=%s", status, body)
	}
}

// TestInviteTokenActivation verifies the no-SMTP bootstrap path: mint a
// token via the auth service (what the CLI does), redeem via /auth/invite,
// and confirm the returned JWT actually works.
func TestInviteTokenActivation(t *testing.T) {
	server := setupTestServerWith(t, nil)
	defer server.Close()
	defer server.DB.Close()

	svc := auth.NewService(server.DB, server.Config)
	token, err := svc.GenerateInviteToken("admin@example.com", time.Hour)
	if err != nil {
		t.Fatalf("mint invite: %v", err)
	}
	if token == "" {
		t.Fatal("invite token was empty")
	}

	payload := map[string]string{"token": token, "device_name": "invited-laptop"}
	buf, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", server.URL+"/auth/invite", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Browser", "chrome")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("invite activate: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(resp.Body)
		t.Fatalf("activate invite failed: %d %s", resp.StatusCode, data)
	}
	var out models.ActivateResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode invite activation: %v", err)
	}
	if out.DeviceToken == "" {
		t.Fatal("no device token returned")
	}

	// The same invite token must not be reusable.
	req2, _ := http.NewRequest("POST", server.URL+"/auth/invite", bytes.NewReader(buf))
	req2.Header.Set("Content-Type", "application/json")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("second invite activate: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode == http.StatusOK {
		t.Error("expected single-use invite, but second activation succeeded")
	}
}

// TestSnapshotBaseVersionConflict asserts that snapshots opting into
// optimistic concurrency (base_version > 0) are rejected with 409 when
// the server has advanced past the supplied version.
func TestSnapshotBaseVersionConflict(t *testing.T) {
	server := setupTestServerWith(t, func(cfg *config.Config) {
		cfg.DevMode = true
	})
	defer server.Close()
	defer server.DB.Close()

	_, token := activateDevMode(t, server, "user@example.com")

	// First snapshot: no base_version, establishes server_version = 1.
	first := map[string]any{
		"version": time.Now().UnixNano(),
		"tabs":    []map[string]any{{"url": "https://first.example", "title": "first", "window_id": 1, "last_active_at": time.Now()}},
	}
	buf, _ := json.Marshal(first)
	status, body := authedRequest(t, "POST", server.URL+"/tabs/snapshot", token, buf)
	if status != http.StatusOK {
		t.Fatalf("first snapshot: %d %s", status, body)
	}
	var firstResp models.SnapshotResponse
	if err := json.Unmarshal(body, &firstResp); err != nil {
		t.Fatalf("decode first snapshot: %v", err)
	}
	if firstResp.ServerVersion < 1 {
		t.Fatalf("expected non-zero server_version, got %d", firstResp.ServerVersion)
	}

	// Stale snapshot: claim base_version = 1 but the server has already
	// moved on thanks to concurrent writes we simulate with another upload.
	advance := map[string]any{
		"version": time.Now().UnixNano(),
		"tabs":    []map[string]any{{"url": "https://second.example", "title": "second", "window_id": 1, "last_active_at": time.Now()}},
	}
	buf, _ = json.Marshal(advance)
	status, _ = authedRequest(t, "POST", server.URL+"/tabs/snapshot", token, buf)
	if status != http.StatusOK {
		t.Fatalf("advance snapshot failed: %d", status)
	}

	stale := map[string]any{
		"version":      time.Now().UnixNano(),
		"base_version": firstResp.ServerVersion,
		"tabs":         []map[string]any{{"url": "https://stale.example", "title": "stale", "window_id": 1, "last_active_at": time.Now()}},
	}
	buf, _ = json.Marshal(stale)
	status, body = authedRequest(t, "POST", server.URL+"/tabs/snapshot", token, buf)
	if status != http.StatusConflict {
		t.Fatalf("expected 409 on stale base_version, got %d body=%s", status, body)
	}
	var conflict models.SnapshotConflictResponse
	if err := json.Unmarshal(body, &conflict); err != nil {
		t.Fatalf("decode conflict response: %v", err)
	}
	if conflict.ServerVersion <= firstResp.ServerVersion {
		t.Errorf("conflict response should include advanced server_version, got %d", conflict.ServerVersion)
	}
	if conflict.BaseVersion != firstResp.ServerVersion {
		t.Errorf("conflict response should echo client base_version, got %d", conflict.BaseVersion)
	}
}

// TestStaleEventDropped asserts that a same-URL stale event does not
// overwrite current state, is not counted as a conflict, and the fresher
// title remains. (We intentionally do not create conflict rows for
// same-URL out-of-order/title noise.)
func TestStaleEventDropped(t *testing.T) {
	server := setupTestServerWith(t, func(cfg *config.Config) {
		cfg.DevMode = true
	})
	defer server.Close()
	defer server.DB.Close()

	_, token := activateDevMode(t, server, "user2@example.com")

	now := time.Now()
	newTitle := "fresh-title"
	oldTitle := "ancient-title"

	// Seed with a fresh event.
	freshEvent := map[string]any{
		"event_type":         "update",
		"url":                "https://example.com/page",
		"title":              newTitle,
		"window_id":          1,
		"tab_correlation_id": "abc123",
		"occurred_at":        now,
	}
	buf, _ := json.Marshal(map[string]any{"events": []map[string]any{freshEvent}})
	status, body := authedRequest(t, "POST", server.URL+"/tabs/events", token, buf)
	if status != http.StatusOK {
		t.Fatalf("fresh event upload: %d %s", status, body)
	}

	// Send an older event for the same correlation id: should be dropped.
	staleEvent := map[string]any{
		"event_type":         "update",
		"url":                "https://example.com/page",
		"title":              oldTitle,
		"window_id":          1,
		"tab_correlation_id": "abc123",
		"occurred_at":        now.Add(-1 * time.Hour),
	}
	buf, _ = json.Marshal(map[string]any{"events": []map[string]any{staleEvent}})
	status, body = authedRequest(t, "POST", server.URL+"/tabs/events", token, buf)
	if status != http.StatusOK {
		t.Fatalf("stale event upload: %d %s", status, body)
	}
	var resp models.EventsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode events response: %v", err)
	}
	if resp.ConflictsCreated != 0 {
		t.Errorf("expected conflicts_created=0 for same-URL stale event, got %d", resp.ConflictsCreated)
	}

	// Pull current tabs; the fresh title must still be there.
	status, body = authedRequest(t, "GET", server.URL+"/tabs/current", token, nil)
	if status != http.StatusOK {
		t.Fatalf("current tabs: %d %s", status, body)
	}
	var currentResp models.TabsCurrentResponse
	if err := json.Unmarshal(body, &currentResp); err != nil {
		t.Fatalf("decode current: %v", err)
	}
	found := false
	for _, dev := range currentResp.Devices {
		for _, tab := range dev.Tabs {
			if tab.URL == "https://example.com/page" {
				found = true
				if tab.Title == oldTitle {
					t.Error("stale event should not have overwritten fresh title")
				}
				if tab.Title != newTitle {
					t.Errorf("unexpected title %q (want %q)", tab.Title, newTitle)
				}
			}
		}
	}
	if !found {
		t.Error("fresh tab missing from current state")
	}
}
