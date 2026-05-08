package api

import (
	"context"
)

// Context keys for storing user information
type contextKey string

const (
	userIDKey   contextKey = "user_id"
	deviceIDKey contextKey = "device_id"
)

// setUserID stores user ID in context
func setUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey, userID)
}

// getUserID retrieves user ID from context
func getUserID(ctx context.Context) string {
	if userID, ok := ctx.Value(userIDKey).(string); ok {
		return userID
	}
	return ""
}

// setDeviceID stores device ID in context
func setDeviceID(ctx context.Context, deviceID string) context.Context {
	return context.WithValue(ctx, deviceIDKey, deviceID)
}

// getDeviceID retrieves device ID from context
func getDeviceID(ctx context.Context) string {
	if deviceID, ok := ctx.Value(deviceIDKey).(string); ok {
		return deviceID
	}
	return ""
}
