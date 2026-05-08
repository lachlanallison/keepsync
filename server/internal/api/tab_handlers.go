package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"keepsync-server/internal/models"
)

// uploadSnapshot handles POST /tabs/snapshot
//
// Snapshots overwrite the device's entire tab set, so we treat them as
// write-heavy and expose an optional optimistic-concurrency check via the
// `base_version` request field.  Clients that include it are telling the
// server "I last saw user_versions at N — only apply if that's still true".
// On mismatch we return 409 Conflict plus the current version so the client
// can pull before retrying, which avoids clobbering newer state from another
// device.
func (r *Router) uploadSnapshot(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	deviceID := getDeviceID(req.Context())

	var request models.SnapshotRequest
	if err := json.NewDecoder(req.Body).Decode(&request); err != nil {
		writeError(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	// Start transaction
	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("Failed to start transaction: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	// Optimistic-concurrency gate: only enforce when the client opts in by
	// sending base_version > 0. base_version=0 means "don't care" which
	// preserves legacy client behaviour.
	if request.BaseVersion > 0 {
		currentVersion, err := r.getCurrentVersion(tx, userID)
		if err != nil {
			log.Printf("Failed to read current version: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
		if currentVersion != request.BaseVersion {
			writeJSONStatus(w, http.StatusConflict, models.SnapshotConflictResponse{
				Error:         "version_conflict",
				ServerVersion: currentVersion,
				BaseVersion:   request.BaseVersion,
				Hint:          "pull /tabs/current then retry the snapshot",
			})
			return
		}
	}

	// Get current server version for this user
	serverVersion, err := r.getNextVersion(tx, userID)
	if err != nil {
		log.Printf("Failed to get server version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	// Clear existing current tabs for this device
	if err := r.clearCurrentTabs(tx, userID, deviceID); err != nil {
		log.Printf("Failed to clear current tabs: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	// Count hash uses so duplicate URL+window (legacy) or same-hash rows get
	// distinct tab_id_hash values in one snapshot.
	snapshotHashCount := make(map[string]int)

	// Insert new current tabs
	for _, tab := range request.Tabs {
		// Skip restricted URLs
		if r.isRestrictedURL(tab.URL) {
			continue
		}

		baseHash := r.tabIDHashForSnapshot(&tab)
		suffix := snapshotHashCount[baseHash]
		snapshotHashCount[baseHash] = suffix + 1
		tabIDHash := baseHash
		if suffix > 0 {
			tabIDHash = fmt.Sprintf("%s#%d", baseHash, suffix)
		}
		tabCurrent := &models.TabCurrent{
			ID:           uuid.New().String(),
			UserID:       userID,
			DeviceID:     deviceID,
			TabIDHash:    tabIDHash,
			URL:          tab.URL,
			Title:        tab.Title,
			FaviconURL:   tab.FaviconURL,
			WindowID:     tab.WindowID,
			Pinned:       tab.Pinned,
			Discarded:    tab.Discarded,
			LastActiveAt: tab.LastActiveAt,
			UpdatedAt:    time.Now(),
			Version:      serverVersion,
		}

		if err := r.insertCurrentTab(tx, tabCurrent); err != nil {
			log.Printf("Failed to insert current tab: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}

	}

	// Check quota status
	quotaStatus, err := r.getQuotaStatus(tx, userID)
	if err != nil {
		log.Printf("Failed to get quota status: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if quotaStatus.Status == "prune" {
		if err := r.pruneHistoryToQuota(tx, userID); err != nil {
			log.Printf("Failed to prune history: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
		quotaStatus, _ = r.getQuotaStatus(tx, userID)
	}

	if err := r.updateDeviceVersion(tx, userID, deviceID, serverVersion); err != nil {
		log.Printf("Failed to update device version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	// Commit transaction
	if err := tx.Commit(); err != nil {
		log.Printf("Failed to commit transaction: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	notifyUser(userID, fmt.Sprintf("{\"type\":\"tab_change\",\"device_id\":\"%s\",\"version\":%d}", deviceID, serverVersion))

	response := &models.SnapshotResponse{
		Acknowledged:  true,
		ServerVersion: serverVersion,
		QuotaStatus:   *quotaStatus,
	}

	writeJSON(w, response)
}

// uploadEvents handles POST /tabs/events
func (r *Router) uploadEvents(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	deviceID := getDeviceID(req.Context())

	var request models.EventsRequest
	if err := json.NewDecoder(req.Body).Decode(&request); err != nil {
		writeError(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if n := len(request.Events); n > 0 {
		log.Printf("POST /tabs/events body user=%s device=%s events_in=%d", userID, deviceID, n)
		for i := range request.Events {
			logEventPreview(i, &request.Events[i])
		}
	}

	// Start transaction
	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("Failed to start transaction: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

		appliedCount := 0
		conflictsCreated := 0
		serverVersion := int64(0)
		deviceVersion := int64(0)
		totalSizeBytes := int64(0)

	for _, event := range request.Events {
		// Skip restricted URLs
		if r.isRestrictedURL(event.URL) {
			continue
		}

		// Process event based on type
		switch event.EventType {
		case "history":
			// Browser history API backfill: tab_history row only (no tabs_current).
			if strings.TrimSpace(event.URL) == "" {
				continue
			}
			if event.TabCorrelationID == "" {
				event.TabCorrelationID = "hist:" + r.generateTabIDHash(event.URL, event.WindowID)
			}
			eventTime := event.OccurredAt
			if eventTime.IsZero() {
				eventTime = time.Now()
				event.OccurredAt = eventTime
			}
		case "create", "update", "focus":
			// focus: same tabs_current merge rules as create/update, but no tab_history row
			// (user-visible timeline stays create/update/close/history/conflict only).
			skipTabHistory := event.EventType == "focus"
			tabIDHash := event.TabCorrelationID
			if tabIDHash == "" {
				tabIDHash = r.generateTabIDHash(event.URL, event.WindowID)
			}

			eventTime := event.OccurredAt
			if eventTime.IsZero() {
				eventTime = time.Now()
				event.OccurredAt = eventTime
			}

			existing, err := r.getCurrentTabByHash(tx, userID, deviceID, tabIDHash)
			if err != nil {
				log.Printf("Failed to load current tab: %v", err)
			}
			// Last-writer-wins by event timestamp.  If the current state is
			// strictly newer than this incoming event we treat the event as
			// stale — record a conflict history entry so the user can see
			// what lost, but do NOT overwrite the fresher state. The old
			// implementation always overwrote, which meant out-of-order
			// deliveries silently clobbered newer data.
			if existing != nil && existing.UpdatedAt.After(eventTime) {
				// Same page (URL) as current row: treat as out-of-order/title-paint
				// noise — do not record a conflict. Title-only changes while the URL
				// is unchanged should not spam history (client also coalesces the queue).
				if strings.TrimSpace(existing.URL) == strings.TrimSpace(event.URL) {
					continue
				}
				conflictsCreated++
				conflictBytes := r.estimateEventSize(&event)
				if err := r.insertStaleEventHistory(tx, userID, deviceID, &event); err != nil {
					log.Printf("Failed to insert conflict history: %v", err)
				} else {
					totalSizeBytes += conflictBytes
				}
				continue
			}

			version, err := r.processTabCreateUpdate(tx, userID, deviceID, tabIDHash, &event)
			if err != nil {
				log.Printf("Failed to process tab event: %v", err)
				continue
			}
			if version > serverVersion {
				serverVersion = version
			}
			if version > deviceVersion {
				deviceVersion = version
			}
			if skipTabHistory {
				continue
			}
		case "close":
			version, err := r.getNextVersion(tx, userID)
			if err != nil {
				log.Printf("Failed to get next version: %v", err)
				continue
			}
			if err := r.processTabClose(tx, userID, deviceID, &event); err != nil {
				log.Printf("Failed to process tab close: %v", err)
				continue
			}
			if version > serverVersion {
				serverVersion = version
			}
			if version > deviceVersion {
				deviceVersion = version
			}
		default:
			log.Printf("unknown event_type %q, skipping event", event.EventType)
			continue
		}

		// Add to history (drop near-identical "update" rows: same tab+url+type within 2s)
		record, err := r.shouldRecordTabHistory(tx, userID, deviceID, &event)
		if err != nil {
			log.Printf("shouldRecordTabHistory: %v", err)
		}
		if !record {
			continue
		}

		sizeBytes := r.estimateEventSize(&event)

		title := strings.TrimSpace(event.Title)
		if title == "" {
			title = strings.TrimSpace(event.URL)
		}
		if title == "" {
			title = "(no title)"
		}

		historyEntry := &models.TabHistory{
			ID:                uuid.New().String(),
			UserID:            userID,
			DeviceID:          deviceID,
			EventType:         event.EventType,
			URL:               event.URL,
			Title:             title,
			FaviconURL:        event.FaviconURL,
			WindowID:          event.WindowID,
			TabCorrelationID:  event.TabCorrelationID,
			OccurredAt:        event.OccurredAt,
			SizeBytes:         sizeBytes,
			UpdateTriggers:    event.UpdateTriggers,
		}

		if err := r.insertTabHistory(tx, historyEntry); err != nil {
			log.Printf("Failed to insert tab history: %v", err)
			continue
		}
		totalSizeBytes += sizeBytes

		appliedCount++
	}

	log.Printf("POST /tabs/events user=%s device=%s events_in=%d applied=%d conflicts=%d",
		userID, deviceID, len(request.Events), appliedCount, conflictsCreated)

	// Update user quota usage
	if err := r.updateQuotaUsage(tx, userID, totalSizeBytes); err != nil {
		log.Printf("Failed to update quota usage: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	quotaStatus, err := r.getQuotaStatus(tx, userID)
	if err != nil {
		log.Printf("Failed to get quota status: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if quotaStatus.Status == "prune" {
		if err := r.pruneHistoryToQuota(tx, userID); err != nil {
			log.Printf("Failed to prune history: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
	}

	if deviceVersion > 0 {
		if err := r.updateDeviceVersion(tx, userID, deviceID, deviceVersion); err != nil {
			log.Printf("Failed to update device version: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
	}

	// Commit transaction
	if err := tx.Commit(); err != nil {
		log.Printf("Failed to commit transaction: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	notifyUser(userID, fmt.Sprintf("{\"type\":\"tab_change\",\"device_id\":\"%s\"}", deviceID))

		response := &models.EventsResponse{
			Acknowledged:     true,
			AppliedCount:     appliedCount,
			ConflictsCreated: conflictsCreated,
			ServerVersion:    serverVersion,
		}

	writeJSON(w, response)
}

// getCurrentTabs handles GET /tabs/current
func (r *Router) getCurrentTabs(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())

	// Parse since parameter
	sinceVersion := int64(0)
	if since := req.URL.Query().Get("since"); since != "" {
		if v, err := strconv.ParseInt(since, 10, 64); err == nil {
			sinceVersion = v
		}
	}

	devices, err := r.getCurrentTabsForUser(userID, sinceVersion)
	if err != nil {
		log.Printf("Failed to get current tabs: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	response := &models.TabsCurrentResponse{
		Devices: devices,
	}

	writeJSON(w, response)
}

// Helper functions

func (r *Router) isRestrictedURL(url string) bool {
	restrictedSchemes := []string{"file://", "chrome://", "about:", "moz-extension://", "chrome-extension://"}
	for _, scheme := range restrictedSchemes {
		if len(url) >= len(scheme) && url[:len(scheme)] == scheme {
			return true
		}
	}
	return false
}

// logEventPreview prints one line per incoming tab event to stdout (debug).
func logEventPreview(i int, e *models.TabEvent) {
	u := e.URL
	if len(u) > 160 {
		u = u[:160] + "…"
	}
	cid := e.TabCorrelationID
	if len(cid) > 20 {
		cid = cid[:20] + "…"
	}
	tid := interface{}("-")
	if e.ClientTabID > 0 {
		tid = e.ClientTabID
	}
	log.Printf("  event[%d] type=%s client_tab_id=%v tab_correlation_id=%s url=%s triggers=%q",
		i, e.EventType, tid, cid, u, e.UpdateTriggers)
}

func (r *Router) generateTabIDHash(url string, windowID int) string {
	data := fmt.Sprintf("%s:%d", url, windowID)
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:8]) // Use first 8 bytes for shorter hash
}

// tabIDHashForSnapshot builds a stable per-tab id for current-tabs storage.
// Hash uses only the browser tab id (URL changes on navigation must not change
// the id) so events/history and tabs_current refer to the same row across navigations.
// When tab_id is missing, the legacy url+window hash is used; uploadSnapshot appends
// #1, #2, … for collisions in the same request.
func (r *Router) tabIDHashForSnapshot(tab *models.TabInfo) string {
	if tab != nil && tab.TabID != 0 {
		data := fmt.Sprintf("id:%d", tab.TabID)
		hash := sha256.Sum256([]byte(data))
		return hex.EncodeToString(hash[:8])
	}
	return r.generateTabIDHash(tab.URL, tab.WindowID)
}

func (r *Router) getNextVersion(tx *sql.Tx, userID string) (int64, error) {
	if _, err := tx.Exec(`INSERT OR IGNORE INTO user_versions (user_id, version) VALUES (?, 0)`, userID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE user_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, userID); err != nil {
		return 0, err
	}

	var version int64
	err := tx.QueryRow(`SELECT version FROM user_versions WHERE user_id = ?`, userID).Scan(&version)
	return version, err
}

// getCurrentVersion returns the current user_versions value without
// bumping it. It lazily seeds the row so new users compare against 0.
func (r *Router) getCurrentVersion(tx *sql.Tx, userID string) (int64, error) {
	if _, err := tx.Exec(`INSERT OR IGNORE INTO user_versions (user_id, version) VALUES (?, 0)`, userID); err != nil {
		return 0, err
	}
	var version int64
	err := tx.QueryRow(`SELECT version FROM user_versions WHERE user_id = ?`, userID).Scan(&version)
	return version, err
}

func (r *Router) updateDeviceVersion(tx *sql.Tx, userID, deviceID string, version int64) error {
	_, err := tx.Exec(`
		INSERT INTO device_versions (device_id, user_id, version, updated_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(device_id) DO UPDATE SET version = excluded.version, updated_at = CURRENT_TIMESTAMP
	`, deviceID, userID, version)
	return err
}

func (r *Router) clearCurrentTabs(tx *sql.Tx, userID, deviceID string) error {
	query := `DELETE FROM tabs_current WHERE user_id = ? AND device_id = ?`
	_, err := tx.Exec(query, userID, deviceID)
	return err
}

func (r *Router) insertCurrentTab(tx *sql.Tx, tab *models.TabCurrent) error {
	query := `INSERT INTO tabs_current 
		(id, user_id, device_id, tab_id_hash, url, title, favicon_url, window_id, pinned, discarded, last_active_at, updated_at, version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := tx.Exec(query, tab.ID, tab.UserID, tab.DeviceID, tab.TabIDHash, tab.URL, tab.Title, tab.FaviconURL,
		tab.WindowID, tab.Pinned, tab.Discarded, tab.LastActiveAt, tab.UpdatedAt, tab.Version)
	return err
}

func (r *Router) insertTabHistory(tx *sql.Tx, history *models.TabHistory) error {
	query := `INSERT INTO tab_history 
		(id, user_id, device_id, event_type, url, title, favicon_url, window_id, tab_correlation_id, occurred_at, size_bytes, update_triggers)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := tx.Exec(query, history.ID, history.UserID, history.DeviceID, history.EventType, history.URL,
		history.Title, history.FaviconURL, history.WindowID, history.TabCorrelationID, history.OccurredAt, history.SizeBytes, history.UpdateTriggers)
	return err
}

func (r *Router) processTabCreateUpdate(tx *sql.Tx, userID, deviceID, tabIDHash string, event *models.TabEvent) (int64, error) {
	// For MVP, we'll update the current tabs table with the latest info
	query := `INSERT OR REPLACE INTO tabs_current 
		(id, user_id, device_id, tab_id_hash, url, title, favicon_url, window_id, pinned, discarded, last_active_at, updated_at, version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	
	version, err := r.getNextVersion(tx, userID)
	if err != nil {
		return 0, err
	}
	
	_, err = tx.Exec(query, uuid.New().String(), userID, deviceID, tabIDHash, event.URL, event.Title,
		event.FaviconURL, event.WindowID, false, false, event.OccurredAt, time.Now(), version)
	return version, err
}

func (r *Router) getCurrentTabByHash(tx *sql.Tx, userID, deviceID, tabIDHash string) (*models.TabCurrent, error) {
	query := `
		SELECT id, user_id, device_id, tab_id_hash, url, title, favicon_url, window_id, pinned, discarded,
		       last_active_at, updated_at, version
		FROM tabs_current
		WHERE user_id = ? AND device_id = ? AND tab_id_hash = ?
		LIMIT 1
	`
	var tab models.TabCurrent
	err := tx.QueryRow(query, userID, deviceID, tabIDHash).Scan(
		&tab.ID, &tab.UserID, &tab.DeviceID, &tab.TabIDHash, &tab.URL, &tab.Title, &tab.FaviconURL,
		&tab.WindowID, &tab.Pinned, &tab.Discarded, &tab.LastActiveAt, &tab.UpdatedAt, &tab.Version,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &tab, nil
}

// insertStaleEventHistory records the *rejected* event as a conflict so the
// options UI can surface it to the user.  This is the inverse of the old
// behaviour (which logged the existing/winning state); storing the loser
// makes "recent conflicts" more actionable because the user can see what
// didn't apply and retry if needed.
func (r *Router) insertStaleEventHistory(tx *sql.Tx, userID, deviceID string, event *models.TabEvent) error {
	historyEntry := &models.TabHistory{
		ID:               uuid.New().String(),
		UserID:           userID,
		DeviceID:         deviceID,
		EventType:        "conflict",
		URL:              event.URL,
		Title:            event.Title,
		FaviconURL:       event.FaviconURL,
		WindowID:         event.WindowID,
		TabCorrelationID: event.TabCorrelationID,
		OccurredAt:       event.OccurredAt,
		SizeBytes:        r.estimateEventSize(event),
		UpdateTriggers:   event.UpdateTriggers,
	}
	return r.insertTabHistory(tx, historyEntry)
}

func (r *Router) processTabClose(tx *sql.Tx, userID, deviceID string, event *models.TabEvent) error {
	tabIDHash := event.TabCorrelationID
	if tabIDHash == "" {
		tabIDHash = r.generateTabIDHash(event.URL, event.WindowID)
	}

	query := `DELETE FROM tabs_current WHERE user_id = ? AND device_id = ? AND tab_id_hash = ?`
	_, err := tx.Exec(query, userID, deviceID, tabIDHash)
	return err
}

func (r *Router) estimateEventSize(event *models.TabEvent) int64 {
	size := int64(len(event.URL) + len(event.Title) + len(event.FaviconURL) + len(event.UpdateTriggers) + 50) // 50 bytes overhead
	return size
}

// tabHistoryDedupeWindow: same tab + same URL + same event type from multiple
// tabs.onUpdated calls (e.g. status:loading, status:complete, title) should collapse
// to one history row. 2s was too short for slow pages and the >= boundary let pairs
// exactly 2.0s apart through as duplicates.
const tabHistoryDedupeWindow = 6 * time.Second

// shouldRecordHistoryBackfill avoids duplicate rows when the client retries
// overlapping browser-history windows, and also prevents backfill rows from
// duplicating tab-event rows (create/update) for the same URL.
func (r *Router) shouldRecordHistoryBackfill(tx *sql.Tx, userID, deviceID string, event *models.TabEvent) (bool, error) {
	u := strings.TrimSpace(event.URL)
	if u == "" {
		return false, nil
	}
	var lastAt time.Time
	err := tx.QueryRow(`
		SELECT occurred_at FROM tab_history
		WHERE user_id = ? AND device_id = ? AND url = ? AND event_type IN ('history', 'create', 'update')
		ORDER BY occurred_at DESC LIMIT 1
	`, userID, deviceID, u).Scan(&lastAt)
	if err == sql.ErrNoRows {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if !lastAt.IsZero() && event.OccurredAt.Sub(lastAt) < 30*time.Second {
		return false, nil
	}
	return true, nil
}

// shouldRecordTabHistory returns false when the same tab (correlation id) just got
// the same URL+event_type within tabHistoryDedupeWindow.
func (r *Router) shouldRecordTabHistory(tx *sql.Tx, userID, deviceID string, event *models.TabEvent) (bool, error) {
	switch event.EventType {
	case "history":
		return r.shouldRecordHistoryBackfill(tx, userID, deviceID, event)
	case "create", "update":
	default:
		return true, nil
	}
	cid := strings.TrimSpace(event.TabCorrelationID)
	if cid == "" {
		return true, nil
	}
	var lastAt time.Time
	var lastURL, lastType string
	err := tx.QueryRow(`
		SELECT occurred_at, url, event_type FROM tab_history
		WHERE user_id = ? AND device_id = ? AND tab_correlation_id = ?
		ORDER BY occurred_at DESC LIMIT 1
	`, userID, deviceID, cid).Scan(&lastAt, &lastURL, &lastType)
	if err == sql.ErrNoRows {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(lastURL) != strings.TrimSpace(event.URL) {
		return true, nil
	}
	if lastType != event.EventType {
		return true, nil
	}
	// Suppress near-duplicate: keep first row, skip if next arrives within the window
	if !lastAt.IsZero() && event.OccurredAt.Sub(lastAt) < tabHistoryDedupeWindow {
		return false, nil
	}
	return true, nil
}

func (r *Router) updateQuotaUsage(tx *sql.Tx, userID string, additionalBytes int64) error {
	query := `UPDATE users SET quota_used_bytes = quota_used_bytes + ? WHERE id = ?`
	_, err := tx.Exec(query, additionalBytes, userID)
	return err
}

func (r *Router) getQuotaStatus(tx *sql.Tx, userID string) (*models.QuotaStatus, error) {
	query := `SELECT quota_used_bytes, quota_limit_mb FROM users WHERE id = ?`
	var usedBytes, limitMB int64
	err := tx.QueryRow(query, userID).Scan(&usedBytes, &limitMB)
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

func (r *Router) pruneHistoryToQuota(tx *sql.Tx, userID string) error {
	// Fetch current usage and limit
	query := `SELECT quota_used_bytes, quota_limit_mb FROM users WHERE id = ?`
	var usedBytes, limitMB int64
	if err := tx.QueryRow(query, userID).Scan(&usedBytes, &limitMB); err != nil {
		return err
	}

	limitBytes := limitMB * 1024 * 1024
	if usedBytes <= limitBytes {
		return nil
	}

	excess := usedBytes - limitBytes

	// Delete oldest history entries until under limit
	for excess > 0 {
		row := tx.QueryRow(`SELECT id, size_bytes FROM tab_history WHERE user_id = ? ORDER BY occurred_at ASC LIMIT 1`, userID)
		var id string
		var sizeBytes int64
		if err := row.Scan(&id, &sizeBytes); err != nil {
			return err
		}

		if _, err := tx.Exec(`DELETE FROM tab_history WHERE id = ?`, id); err != nil {
			return err
		}

		excess -= sizeBytes
		usedBytes -= sizeBytes
	}

	_, err := tx.Exec(`UPDATE users SET quota_used_bytes = ? WHERE id = ?`, usedBytes, userID)
	return err
}

func (r *Router) getCurrentTabsForUser(userID string, sinceVersion int64) ([]models.TabSnapshot, error) {
	// Omit revoked devices so /tabs/current matches GET /devices (active only).
	// Stale tabs_current rows for old pairings would otherwise look like duplicate machines.
	query := `
		SELECT d.id, d.browser, d.device_name, COALESCE(dv.version, 0) as version
		FROM devices d
		LEFT JOIN device_versions dv ON d.id = dv.device_id
		WHERE d.user_id = ? AND COALESCE(dv.version, 0) > ? AND d.revoked_at IS NULL
		ORDER BY COALESCE(dv.version, 0) DESC
	`

	rows, err := r.db.Query(query, userID, sinceVersion)
	if err != nil {
		return nil, err
	}
	type devRow struct {
		id, browser, name string
		ver                 int64
	}
	var pending []devRow
	for rows.Next() {
		var d devRow
		if err := rows.Scan(&d.id, &d.browser, &d.name, &d.ver); err != nil {
			_ = rows.Close()
			return nil, err
		}
		pending = append(pending, d)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	// getTabsForDevice issues another Query. With a single SQLite connection
	// in the pool, the outer rows must be closed first or we deadlock.
	var devices []models.TabSnapshot
	for _, d := range pending {
		tabs, err := r.getTabsForDevice(d.id)
		if err != nil {
			return nil, err
		}
		devices = append(devices, models.TabSnapshot{
			DeviceID:   d.id,
			Browser:    d.browser,
			DeviceName: d.name,
			Version:    d.ver,
			Tabs:       tabs,
		})
	}

	return devices, nil
}

func (r *Router) getTabsForDevice(deviceID string) ([]models.TabInfo, error) {
	query := `
		SELECT tab_id_hash, url, title, favicon_url, window_id, pinned, discarded, last_active_at
		FROM tabs_current
		WHERE device_id = ?
		ORDER BY window_id, last_active_at DESC
	`

	rows, err := r.db.Query(query, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tabs []models.TabInfo
	for rows.Next() {
		var tab models.TabInfo
		if err := rows.Scan(
			&tab.TabIDHash, &tab.URL, &tab.Title, &tab.FaviconURL, &tab.WindowID,
			&tab.Pinned, &tab.Discarded, &tab.LastActiveAt,
		); err != nil {
			return nil, err
		}
		tabs = append(tabs, tab)
	}

	return tabs, nil
}
