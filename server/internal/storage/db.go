package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// DB wraps the database connection
type DB struct {
	*sql.DB
}

// NewDB creates a new database connection
func NewDB(databaseURL string) (*DB, error) {
	// Create directory if it doesn't exist (for SQLite)
	if filepath.Ext(databaseURL) == ".db" {
		dir := filepath.Dir(databaseURL)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create data directory: %w", err)
		}
	}

	// WAL + long busy_timeout: concurrent request bursts (snapshot, history,
	// /tabs/current) would otherwise return SQLITE_BUSY while another writer
	// holds a transaction.  Single open connection (below) also matches how
	// Go apps typically use a single on-disk SQLite file.
	dsn := databaseURL + "?_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(1)" +
		"&_pragma=busy_timeout(10000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// With multiple pooled connections, separate writers from different
	// requests can all hit SQLITE_BUSY at once. One connection serializes
	// access; WAL + busy_timeout still help when long writes overlap.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	// Test connection
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &DB{db}, nil
}

// Migrate runs all database migrations. The CREATE TABLE statements are
// idempotent (IF NOT EXISTS) so running this repeatedly is safe. Column
// additions are performed via addColumnIfMissing which silently ignores the
// "duplicate column" error SQLite returns when the column already exists.
func Migrate(db *DB) error {
	migrations := []string{
		createUsersTable,
		createUserVersionsTable,
		createDevicesTable,
		createDeviceVersionsTable,
		createTabsCurrentTable,
		createTabHistoryTable,
		createAuthTokensTable,
		createBookmarkStateTable,
		createBookmarkNodesTable,
		createIndices,
	}

	for i, migration := range migrations {
		if _, err := db.Exec(migration); err != nil {
			return fmt.Errorf("failed to run migration %d: %w", i+1, err)
		}
	}

	// Additive column migrations.  SQLite doesn't support `ADD COLUMN IF NOT
	// EXISTS`, so we apply them one by one and swallow the duplicate-column
	// error.  Keep this list append-only.
	additive := []struct {
		table, column, def string
	}{
		{"devices", "revoked_at", "DATETIME"},
		{"tab_history", "update_triggers", "TEXT"},
	}
	for _, a := range additive {
		if err := addColumnIfMissing(db, a.table, a.column, a.def); err != nil {
			return fmt.Errorf("failed to add %s.%s: %w", a.table, a.column, err)
		}
	}

	return nil
}

// addColumnIfMissing issues `ALTER TABLE ... ADD COLUMN` but tolerates the
// column already existing.  We detect that case by matching the SQLite error
// text, which is the stable way to do it with modernc.org/sqlite.
func addColumnIfMissing(db *DB, table, column, def string) error {
	stmt := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, def)
	if _, err := db.Exec(stmt); err != nil {
		msg := err.Error()
		if strings.Contains(msg, "duplicate column") || strings.Contains(msg, "already exists") {
			return nil
		}
		return err
	}
	return nil
}

const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    quota_limit_mb INTEGER DEFAULT 100,
    quota_used_bytes INTEGER DEFAULT 0
);`

const createDevicesTable = `
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    browser TEXT NOT NULL,
    device_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);`

const createUserVersionsTable = `
CREATE TABLE IF NOT EXISTS user_versions (
    user_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);`

const createDeviceVersionsTable = `
CREATE TABLE IF NOT EXISTS device_versions (
    device_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
);`

const createTabsCurrentTable = `
CREATE TABLE IF NOT EXISTS tabs_current (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    tab_id_hash TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon_url TEXT,
    window_id INTEGER NOT NULL,
    pinned BOOLEAN DEFAULT FALSE,
    discarded BOOLEAN DEFAULT FALSE,
    last_active_at DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
    UNIQUE (user_id, device_id, tab_id_hash)
);`

const createTabHistoryTable = `
CREATE TABLE IF NOT EXISTS tab_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon_url TEXT,
    window_id INTEGER NOT NULL,
    tab_correlation_id TEXT NOT NULL,
    occurred_at DATETIME NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
);`

const createAuthTokensTable = `
CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT,
    type TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
);`

// bookmark_state: one row per user; version bumps on full-tree PUT.
const createBookmarkStateTable = `
CREATE TABLE IF NOT EXISTS bookmark_state (
    user_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);`

// bookmark_nodes: flat tree (id is client bookmark id, stable per browser profile).
const createBookmarkNodesTable = `
CREATE TABLE IF NOT EXISTS bookmark_nodes (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);`

const createIndices = `
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices (user_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_devices_revoked_at ON devices (revoked_at);

CREATE INDEX IF NOT EXISTS idx_user_versions_user_id ON user_versions (user_id);
CREATE INDEX IF NOT EXISTS idx_device_versions_user_id ON device_versions (user_id);

CREATE INDEX IF NOT EXISTS idx_tabs_current_user_id ON tabs_current (user_id);
CREATE INDEX IF NOT EXISTS idx_tabs_current_device_id ON tabs_current (device_id);
CREATE INDEX IF NOT EXISTS idx_tabs_current_updated_at ON tabs_current (updated_at);
CREATE INDEX IF NOT EXISTS idx_tabs_current_version ON tabs_current (user_id, version);

CREATE INDEX IF NOT EXISTS idx_tab_history_user_id ON tab_history (user_id);
CREATE INDEX IF NOT EXISTS idx_tab_history_device_id ON tab_history (device_id);
CREATE INDEX IF NOT EXISTS idx_tab_history_occurred_at ON tab_history (occurred_at);
CREATE INDEX IF NOT EXISTS idx_tab_history_correlation ON tab_history (tab_correlation_id);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_device_id ON auth_tokens (device_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_bookmark_nodes_user_id ON bookmark_nodes (user_id);
`
