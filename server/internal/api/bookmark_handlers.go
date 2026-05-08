package api

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"keepsync-server/internal/models"
)

// getBookmarks handles GET /bookmarks
func (r *Router) getBookmarks(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("getBookmarks: begin: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	version, err := r.loadBookmarkVersion(tx, userID)
	if err != nil {
		log.Printf("getBookmarks: version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	nodes, err := r.loadBookmarkNodes(tx, userID)
	if err != nil {
		log.Printf("getBookmarks: nodes: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, models.BookmarksResponse{Version: version, Nodes: nodes})
}

// putBookmarks handles PUT /bookmarks (full tree replace, optimistic version).
func (r *Router) putBookmarks(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	var body models.BookmarksPutRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeError(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("putBookmarks: begin: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	_, _ = tx.Exec(`INSERT OR IGNORE INTO bookmark_state (user_id, version) VALUES (?, 0)`, userID)
	var serverVer int64
	if err := tx.QueryRow(`SELECT version FROM bookmark_state WHERE user_id = ?`, userID).Scan(&serverVer); err != nil {
		log.Printf("putBookmarks: load version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if body.BaseVersion != nil && *body.BaseVersion != serverVer {
		nodes, _ := r.loadBookmarkNodes(tx, userID)
		writeJSONStatus(w, http.StatusConflict, models.BookmarksConflictResponse{
			Error:         "version_conflict",
			ServerVersion: serverVer,
			BaseVersion:   *body.BaseVersion,
			Nodes:         nodes,
			Hint:          "GET /bookmarks then merge and retry with base_version = server version",
		})
		return
	}

	if _, err := tx.Exec(`DELETE FROM bookmark_nodes WHERE user_id = ?`, userID); err != nil {
		log.Printf("putBookmarks: delete: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	for _, n := range body.Nodes {
		if strings.TrimSpace(n.ID) == "" {
			continue
		}
		var p sql.NullString
		if n.ParentID != nil && strings.TrimSpace(*n.ParentID) != "" {
			p = sql.NullString{String: strings.TrimSpace(*n.ParentID), Valid: true}
		}
		var u sql.NullString
		if n.URL != nil {
			trim := strings.TrimSpace(*n.URL)
			if trim != "" {
				u = sql.NullString{String: trim, Valid: true}
			}
		}
		_, err := tx.Exec(`
			INSERT INTO bookmark_nodes (id, user_id, parent_id, title, url, position)
			VALUES (?, ?, ?, ?, ?, ?)`,
			strings.TrimSpace(n.ID), userID, p, n.Title, u, n.Position,
		)
		if err != nil {
			log.Printf("putBookmarks: insert node: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
	}

	newVer := serverVer + 1
	if _, err := tx.Exec(`UPDATE bookmark_state SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, newVer, userID); err != nil {
		log.Printf("putBookmarks: bump version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]int64{"version": newVer})
}

func (r *Router) loadBookmarkVersion(tx *sql.Tx, userID string) (int64, error) {
	var v int64
	err := tx.QueryRow(`SELECT version FROM bookmark_state WHERE user_id = ?`, userID).Scan(&v)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return v, err
}

func (r *Router) loadBookmarkNodes(tx *sql.Tx, userID string) ([]models.BookmarkNode, error) {
	rows, err := tx.Query(`
		SELECT id, parent_id, title, url, position FROM bookmark_nodes
		WHERE user_id = ? ORDER BY position ASC, title ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.BookmarkNode
	for rows.Next() {
		var id, title string
		var parentID, url sql.NullString
		var pos int
		if err := rows.Scan(&id, &parentID, &title, &url, &pos); err != nil {
			return nil, err
		}
		n := models.BookmarkNode{ID: id, Title: title, Position: pos}
		if parentID.Valid && parentID.String != "" {
			p := parentID.String
			n.ParentID = &p
		}
		if url.Valid && url.String != "" {
			s := url.String
			n.URL = &s
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
