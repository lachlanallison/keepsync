package api

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"keepsync-server/internal/models"
)

// normalizeAggregatedHistoryTimestamp converts SQLite / driver text like
// "2006-01-02 15:04:05.534 +0000 UTC" into RFC3339-compatible UTC for Parse.
func normalizeAggregatedHistoryTimestamp(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	const suf = " +0000 UTC"
	if strings.HasSuffix(s, suf) {
		core := strings.TrimSuffix(s, suf)
		if i := strings.IndexByte(core, ' '); i > 0 && i < len(core)-1 {
			return core[:i] + "T" + strings.TrimSpace(core[i+1:]) + "Z"
		}
	}
	return s
}

// SQLite MIN/MAX on DATETIME often surface as TEXT to the driver; scan as string and parse.
func parseAggregatedHistoryTime(ns sql.NullString) (time.Time, error) {
	if !ns.Valid {
		return time.Time{}, fmt.Errorf("null timestamp")
	}
	raw := strings.TrimSpace(ns.String)
	if raw == "" {
		return time.Time{}, fmt.Errorf("empty timestamp")
	}
	norm := normalizeAggregatedHistoryTimestamp(raw)
	candidates := []string{norm, raw}
	seen := make(map[string]struct{})
	var uniq []string
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, ok := seen[c]; ok {
			continue
		}
		seen[c] = struct{}{}
		uniq = append(uniq, c)
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05.999999999 -07:00",
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05.999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	}
	var lastErr error
	for _, cand := range uniq {
		for _, layout := range layouts {
			if t, err := time.Parse(layout, cand); err == nil {
				return t, nil
			} else {
				lastErr = err
			}
		}
	}
	return time.Time{}, fmt.Errorf("parse time %q: %w", raw, lastErr)
}

func parseOptionalAggregatedHistoryTime(ns sql.NullString) (*time.Time, error) {
	if !ns.Valid || strings.TrimSpace(ns.String) == "" {
		return nil, nil
	}
	t, err := parseAggregatedHistoryTime(ns)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// getHistorySessions aggregates tab_history into logical tab sessions with open/closed semantics.
func (r *Router) getHistorySessions(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	q := req.URL.Query()
	deviceID := strings.TrimSpace(q.Get("device_id"))
	status := strings.TrimSpace(q.Get("status")) // all | open | closed
	titleQ := strings.TrimSpace(q.Get("title"))
	urlQ := strings.TrimSpace(q.Get("url"))
	openedFrom := strings.TrimSpace(q.Get("opened_from"))
	openedTo := strings.TrimSpace(q.Get("opened_to"))
	closedFrom := strings.TrimSpace(q.Get("closed_from"))
	closedTo := strings.TrimSpace(q.Get("closed_to"))
	sort := strings.TrimSpace(q.Get("sort"))

	limit := 100
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	offset := 0
	if v := q.Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 100000 {
			offset = n
		}
	}

	order := "z.opened_at DESC"
	switch sort {
	case "opened_asc":
		order = "z.opened_at ASC"
	case "last_active_desc":
		order = "z.last_active_at DESC"
	case "last_active_asc":
		order = "z.last_active_at ASC"
	case "closed_desc":
		order = "z.closed_at DESC"
	case "closed_asc":
		order = "z.closed_at ASC"
	}

	innerWhere := "WHERE t.user_id = ?"
	args := []interface{}{userID}
	if deviceID != "" {
		innerWhere += " AND t.device_id = ?"
		args = append(args, deviceID)
	}

	aggSQL := `
SELECT
  t.device_id,
  t.tab_correlation_id,
  MIN(t.occurred_at) AS opened_at,
  COALESCE(MAX(CASE WHEN t.event_type != 'close' THEN t.occurred_at END), MIN(t.occurred_at)) AS last_active_at,
  MAX(CASE WHEN t.event_type = 'close' THEN t.occurred_at END) AS closed_at,
  COUNT(*) AS event_count,
  (SELECT title FROM tab_history x WHERE x.user_id = t.user_id AND x.device_id = t.device_id AND x.tab_correlation_id = t.tab_correlation_id ORDER BY x.occurred_at DESC LIMIT 1) AS title,
  (SELECT url FROM tab_history x WHERE x.user_id = t.user_id AND x.device_id = t.device_id AND x.tab_correlation_id = t.tab_correlation_id ORDER BY x.occurred_at DESC LIMIT 1) AS url,
  (SELECT window_id FROM tab_history x WHERE x.user_id = t.user_id AND x.device_id = t.device_id AND x.tab_correlation_id = t.tab_correlation_id ORDER BY x.occurred_at DESC LIMIT 1) AS window_id
FROM tab_history t
` + innerWhere + `
GROUP BY t.user_id, t.device_id, t.tab_correlation_id`

	// EXISTS placeholder first in outer SELECT, then inner subquery uses args from innerWhere.
	outer := `SELECT z.* FROM (
  SELECT agg.*,
    EXISTS (SELECT 1 FROM tabs_current c WHERE c.user_id = ? AND c.device_id = agg.device_id AND c.tab_id_hash = agg.tab_correlation_id) AS is_open
  FROM (` + aggSQL + `) AS agg
) AS z WHERE 1=1`

	queryArgs := []interface{}{userID}
	queryArgs = append(queryArgs, args...)

	if titleQ != "" {
		outer += " AND z.title LIKE ?"
		queryArgs = append(queryArgs, "%"+titleQ+"%")
	}
	if urlQ != "" {
		outer += " AND z.url LIKE ?"
		queryArgs = append(queryArgs, "%"+urlQ+"%")
	}
	if openedFrom != "" {
		outer += " AND z.opened_at >= ?"
		queryArgs = append(queryArgs, openedFrom)
	}
	if openedTo != "" {
		outer += " AND z.opened_at <= ?"
		queryArgs = append(queryArgs, openedTo)
	}
	if closedFrom != "" {
		outer += " AND z.closed_at IS NOT NULL AND z.closed_at >= ?"
		queryArgs = append(queryArgs, closedFrom)
	}
	if closedTo != "" {
		outer += " AND z.closed_at IS NOT NULL AND z.closed_at <= ?"
		queryArgs = append(queryArgs, closedTo)
	}
	switch status {
	case "open":
		outer += " AND z.is_open = 1"
	case "closed":
		outer += " AND z.is_open = 0"
	}

	countQuery := "SELECT COUNT(1) FROM (" + outer + ")"
	var total int
	if err := r.db.QueryRow(countQuery, queryArgs...).Scan(&total); err != nil {
		log.Printf("getHistorySessions count: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	dataQuery := outer + " ORDER BY " + order + " LIMIT ? OFFSET ?"
	dataArgs := append(append([]interface{}{}, queryArgs...), limit, offset)

	rows, err := r.db.Query(dataQuery, dataArgs...)
	if err != nil {
		log.Printf("getHistorySessions query: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var sessions []models.TabHistorySession
	for rows.Next() {
		var s models.TabHistorySession
		var title, url sql.NullString
		var openedNS, lastNS, closedNS sql.NullString
		if err := rows.Scan(
			&s.DeviceID, &s.TabCorrelationID, &openedNS, &lastNS, &closedNS,
			&s.EventCount, &title, &url, &s.WindowID, &s.IsOpen,
		); err != nil {
			log.Printf("getHistorySessions scan: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
		openedAt, err := parseAggregatedHistoryTime(openedNS)
		if err != nil {
			log.Printf("getHistorySessions opened_at: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
		s.OpenedAt = openedAt
		lastAt, err := parseAggregatedHistoryTime(lastNS)
		if err != nil {
			log.Printf("getHistorySessions last_active_at: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
		s.LastActiveAt = lastAt
		closedPtr, err := parseOptionalAggregatedHistoryTime(closedNS)
		if err != nil {
			log.Printf("getHistorySessions closed_at: %v", err)
			writeError(w, "Database error", http.StatusInternalServerError)
			return
		}
		s.ClosedAt = closedPtr
		if title.Valid {
			s.Title = title.String
		}
		if url.Valid {
			s.URL = url.String
		}
		sessions = append(sessions, s)
	}
	if err := rows.Err(); err != nil {
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, models.HistorySessionsResponse{
		Sessions: sessions,
		Total:    total,
		Limit:    limit,
		Offset:   offset,
	})
}
