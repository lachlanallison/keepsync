package models

import (
	"time"
)

// User represents a user in the system
type User struct {
	ID            string    `json:"id" db:"id"`
	Email         string    `json:"email,omitempty" db:"email"`
	CreatedAt     time.Time `json:"created_at" db:"created_at"`
	QuotaLimitMB  int64     `json:"quota_limit_mb" db:"quota_limit_mb"`
	QuotaUsedBytes int64     `json:"quota_used_bytes" db:"quota_used_bytes"`
}

// Device represents a browser/device registered to a user
type Device struct {
	ID         string     `json:"id" db:"id"`
	UserID     string     `json:"user_id" db:"user_id"`
	Browser    string     `json:"browser" db:"browser"` // chrome, firefox
	DeviceName string     `json:"device_name" db:"device_name"`
	CreatedAt  time.Time  `json:"created_at" db:"created_at"`
	LastSeenAt time.Time  `json:"last_seen_at" db:"last_seen_at"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty" db:"revoked_at"`
}

// TabCurrent represents the current state of tabs for a device
type TabCurrent struct {
	ID           string     `json:"id" db:"id"`
	UserID       string     `json:"user_id" db:"user_id"`
	DeviceID     string     `json:"device_id" db:"device_id"`
	TabIDHash    string     `json:"tab_id_hash" db:"tab_id_hash"` // Hash of browser's internal tab ID
	URL          string     `json:"url" db:"url"`
	Title        string     `json:"title" db:"title"`
	FaviconURL   string     `json:"favicon_url" db:"favicon_url"`
	WindowID     int        `json:"window_id" db:"window_id"`
	Pinned       bool       `json:"pinned" db:"pinned"`
	Discarded    bool       `json:"discarded" db:"discarded"`
	LastActiveAt time.Time  `json:"last_active_at" db:"last_active_at"`
	UpdatedAt    time.Time  `json:"updated_at" db:"updated_at"`
	Version      int64      `json:"version" db:"version"`
}

// TabHistory represents historical tab events (append-only)
type TabHistory struct {
	ID                string    `json:"id" db:"id"`
	UserID           string    `json:"user_id" db:"user_id"`
	DeviceID         string    `json:"device_id" db:"device_id"`
	EventType        string    `json:"event_type" db:"event_type"` // create, update, close, history, conflict (not focus)
	URL              string    `json:"url" db:"url"`
	Title            string    `json:"title" db:"title"`
	FaviconURL       string    `json:"favicon_url" db:"favicon_url"`
	WindowID         int       `json:"window_id" db:"window_id"`
	TabCorrelationID string    `json:"tab_correlation_id" db:"tab_correlation_id"`
	OccurredAt       time.Time `json:"occurred_at" db:"occurred_at"`
	SizeBytes        int64     `json:"size_bytes" db:"size_bytes"` // Estimated storage size
	// UpdateTriggers: browser onUpdated changeInfo keys, e.g. "status,url,title" (client-side).
	UpdateTriggers   string    `json:"update_triggers,omitempty" db:"update_triggers"`
}

// AuthToken represents authentication tokens for devices
type AuthToken struct {
	ID        string    `json:"id" db:"id"`
	UserID    string    `json:"user_id" db:"user_id"`
	DeviceID  string    `json:"device_id,omitempty" db:"device_id"`
	Type      string    `json:"type" db:"type"` // device, magic, pairing
	TokenHash string    `json:"-" db:"token_hash"` // Never expose in JSON
	ExpiresAt time.Time `json:"expires_at" db:"expires_at"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
	Revoked   bool      `json:"revoked" db:"revoked"`
}

// TabSnapshot represents a full snapshot of tabs for uploading/downloading
type TabSnapshot struct {
	DeviceID string    `json:"device_id"`
	Browser  string    `json:"browser"`
	DeviceName string  `json:"device_name,omitempty"`
	Version  int64     `json:"version"`
	Tabs     []TabInfo `json:"tabs"`
}

// TabInfo represents individual tab information for API transfers
type TabInfo struct {
	// TabIDHash is the stable id for this row in tabs_current; matches
	// tab_correlation_id on events from the same browser tab (same tab id, any URL).
	TabIDHash    string    `json:"tab_id_hash,omitempty"`
	// TabID is the browser's tab id (e.g. chrome.tabs / browser.tabs). Required
	// to disambiguate two tabs with the same URL in the same window; omit only
	// in legacy clients (server will fall back with in-batch de-dupe).
	TabID        int       `json:"tab_id"`
	URL          string    `json:"url"`
	Title        string    `json:"title"`
	FaviconURL   string    `json:"favicon_url,omitempty"`
	WindowID     int       `json:"window_id"`
	Pinned       bool      `json:"pinned"`
	Discarded    bool      `json:"discarded"`
	LastActiveAt time.Time `json:"last_active_at"`
}

// TabEvent represents a tab change event
type TabEvent struct {
	EventType        string    `json:"event_type"` // create, update, close, focus, history
	URL              string    `json:"url"`
	Title            string    `json:"title"`
	FaviconURL       string    `json:"favicon_url,omitempty"`
	WindowID         int       `json:"window_id"`
	TabCorrelationID string    `json:"tab_correlation_id"`
	// ClientTabID is the browser’s tabs.Tab.id (optional, for server debug logs only).
	ClientTabID      int       `json:"client_tab_id,omitempty"`
	OccurredAt       time.Time `json:"occurred_at"`
	UpdateTriggers   string    `json:"update_triggers,omitempty"`
}

// QuotaStatus represents current quota usage
type QuotaStatus struct {
	Status     string `json:"status"` // ok, warn, prune
	UsageMB    int64  `json:"usage_mb"`
	LimitMB    int64  `json:"limit_mb"`
	UsageBytes int64  `json:"usage_bytes"`
	// Tab history breakdown (sum of size_bytes should match usage_bytes when
	// accounting is in sync; diverge if legacy drift or pre-fix over-count).
	TabHistoryCount    int64               `json:"tab_history_count,omitempty"`
	TabHistoryBytesSum int64               `json:"tab_history_bytes_sum,omitempty"`
	AvgEventBytes      int64               `json:"avg_event_bytes,omitempty"`
	RecentEvents       []QuotaHistoryEvent `json:"recent_events,omitempty"`
}

// QuotaHistoryEvent is a small sample of stored history rows for diagnostics.
type QuotaHistoryEvent struct {
	OccurredAt string `json:"occurred_at"`
	EventType  string `json:"event_type"`
	SizeBytes  int64  `json:"size_bytes"`
	URL        string `json:"url"`
}

// DeviceListResponse represents the response for device listing
type DeviceListResponse struct {
	Devices []Device `json:"devices"`
}

// TabsCurrentResponse represents the response for current tabs
type TabsCurrentResponse struct {
	Devices []TabSnapshot `json:"devices"`
}

// HistoryResponse represents paginated history response
type HistoryResponse struct {
	Items      []TabHistory `json:"items"`
	NextCursor string       `json:"next_cursor,omitempty"`
}

// TabHistorySession is one logical tab lifetime aggregated from tab_history
// joined with whether the tab still appears in tabs_current.
type TabHistorySession struct {
	DeviceID         string     `json:"device_id"`
	TabCorrelationID string     `json:"tab_correlation_id"`
	Title            string     `json:"title"`
	URL              string     `json:"url"`
	OpenedAt         time.Time  `json:"opened_at"`
	LastActiveAt     time.Time  `json:"last_active_at"`
	ClosedAt         *time.Time `json:"closed_at,omitempty"`
	IsOpen           bool       `json:"is_open"`
	EventCount       int        `json:"event_count"`
	WindowID         int        `json:"window_id"`
}

// HistorySessionsResponse lists tab sessions for the options History table.
type HistorySessionsResponse struct {
	Sessions []TabHistorySession `json:"sessions"`
	Total    int                 `json:"total"`
	Limit    int                 `json:"limit"`
	Offset   int                 `json:"offset"`
}

// BookmarkNode is one row in the synced bookmark tree (folder or link).
// parent_id empty string = top-level; folders have url = nil/empty.
type BookmarkNode struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parentId,omitempty"`
	Title    string  `json:"title"`
	URL      *string `json:"url,omitempty"`
	Position int     `json:"position"`
}

// BookmarksResponse is the server bookmark tree + version.
type BookmarksResponse struct {
	Version int64            `json:"version"`
	Nodes   []BookmarkNode   `json:"nodes"`
}

// BookmarksPutRequest replaces the entire tree when base_version matches.
type BookmarksPutRequest struct {
	BaseVersion *int64           `json:"base_version,omitempty"`
	Nodes       []BookmarkNode  `json:"nodes"`
}

// BookmarksConflictResponse is returned with HTTP 409 for optimistic lock failure.
type BookmarksConflictResponse struct {
	Error         string           `json:"error"`
	ServerVersion int64            `json:"server_version"`
	BaseVersion   int64            `json:"base_version"`
	Nodes         []BookmarkNode  `json:"nodes"`
	Hint          string          `json:"hint,omitempty"`
}

// HistoryVisit is an aggregated "visit" session derived from tab_history.
type HistoryVisit struct {
	DeviceID           string    `json:"device_id"`
	URL                string    `json:"url"`
	Title              string    `json:"title"`
	FirstOccurredAt    time.Time `json:"first_occurred_at"`
	LastOccurredAt     time.Time `json:"last_occurred_at"`
	EventCount         int       `json:"event_count"`
	TabCorrelationID   string    `json:"tab_correlation_id,omitempty"`
}

// VisitsResponse lists merged visits for the browsing-history UI.
type VisitsResponse struct {
	Visits     []HistoryVisit `json:"visits"`
	NextCursor string         `json:"next_cursor,omitempty"`
}

// API Request/Response structures

// MagicLinkRequest represents magic link authentication request
type MagicLinkRequest struct {
	Email      string `json:"email"`
	DeviceName string `json:"device_name,omitempty"`
}

// ActivateRequest represents device activation request
type ActivateRequest struct {
	Token string `json:"token"`
}

// ActivateResponse represents device activation response
type ActivateResponse struct {
	DeviceToken string    `json:"device_token"`
	UserID      string    `json:"user_id"`
	DeviceID    string    `json:"device_id"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// PairingRequest represents device pairing request
type PairingRequest struct {
	PairingCode string `json:"pairing_code"`
	DeviceName  string `json:"device_name"`
}

// SnapshotRequest represents tab snapshot upload request.
//
// BaseVersion is optional. When > 0 the server enforces optimistic
// concurrency: the snapshot is only accepted if the user's current
// server-side version still matches BaseVersion. Legacy clients that
// omit the field (or send 0) continue to use last-writer-wins.
type SnapshotRequest struct {
	Version     int64     `json:"version"`
	BaseVersion int64     `json:"base_version,omitempty"`
	Tabs        []TabInfo `json:"tabs"`
}

// SnapshotResponse represents tab snapshot upload response
type SnapshotResponse struct {
	Acknowledged  bool        `json:"acknowledged"`
	ServerVersion int64       `json:"server_version"`
	QuotaStatus   QuotaStatus `json:"quota_status"`
}

// SnapshotConflictResponse is returned with HTTP 409 when base_version
// optimistic concurrency fails.  The client should pull /tabs/current to
// catch up before retrying.
type SnapshotConflictResponse struct {
	Error         string `json:"error"`
	ServerVersion int64  `json:"server_version"`
	BaseVersion   int64  `json:"base_version"`
	Hint          string `json:"hint,omitempty"`
}

// EventsRequest represents tab events upload request
type EventsRequest struct {
	Events []TabEvent `json:"events"`
}

// EventsResponse represents tab events upload response
type EventsResponse struct {
	Acknowledged     bool  `json:"acknowledged"`
	AppliedCount     int   `json:"applied_count"`
	ConflictsCreated int   `json:"conflicts_created"`
	ServerVersion    int64 `json:"server_version"`
}
