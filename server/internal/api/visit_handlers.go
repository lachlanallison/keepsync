package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"keepsync-server/internal/models"
)

const visitSessionGap = 30 * time.Minute

// getHistoryVisits handles GET /history/visits — aggregates tab_history into visit sessions.
func (r *Router) getHistoryVisits(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	q := req.URL.Query()
	deviceID := strings.TrimSpace(q.Get("device_id"))
	from := strings.TrimSpace(q.Get("from"))
	to := strings.TrimSpace(q.Get("to"))
	search := strings.ToLower(strings.TrimSpace(q.Get("search")))
	limit := 200
	if l := q.Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}

	query := `
		SELECT device_id, event_type, url, title, tab_correlation_id, occurred_at
		FROM tab_history
		WHERE user_id = ?
		  AND event_type IN ('create', 'update')
		  AND url != '' AND url IS NOT NULL
	`
	args := []interface{}{userID}
	if deviceID != "" {
		query += " AND device_id = ?"
		args = append(args, deviceID)
	}
	if from != "" {
		query += " AND occurred_at >= ?"
		args = append(args, from)
	}
	if to != "" {
		query += " AND occurred_at <= ?"
		args = append(args, to)
	}
	query += " ORDER BY occurred_at ASC"

	rows, err := r.db.Query(query, args...)
	if err != nil {
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var events []historyEventRow
	for rows.Next() {
		var d, et, u, tit, cid string
		var at time.Time
		if err := rows.Scan(&d, &et, &u, &tit, &cid, &at); err != nil {
			continue
		}
		events = append(events, historyEventRow{
			Device: d, URL: strings.TrimSpace(u), Title: tit, Corr: cid, At: at, EvtType: et,
		})
	}
	if err := rows.Err(); err != nil {
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	visits := mergeEventsIntoVisits(events, visitSessionGap, search, limit)
	writeJSON(w, models.VisitsResponse{Visits: visits, NextCursor: ""})
}

type historyEventRow struct {
	Device  string
	URL     string
	Title   string
	Corr    string
	At      time.Time
	EvtType string
}

func mergeEventsIntoVisits(events []historyEventRow, gap time.Duration, search string, limit int) []models.HistoryVisit {
	var out []models.HistoryVisit
	if len(events) == 0 {
		return out
	}
	var cur *models.HistoryVisit
	flush := func() {
		if cur == nil {
			return
		}
		if visitMatchesSearch(cur, search) {
			out = append(out, *cur)
		}
		cur = nil
	}

	for i := range events {
		e := &events[i]
		u := strings.TrimSpace(e.URL)
		if u == "" {
			continue
		}
		if cur == nil {
			t := e.Title
			if strings.TrimSpace(t) == "" {
				t = u
			}
			v := &models.HistoryVisit{
				DeviceID:         e.Device,
				URL:              u,
				Title:            t,
				FirstOccurredAt:  e.At,
				LastOccurredAt:   e.At,
				EventCount:       1,
				TabCorrelationID: e.Corr,
			}
			cur = v
			continue
		}
		sameURL := cur.URL == u
		gapOK := e.At.Sub(cur.LastOccurredAt) <= gap
		// same device for continuity; cross-device same URL+time still separate
		sameDevice := cur.DeviceID == e.Device
		if sameURL && gapOK && sameDevice {
			cur.LastOccurredAt = e.At
			cur.EventCount++
			if strings.TrimSpace(e.Title) != "" {
				cur.Title = e.Title
			}
			if e.Corr != "" {
				cur.TabCorrelationID = e.Corr
			}
		} else {
			flush()
			t := e.Title
			if strings.TrimSpace(t) == "" {
				t = u
			}
			cur = &models.HistoryVisit{
				DeviceID:         e.Device,
				URL:              u,
				Title:            t,
				FirstOccurredAt:  e.At,
				LastOccurredAt:   e.At,
				EventCount:       1,
				TabCorrelationID: e.Corr,
			}
		}
	}
	flush()

	if limit > 0 && len(out) > limit {
		// return newest first for UI (reverse)
		rev := make([]models.HistoryVisit, 0, limit)
		for i := len(out) - 1; i >= 0 && len(rev) < limit; i-- {
			rev = append(rev, out[i])
		}
		return rev
	}
	// reverse to newest first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func visitMatchesSearch(v *models.HistoryVisit, search string) bool {
	if search == "" {
		return true
	}
	return strings.Contains(strings.ToLower(v.URL), search) || strings.Contains(strings.ToLower(v.Title), search)
}
