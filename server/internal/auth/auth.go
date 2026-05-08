package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"keepsync-server/internal/config"
	"keepsync-server/internal/models"
	"keepsync-server/internal/storage"
)

// lastSeenThrottleInterval avoids hammering the devices row on every
// authed request while snapshot/events hold other table locks.
const lastSeenThrottleInterval = 5 * time.Second

// Service handles authentication operations
type Service struct {
	db   *storage.DB
	config *config.Config

	// lastSeenAt maps deviceID -> time of the last successful last_seen
	// write (in-process, best-effort).
	lastSeenAt sync.Map
}

// NewService creates a new authentication service
func NewService(db *storage.DB, config *config.Config) *Service {
	return &Service{
		db:     db,
		config: config,
	}
}

// Claims represents JWT token claims
type Claims struct {
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
	Type     string `json:"type"`
	jwt.RegisteredClaims
}

// GenerateMagicLink creates a magic link token for user authentication
func (s *Service) GenerateMagicLink(email, deviceName string) (string, error) {
	// Generate random token
	token, err := generateRandomToken(32)
	if err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}

	// Create or get user
	user, err := s.createOrGetUser(email)
	if err != nil {
		return "", fmt.Errorf("failed to create/get user: %w", err)
	}

	// Store magic link token
	tokenHash := hashToken(token)
	authToken := &models.AuthToken{
		ID:        uuid.New().String(),
		UserID:    user.ID,
		Type:      "magic",
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(15 * time.Minute), // 15 minute expiry
		CreatedAt: time.Now(),
	}

	if err := s.storeMagicToken(authToken); err != nil {
		return "", fmt.Errorf("failed to store magic token: %w", err)
	}

	return token, nil
}

// CountDevices returns the total number of non-revoked devices across all
// users. Used at boot time to decide whether to auto-mint a bootstrap invite
// token for the first device.
func (s *Service) CountDevices() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL`).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n, nil
}

// GenerateInviteToken creates a long-lived, single-use invite token that an
// admin can hand off over any secure channel (no SMTP required). The token
// is returned in plaintext exactly once so the caller can print it; the DB
// only stores a SHA-256 hash.
//
// Use this as the primary bootstrap path for self-hosted deployments that
// don't want to run a mail server. Runtime rate limits at the HTTP layer
// still apply when the token is later redeemed.
func (s *Service) GenerateInviteToken(email string, ttl time.Duration) (string, error) {
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}

	token, err := generateRandomToken(24)
	if err != nil {
		return "", fmt.Errorf("failed to generate invite token: %w", err)
	}

	user, err := s.createOrGetUser(email)
	if err != nil {
		return "", fmt.Errorf("failed to create/get user: %w", err)
	}

	authToken := &models.AuthToken{
		ID:        uuid.New().String(),
		UserID:    user.ID,
		Type:      "invite",
		TokenHash: hashToken(token),
		ExpiresAt: time.Now().Add(ttl),
		CreatedAt: time.Now(),
	}

	query := `INSERT INTO auth_tokens (id, user_id, device_id, type, token_hash, expires_at, created_at, revoked)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	if _, err := s.db.Exec(query, authToken.ID, authToken.UserID, nil, authToken.Type,
		authToken.TokenHash, authToken.ExpiresAt, authToken.CreatedAt, authToken.Revoked); err != nil {
		return "", fmt.Errorf("failed to store invite token: %w", err)
	}

	return token, nil
}

// ActivateWithInvite consumes an invite token and returns device credentials.
// Behaves the same as ActivateDevice / RegisterDeviceWithPairing but from a
// different token source.
func (s *Service) ActivateWithInvite(token, deviceName, browser string) (*models.ActivateResponse, error) {
	tokenHash := hashToken(token)

	query := `SELECT id, user_id, type, token_hash, expires_at, created_at, revoked
		FROM auth_tokens
		WHERE token_hash = ? AND type = 'invite' AND expires_at > ? AND revoked = FALSE`
	var authToken models.AuthToken
	err := s.db.QueryRow(query, tokenHash, time.Now()).Scan(
		&authToken.ID, &authToken.UserID, &authToken.Type, &authToken.TokenHash,
		&authToken.ExpiresAt, &authToken.CreatedAt, &authToken.Revoked,
	)
	if err != nil {
		return nil, fmt.Errorf("invalid or expired invite token: %w", err)
	}

	device := &models.Device{
		ID:         uuid.New().String(),
		UserID:     authToken.UserID,
		Browser:    browser,
		DeviceName: deviceName,
		CreatedAt:  time.Now(),
		LastSeenAt: time.Now(),
	}
	if err := s.createDevice(device); err != nil {
		return nil, fmt.Errorf("failed to create device: %w", err)
	}

	deviceToken, expiresAt, err := s.generateDeviceToken(authToken.UserID, device.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to generate device token: %w", err)
	}

	deviceAuthToken := &models.AuthToken{
		ID:        uuid.New().String(),
		UserID:    authToken.UserID,
		DeviceID:  device.ID,
		Type:      "device",
		TokenHash: hashToken(deviceToken),
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}
	if err := s.storeDeviceToken(deviceAuthToken); err != nil {
		return nil, fmt.Errorf("failed to store device token: %w", err)
	}

	// Invite tokens are single-use by design — consume it immediately.
	if err := s.revokeMagicToken(authToken.ID); err != nil {
		return nil, fmt.Errorf("failed to consume invite token: %w", err)
	}

	return &models.ActivateResponse{
		DeviceToken: deviceToken,
		UserID:      authToken.UserID,
		DeviceID:    device.ID,
		ExpiresAt:   expiresAt,
	}, nil
}

// GeneratePairingCode creates a short-lived pairing code for device registration.
func (s *Service) GeneratePairingCode(email string) (string, error) {
	// Generate numeric code
	code, err := generateNumericCode(6)
	if err != nil {
		return "", fmt.Errorf("failed to generate pairing code: %w", err)
	}

	// Create or get user
	user, err := s.createOrGetUser(email)
	if err != nil {
		return "", fmt.Errorf("failed to create/get user: %w", err)
	}

	tokenHash := hashToken(code)
	authToken := &models.AuthToken{
		ID:        uuid.New().String(),
		UserID:    user.ID,
		Type:      "pairing",
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(15 * time.Minute),
		CreatedAt: time.Now(),
	}

	if err := s.storePairingToken(authToken); err != nil {
		return "", fmt.Errorf("failed to store pairing token: %w", err)
	}

	return code, nil
}

// ActivateDevice activates a device using a magic link token
func (s *Service) ActivateDevice(token, deviceName, browser string) (*models.ActivateResponse, error) {
	tokenHash := hashToken(token)

	// Find and validate magic token
	authToken, err := s.getMagicToken(tokenHash)
	if err != nil {
		return nil, fmt.Errorf("invalid or expired token: %w", err)
	}

	// Create device
	device := &models.Device{
		ID:         uuid.New().String(),
		UserID:     authToken.UserID,
		Browser:    browser,
		DeviceName: deviceName,
		CreatedAt:  time.Now(),
		LastSeenAt: time.Now(),
	}

	if err := s.createDevice(device); err != nil {
		return nil, fmt.Errorf("failed to create device: %w", err)
	}

	// Generate device token (JWT)
	deviceToken, expiresAt, err := s.generateDeviceToken(authToken.UserID, device.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to generate device token: %w", err)
	}

	// Store device token hash for revocation
	deviceTokenHash := hashToken(deviceToken)
	deviceAuthToken := &models.AuthToken{
		ID:        uuid.New().String(),
		UserID:    authToken.UserID,
		DeviceID:  device.ID,
		Type:      "device",
		TokenHash: deviceTokenHash,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}

	if err := s.storeDeviceToken(deviceAuthToken); err != nil {
		return nil, fmt.Errorf("failed to store device token: %w", err)
	}

	// Revoke magic token
	if err := s.revokeMagicToken(authToken.ID); err != nil {
		return nil, fmt.Errorf("failed to revoke magic token: %w", err)
	}

	return &models.ActivateResponse{
		DeviceToken: deviceToken,
		UserID:      authToken.UserID,
		DeviceID:    device.ID,
		ExpiresAt:   expiresAt,
	}, nil
}

// RegisterDeviceWithPairing registers a device using a pairing code.
func (s *Service) RegisterDeviceWithPairing(code, deviceName, browser string) (*models.ActivateResponse, error) {
	tokenHash := hashToken(code)
	authToken, err := s.getPairingToken(tokenHash)
	if err != nil {
		return nil, fmt.Errorf("invalid or expired pairing code: %w", err)
	}

	// Create device
	device := &models.Device{
		ID:         uuid.New().String(),
		UserID:     authToken.UserID,
		Browser:    browser,
		DeviceName: deviceName,
		CreatedAt:  time.Now(),
		LastSeenAt: time.Now(),
	}

	if err := s.createDevice(device); err != nil {
		return nil, fmt.Errorf("failed to create device: %w", err)
	}

	// Generate device token (JWT)
	deviceToken, expiresAt, err := s.generateDeviceToken(authToken.UserID, device.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to generate device token: %w", err)
	}

	// Store device token hash for revocation
	deviceTokenHash := hashToken(deviceToken)
	deviceAuthToken := &models.AuthToken{
		ID:        uuid.New().String(),
		UserID:    authToken.UserID,
		DeviceID:  device.ID,
		Type:      "device",
		TokenHash: deviceTokenHash,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}

	if err := s.storeDeviceToken(deviceAuthToken); err != nil {
		return nil, fmt.Errorf("failed to store device token: %w", err)
	}

	// Revoke pairing token
	if err := s.revokeMagicToken(authToken.ID); err != nil {
		return nil, fmt.Errorf("failed to revoke pairing token: %w", err)
	}

	return &models.ActivateResponse{
		DeviceToken: deviceToken,
		UserID:      authToken.UserID,
		DeviceID:    device.ID,
		ExpiresAt:   expiresAt,
	}, nil
}

// DevLogin creates a device and returns a device token without magic link.
// Intended for local testing when DEV_MODE=true.
func (s *Service) DevLogin(email, deviceName, browser string) (*models.ActivateResponse, error) {
	if deviceName == "" {
		deviceName = "Dev Device"
	}
	if browser == "" {
		browser = "unknown"
	}

	user, err := s.createOrGetUser(email)
	if err != nil {
		return nil, fmt.Errorf("failed to create/get user: %w", err)
	}

	device := &models.Device{
		ID:         uuid.New().String(),
		UserID:     user.ID,
		Browser:    browser,
		DeviceName: deviceName,
		CreatedAt:  time.Now(),
		LastSeenAt: time.Now(),
	}

	if err := s.createDevice(device); err != nil {
		return nil, fmt.Errorf("failed to create device: %w", err)
	}

	deviceToken, expiresAt, err := s.generateDeviceToken(user.ID, device.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to generate device token: %w", err)
	}

	deviceTokenHash := hashToken(deviceToken)
	deviceAuthToken := &models.AuthToken{
		ID:        uuid.New().String(),
		UserID:    user.ID,
		DeviceID:  device.ID,
		Type:      "device",
		TokenHash: deviceTokenHash,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}

	if err := s.storeDeviceToken(deviceAuthToken); err != nil {
		return nil, fmt.Errorf("failed to store device token: %w", err)
	}

	return &models.ActivateResponse{
		DeviceToken: deviceToken,
		UserID:      user.ID,
		DeviceID:    device.ID,
		ExpiresAt:   expiresAt,
	}, nil
}

// ValidateDeviceToken validates a device JWT token. In addition to signature
// + expiry checks, we require that the backing device still exists and has
// not been revoked. This lets `DELETE /devices/{id}` invalidate every token
// for a device in O(1) without maintaining a large token blacklist.
func (s *Service) ValidateDeviceToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(s.config.JWTSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}))

	if err != nil {
		return nil, fmt.Errorf("invalid token: %w", err)
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	// Check if this specific token was revoked (e.g. rotated).
	tokenHash := hashToken(tokenString)
	if revoked, err := s.isTokenRevoked(tokenHash); err != nil {
		return nil, fmt.Errorf("failed to check token status: %w", err)
	} else if revoked {
		return nil, fmt.Errorf("token has been revoked")
	}

	// Check if the device itself is revoked or deleted.  The claims must
	// reference an existing, non-revoked device.
	if claims.DeviceID != "" {
		if err := s.checkDeviceActive(claims.DeviceID, claims.UserID); err != nil {
			return nil, err
		}
	}

	return claims, nil
}

// checkDeviceActive returns nil when a device exists, belongs to userID, and
// has not been revoked. Any other state yields an error.
func (s *Service) checkDeviceActive(deviceID, userID string) error {
	var revokedAt sql.NullTime
	err := s.db.QueryRow(
		`SELECT revoked_at FROM devices WHERE id = ? AND user_id = ?`,
		deviceID, userID,
	).Scan(&revokedAt)
	if err == sql.ErrNoRows {
		return fmt.Errorf("device no longer exists")
	}
	if err != nil {
		return fmt.Errorf("failed to check device status: %w", err)
	}
	if revokedAt.Valid {
		return fmt.Errorf("device has been revoked")
	}
	return nil
}

// RevokeDevice marks a device as revoked and invalidates any device tokens
// issued for it.  Callers must verify ownership before invoking this.
func (s *Service) RevokeDevice(deviceID, userID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		time.Now(), deviceID, userID,
	)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}

	// Revoke every auth token we've issued for this device so even a
	// valid-looking JWT held by the revoked device is rejected immediately.
	if _, err := tx.Exec(
		`UPDATE auth_tokens SET revoked = TRUE WHERE device_id = ? AND type = 'device'`,
		deviceID,
	); err != nil {
		return err
	}

	return tx.Commit()
}

// UpdateDeviceLastSeen updates the last seen timestamp for a device
func (s *Service) UpdateDeviceLastSeen(deviceID string) error {
	if deviceID == "" {
		return nil
	}
	now := time.Now()
	if t, ok := s.lastSeenAt.Load(deviceID); ok {
		if now.Sub(t.(time.Time)) < lastSeenThrottleInterval {
			return nil
		}
	}
	query := `UPDATE devices SET last_seen_at = ? WHERE id = ?`
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		_, err = s.db.Exec(query, now, deviceID)
		if err == nil {
			s.lastSeenAt.Store(deviceID, now)
			return nil
		}
		if !isSQLBusy(err) {
			return err
		}
		if attempt < 1 {
			time.Sleep(20 * time.Millisecond)
			now = time.Now()
		}
	}
	return err
}

func isSQLBusy(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "SQLITE_BUSY") || strings.Contains(msg, "database is locked")
}

// Helper functions

func generateRandomToken(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func generateNumericCode(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	for i := range bytes {
		bytes[i] = '0' + (bytes[i] % 10)
	}
	return string(bytes), nil
}

func hashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}

func (s *Service) createOrGetUser(email string) (*models.User, error) {
	// Try to get existing user
	query := `SELECT id, email, created_at, quota_limit_mb, quota_used_bytes FROM users WHERE email = ?`
	var user models.User
	err := s.db.QueryRow(query, email).Scan(&user.ID, &user.Email, &user.CreatedAt, &user.QuotaLimitMB, &user.QuotaUsedBytes)
	
	if err == nil {
		return &user, nil
	}
	
	if err != sql.ErrNoRows {
		return nil, err
	}

	// Create new user
	user = models.User{
		ID:            uuid.New().String(),
		Email:         email,
		CreatedAt:     time.Now(),
		QuotaLimitMB:  s.config.QuotaLimitMB,
		QuotaUsedBytes: 0,
	}

	query = `INSERT INTO users (id, email, created_at, quota_limit_mb, quota_used_bytes) VALUES (?, ?, ?, ?, ?)`
	_, err = s.db.Exec(query, user.ID, user.Email, user.CreatedAt, user.QuotaLimitMB, user.QuotaUsedBytes)
	if err != nil {
		return nil, err
	}

	_, err = s.db.Exec(`INSERT INTO user_versions (user_id, version) VALUES (?, 0)`, user.ID)
	if err != nil {
		return nil, err
	}

	return &user, nil
}

func (s *Service) storeMagicToken(token *models.AuthToken) error {
	query := `INSERT INTO auth_tokens (id, user_id, device_id, type, token_hash, expires_at, created_at, revoked) 
			  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := s.db.Exec(query, token.ID, token.UserID, nil, token.Type, token.TokenHash, token.ExpiresAt, token.CreatedAt, token.Revoked)
	return err
}

func (s *Service) storePairingToken(token *models.AuthToken) error {
	query := `INSERT INTO auth_tokens (id, user_id, device_id, type, token_hash, expires_at, created_at, revoked) 
			  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := s.db.Exec(query, token.ID, token.UserID, nil, token.Type, token.TokenHash, token.ExpiresAt, token.CreatedAt, token.Revoked)
	return err
}

func (s *Service) getMagicToken(tokenHash string) (*models.AuthToken, error) {
	query := `SELECT id, user_id, type, token_hash, expires_at, created_at, revoked 
			  FROM auth_tokens 
			  WHERE token_hash = ? AND type = 'magic' AND expires_at > ? AND revoked = FALSE`
	
	var token models.AuthToken
	err := s.db.QueryRow(query, tokenHash, time.Now()).Scan(
		&token.ID, &token.UserID, &token.Type, &token.TokenHash, &token.ExpiresAt, &token.CreatedAt, &token.Revoked,
	)
	
	if err != nil {
		return nil, err
	}
	
	return &token, nil
}

func (s *Service) getPairingToken(tokenHash string) (*models.AuthToken, error) {
	query := `SELECT id, user_id, type, token_hash, expires_at, created_at, revoked 
			  FROM auth_tokens 
			  WHERE token_hash = ? AND type = 'pairing' AND expires_at > ? AND revoked = FALSE`
	
	var token models.AuthToken
	err := s.db.QueryRow(query, tokenHash, time.Now()).Scan(
		&token.ID, &token.UserID, &token.Type, &token.TokenHash, &token.ExpiresAt, &token.CreatedAt, &token.Revoked,
	)
	
	if err != nil {
		return nil, err
	}
	
	return &token, nil
}

func (s *Service) createDevice(device *models.Device) error {
	query := `INSERT INTO devices (id, user_id, browser, device_name, created_at, last_seen_at) 
			  VALUES (?, ?, ?, ?, ?, ?)`
	_, err := s.db.Exec(query, device.ID, device.UserID, device.Browser, device.DeviceName, device.CreatedAt, device.LastSeenAt)
	if err != nil {
		return err
	}

	_, err = s.db.Exec(`INSERT INTO device_versions (device_id, user_id, version) VALUES (?, ?, 0)`,
		device.ID, device.UserID)
	return err
}

func (s *Service) generateDeviceToken(userID, deviceID string) (string, time.Time, error) {
	expiresAt := time.Now().Add(s.config.TokenTTL)
	claims := &Claims{
		UserID:   userID,
		DeviceID: deviceID,
		Type:     "device",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "keepsync-server",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString([]byte(s.config.JWTSecret))
	if err != nil {
		return "", time.Time{}, err
	}

	return tokenString, expiresAt, nil
}

func (s *Service) storeDeviceToken(token *models.AuthToken) error {
	query := `INSERT INTO auth_tokens (id, user_id, device_id, type, token_hash, expires_at, created_at, revoked) 
			  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := s.db.Exec(query, token.ID, token.UserID, token.DeviceID, token.Type, token.TokenHash, token.ExpiresAt, token.CreatedAt, token.Revoked)
	return err
}

func (s *Service) revokeMagicToken(tokenID string) error {
	query := `UPDATE auth_tokens SET revoked = TRUE WHERE id = ?`
	_, err := s.db.Exec(query, tokenID)
	return err
}

func (s *Service) isTokenRevoked(tokenHash string) (bool, error) {
	query := `SELECT revoked FROM auth_tokens WHERE token_hash = ?`
	var revoked bool
	err := s.db.QueryRow(query, tokenHash).Scan(&revoked)
	if err == sql.ErrNoRows {
		return true, nil // Token not found, consider revoked
	}
	return revoked, err
}
