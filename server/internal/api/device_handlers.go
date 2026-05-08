package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"keepsync-server/internal/models"

	"github.com/gorilla/mux"
)

// listDevices handles GET /devices
func (r *Router) listDevices(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())

	devices, err := r.getDevicesForUser(userID)
	if err != nil {
		log.Printf("Failed to get devices: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	response := &models.DeviceListResponse{
		Devices: devices,
	}

	writeJSON(w, response)
}

// updateDevice handles PUT /devices/{id}
func (r *Router) updateDevice(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	deviceID := mux.Vars(req)["id"]

	var payload struct {
		DeviceName string `json:"device_name"`
	}

	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		writeError(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if payload.DeviceName == "" {
		writeError(w, "Device name is required", http.StatusBadRequest)
		return
	}

	// Revoked devices are intentionally excluded — there is no value in
	// renaming a device whose tokens are dead.
	query := `UPDATE devices SET device_name = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
	result, err := r.db.Exec(query, payload.DeviceName, deviceID, userID)
	if err != nil {
		log.Printf("Failed to update device name: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if rows, _ := result.RowsAffected(); rows == 0 {
		writeError(w, "Device not found", http.StatusNotFound)
		return
	}

	writeJSON(w, map[string]string{
		"message": "Device updated",
	})
}

// revokeDevice handles DELETE /devices/{id}
//
// Marks the target device as revoked (scoped to the authenticated user) and
// invalidates every device-type auth token issued to it. The caller is
// permitted to revoke their own device — that's the "sign out everywhere"
// path we want to support.  After revocation we publish a realtime event so
// any connected WebSocket/SSE clients on that device terminate immediately.
func (r *Router) revokeDevice(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	targetID := mux.Vars(req)["id"]
	if targetID == "" {
		writeError(w, "Device id is required", http.StatusBadRequest)
		return
	}

	if err := r.authService.RevokeDevice(targetID, userID); err != nil {
		if err == sql.ErrNoRows {
			writeError(w, "Device not found", http.StatusNotFound)
			return
		}
		log.Printf("Failed to revoke device %s: %v", targetID, err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	// Broadcast the revocation so any live connections owned by the target
	// device (or any of the user's other devices watching the device list)
	// can react.  Revoked devices should drop their WS, flush state, and
	// return the user to the setup screen.
	notifyUser(userID, fmt.Sprintf(
		`{"type":"device_revoked","device_id":%q}`, targetID,
	))

	writeJSON(w, map[string]string{
		"message":   "Device revoked",
		"device_id": targetID,
	})
}

// getHistory handles GET /history
func (r *Router) getHistory(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())

	// Parse query parameters
	deviceID := req.URL.Query().Get("device_id")
	fromStr := req.URL.Query().Get("from")
	toStr := req.URL.Query().Get("to")
	limitStr := req.URL.Query().Get("limit")
	cursor := req.URL.Query().Get("cursor")

	// Set defaults
	limit := 50
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 1000 {
			limit = l
		}
	}

	history, nextCursor, err := r.getHistoryForUser(userID, deviceID, fromStr, toStr, limit, cursor)
	if err != nil {
		log.Printf("Failed to get history: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	response := &models.HistoryResponse{
		Items:      history,
		NextCursor: nextCursor,
	}

	writeJSON(w, response)
}

// clearHistory handles POST /history/clear
func (r *Router) clearHistory(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())

	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("Failed to start transaction: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM tab_history WHERE user_id = ?`, userID); err != nil {
		log.Printf("Failed to clear history: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if _, err := tx.Exec(`UPDATE users SET quota_used_bytes = 0 WHERE id = ?`, userID); err != nil {
		log.Printf("Failed to reset quota usage: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(); err != nil {
		log.Printf("Failed to commit history clear: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"message": "History cleared"})
}

// getQuota handles GET /quota
func (r *Router) getQuota(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())

	quota, err := r.getQuotaForUser(userID)
	if err != nil {
		log.Printf("Failed to get quota: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if err := r.attachQuotaHistoryBreakdown(userID, quota); err != nil {
		log.Printf("quota history breakdown: %v", err)
	}

	writeJSON(w, quota)
}

// attachQuotaHistoryBreakdown fills tab_history aggregates and a recent sample.
func (r *Router) attachQuotaHistoryBreakdown(userID string, q *models.QuotaStatus) error {
	var n, sum int64
	if err := r.db.QueryRow(`
		SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM tab_history WHERE user_id = ?
	`, userID).Scan(&n, &sum); err != nil {
		return err
	}
	q.TabHistoryCount = n
	q.TabHistoryBytesSum = sum
	if n > 0 {
		q.AvgEventBytes = sum / n
	}
	const limit = 40
	rows, err := r.db.Query(`
		SELECT event_type, occurred_at, size_bytes, url
		FROM tab_history WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?
	`, userID, limit)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var et string
		var at time.Time
		var sz int64
		var url string
		if err := rows.Scan(&et, &at, &sz, &url); err != nil {
			return err
		}
		q.RecentEvents = append(q.RecentEvents, models.QuotaHistoryEvent{
			OccurredAt: at.UTC().Format(time.RFC3339Nano),
			EventType:  et,
			SizeBytes:  sz,
			URL:        url,
		})
	}
	return rows.Err()
}

// updateQuota handles POST /admin/quota
func (r *Router) updateQuota(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())

	var payload struct {
		UserID    string `json:"user_id"`
		LimitMB   int64  `json:"new_limit_mb"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		writeError(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if payload.UserID == "" {
		payload.UserID = userID
	}
	if payload.UserID != userID {
		writeError(w, "Forbidden", http.StatusForbidden)
		return
	}
	if payload.LimitMB <= 0 {
		writeError(w, "new_limit_mb must be > 0", http.StatusBadRequest)
		return
	}

	_, err := r.db.Exec(`UPDATE users SET quota_limit_mb = ? WHERE id = ?`, payload.LimitMB, payload.UserID)
	if err != nil {
		log.Printf("Failed to update quota: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"message": "Quota updated"})
}

// Helper functions

func (r *Router) getDevicesForUser(userID string) ([]models.Device, error) {
	// Revoked devices are filtered out entirely — the options UI treats
	// "listed" as "active", and callers that need revoked devices can query
	// the history table directly.
	query := `
		SELECT id, user_id, browser, device_name, created_at, last_seen_at, revoked_at
		FROM devices
		WHERE user_id = ? AND revoked_at IS NULL
		ORDER BY last_seen_at DESC
	`

	rows, err := r.db.Query(query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []models.Device
	for rows.Next() {
		var device models.Device
		var revokedAt sql.NullTime
		if err := rows.Scan(&device.ID, &device.UserID, &device.Browser, &device.DeviceName,
			&device.CreatedAt, &device.LastSeenAt, &revokedAt); err != nil {
			return nil, err
		}
		if revokedAt.Valid {
			t := revokedAt.Time
			device.RevokedAt = &t
		}
		devices = append(devices, device)
	}

	return devices, nil
}

func (r *Router) getHistoryForUser(userID, deviceID, fromStr, toStr string, limit int, cursor string) ([]models.TabHistory, string, error) {
	query := `
		SELECT id, user_id, device_id, event_type, url, title, favicon_url, window_id, 
			   tab_correlation_id, occurred_at, size_bytes, COALESCE(update_triggers, '')
		FROM tab_history
		WHERE user_id = ?
	`
	args := []interface{}{userID}

	// Add device filter
	if deviceID != "" {
		query += " AND device_id = ?"
		args = append(args, deviceID)
	}

	// Add time range filters
	if fromStr != "" {
		query += " AND occurred_at >= ?"
		args = append(args, fromStr)
	}
	if toStr != "" {
		query += " AND occurred_at <= ?"
		args = append(args, toStr)
	}

	// Add cursor for pagination
	if cursor != "" {
		query += " AND occurred_at < ?"
		args = append(args, cursor)
	}

	query += " ORDER BY occurred_at DESC LIMIT ?"
	args = append(args, limit+1) // Get one extra to check if there are more results

	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	var history []models.TabHistory
	for rows.Next() {
		var item models.TabHistory
		if err := rows.Scan(&item.ID, &item.UserID, &item.DeviceID, &item.EventType,
			&item.URL, &item.Title, &item.FaviconURL, &item.WindowID,
			&item.TabCorrelationID, &item.OccurredAt, &item.SizeBytes, &item.UpdateTriggers); err != nil {
			return nil, "", err
		}
		history = append(history, item)
	}

	// Check if there are more results
	var nextCursor string
	if len(history) > limit {
		// Remove the extra item and set cursor to the last item's timestamp
		history = history[:limit]
		nextCursor = history[len(history)-1].OccurredAt.Format("2006-01-02T15:04:05.000Z")
	}

	return history, nextCursor, nil
}

func (r *Router) getQuotaForUser(userID string) (*models.QuotaStatus, error) {
	query := `SELECT quota_used_bytes, quota_limit_mb FROM users WHERE id = ?`
	var usedBytes, limitMB int64
	err := r.db.QueryRow(query, userID).Scan(&usedBytes, &limitMB)
	if err != nil {
		return nil, err
	}

	limitBytes := limitMB * 1024 * 1024
	usageMB := usedBytes / (1024 * 1024)

	status := "ok"
	if usedBytes > limitBytes {
		status = "prune"
	} else if float64(usedBytes) > float64(limitBytes)*0.9 {
		status = "warn"
	}

	return &models.QuotaStatus{
		Status:     status,
		UsageMB:    usageMB,
		LimitMB:    limitMB,
		UsageBytes: usedBytes,
	}, nil
}
