package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all configuration for the server
type Config struct {
	ServerAddress string
	DatabaseURL   string
	Domain        string
	SMTPHost      string
	SMTPPort      int
	SMTPUsername  string
	SMTPPassword  string
	SMTPFrom      string
	JWTSecret     string
	QuotaLimitMB  int64
	TokenTTL      time.Duration
	AllowedOrigins []string
	DevMode       bool

	// MaxBodyBytes is the largest request body the server will accept. This
	// primarily protects `/tabs/*` endpoints from oversized payloads.
	MaxBodyBytes int64

	// RateLimit is the max requests per device per minute for authenticated
	// endpoints.  Unauthenticated endpoints are not rate-limited here; rely on
	// the reverse proxy for that layer.
	RateLimitPerMinute int

	// BootstrapEmail is the identity attached to the auto-generated invite
	// token printed at first boot (when the devices table is empty). Admins
	// can override this via the env var; falls back to "admin@localhost" so
	// a zero-config startup still works.
	BootstrapEmail string
}

// Load reads configuration from environment variables with sensible defaults
func Load() (*Config, error) {
	config := &Config{
		ServerAddress:      getEnv("SERVER_ADDRESS", ":8787"),
		DatabaseURL:        getEnv("DATABASE_URL", "./data/keepsync.db"),
		Domain:             getEnv("DOMAIN", ""),
		SMTPHost:           getEnv("SMTP_HOST", ""),
		SMTPPort:           getEnvInt("SMTP_PORT", 587),
		SMTPUsername:       getEnv("SMTP_USERNAME", ""),
		SMTPPassword:       getEnv("SMTP_PASSWORD", ""),
		SMTPFrom:           getEnv("SMTP_FROM", "noreply@localhost"),
		JWTSecret:          getEnv("JWT_SECRET", ""),
		QuotaLimitMB:       getEnvInt64("QUOTA_LIMIT_MB", 100),
		TokenTTL:           getEnvDuration("TOKEN_TTL", 24*time.Hour*30),
		AllowedOrigins:     getEnvSlice("ALLOWED_ORIGINS", []string{}),
		DevMode:            getEnvBool("DEV_MODE", false),
		MaxBodyBytes:       getEnvInt64("MAX_BODY_BYTES", 2*1024*1024),
		RateLimitPerMinute: getEnvInt("RATE_LIMIT_PER_MINUTE", 120),
		BootstrapEmail:     getEnv("BOOTSTRAP_EMAIL", "admin@localhost"),
	}

	return config, nil
}

// Validate enforces security-critical invariants after loading. It must be
// called after Load() and before the server starts accepting traffic.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.JWTSecret) == "" {
		return fmt.Errorf("JWT_SECRET is required — set a strong secret (>= 32 characters) via environment variable")
	}

	if len(c.JWTSecret) < 16 {
		return fmt.Errorf("JWT_SECRET must be at least 16 characters for adequate entropy")
	}

	if !c.DevMode {
		for _, origin := range c.AllowedOrigins {
			if strings.TrimSpace(origin) == "*" {
				return fmt.Errorf("ALLOWED_ORIGINS wildcard '*' is not permitted in production — specify exact origins")
			}
		}
	}

	return nil
}

// getEnv gets an environment variable with a default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvInt gets an environment variable as int with a default value
func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			return parsed
		}
	}
	return defaultValue
}

// getEnvInt64 gets an environment variable as int64 with a default value
func getEnvInt64(key string, defaultValue int64) int64 {
	if value := os.Getenv(key); value != "" {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			return parsed
		}
	}
	return defaultValue
}

// getEnvDuration gets an environment variable as duration with a default value
func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			return parsed
		}
	}
	return defaultValue
}

// getEnvSlice gets an environment variable as a string slice with a default
// value. Values are split on commas and surrounding whitespace is trimmed so
// entries like "ALLOWED_ORIGINS=https://a.example.com, https://b.example.com"
// parse into two discrete origins.
func getEnvSlice(key string, defaultValue []string) []string {
	value := os.Getenv(key)
	if value == "" {
		return defaultValue
	}

	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		result = append(result, trimmed)
	}

	if len(result) == 0 {
		return defaultValue
	}
	return result
}

// getEnvBool gets an environment variable as bool with a default value
func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if parsed, err := strconv.ParseBool(value); err == nil {
			return parsed
		}
	}
	return defaultValue
}

// IsSMTPEnabled returns true if SMTP configuration is available
func (c *Config) IsSMTPEnabled() bool {
	return c.SMTPHost != "" && c.SMTPUsername != "" && c.SMTPPassword != ""
}
