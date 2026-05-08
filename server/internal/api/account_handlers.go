package api

import (
	"log"
	"net/http"
)

// purgeSyncedData removes all sync payloads for the authenticated user:
// tab history, live tabs, bookmarks, and version counters (not the user row or devices).
func (r *Router) purgeSyncedData(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())

	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("purgeSyncedData: begin: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM tab_history WHERE user_id = ?`, userID); err != nil {
		log.Printf("purgeSyncedData: tab_history: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if _, err := tx.Exec(`DELETE FROM tabs_current WHERE user_id = ?`, userID); err != nil {
		log.Printf("purgeSyncedData: tabs_current: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if _, err := tx.Exec(`DELETE FROM bookmark_nodes WHERE user_id = ?`, userID); err != nil {
		log.Printf("purgeSyncedData: bookmark_nodes: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if _, err := tx.Exec(`DELETE FROM bookmark_state WHERE user_id = ?`, userID); err != nil {
		log.Printf("purgeSyncedData: bookmark_state: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if _, err := tx.Exec(`UPDATE user_versions SET version = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, userID); err != nil {
		log.Printf("purgeSyncedData: user_versions: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if _, err := tx.Exec(`UPDATE device_versions SET version = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, userID); err != nil {
		log.Printf("purgeSyncedData: device_versions: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if _, err := tx.Exec(`UPDATE users SET quota_used_bytes = 0 WHERE id = ?`, userID); err != nil {
		log.Printf("purgeSyncedData: users quota: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(); err != nil {
		log.Printf("purgeSyncedData: commit: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"message": "Synced server data deleted"})
}
