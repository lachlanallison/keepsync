package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// originAllowed returns true when `origin` matches one of the configured
// AllowedOrigins entries. The wildcard "*" allows anything. Exact matches are
// required otherwise; we don't attempt scheme-less or subdomain matching to
// keep the policy explicit.
func (r *Router) originAllowed(origin string) bool {
	if origin == "" {
		// Non-browser callers (curl, extension background with no Origin set)
		// are permitted — they still have to present a valid bearer token.
		return true
	}
	for _, allowed := range r.config.AllowedOrigins {
		if allowed == "*" || allowed == origin {
			return true
		}
	}
	return false
}

func (r *Router) newWebSocketUpgrader() websocket.Upgrader {
	return websocket.Upgrader{
		CheckOrigin: func(req *http.Request) bool {
			return r.originAllowed(req.Header.Get("Origin"))
		},
	}
}

// isRevocationFor returns true when `payload` is a device_revoked JSON event
// naming `deviceID`. We parse rather than substring-match so adversarial
// data in another field (e.g. a URL containing the literal string) can't
// trigger a false positive close.
func isRevocationFor(payload, deviceID string) bool {
	if !strings.Contains(payload, `"device_revoked"`) || deviceID == "" {
		return false
	}
	var evt struct {
		Type     string `json:"type"`
		DeviceID string `json:"device_id"`
	}
	if err := json.Unmarshal([]byte(payload), &evt); err != nil {
		return false
	}
	return evt.Type == "device_revoked" && evt.DeviceID == deviceID
}

var (
	sseMu      sync.Mutex
	sseClients = map[string]map[chan string]struct{}{}
	wsMu       sync.Mutex
	wsClients  = map[string]map[*wsClient]struct{}{}
)

type wsClient struct {
	userID   string
	deviceID string
	conn     *websocket.Conn
	send     chan string
}

func registerSSE(userID string, ch chan string) {
	sseMu.Lock()
	defer sseMu.Unlock()
	if _, ok := sseClients[userID]; !ok {
		sseClients[userID] = map[chan string]struct{}{}
	}
	sseClients[userID][ch] = struct{}{}
}

func unregisterSSE(userID string, ch chan string) {
	sseMu.Lock()
	defer sseMu.Unlock()
	if clients, ok := sseClients[userID]; ok {
		delete(clients, ch)
		if len(clients) == 0 {
			delete(sseClients, userID)
		}
	}
}

func registerWS(userID string, client *wsClient) {
	wsMu.Lock()
	defer wsMu.Unlock()
	if _, ok := wsClients[userID]; !ok {
		wsClients[userID] = map[*wsClient]struct{}{}
	}
	wsClients[userID][client] = struct{}{}
}

func unregisterWS(userID string, client *wsClient) {
	wsMu.Lock()
	defer wsMu.Unlock()
	if clients, ok := wsClients[userID]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(wsClients, userID)
		}
	}
}

func notifyUser(userID, payload string) {
	sseMu.Lock()
	clients := sseClients[userID]
	sseMu.Unlock()
	for ch := range clients {
		select {
		case ch <- payload:
		default:
		}
	}

	wsMu.Lock()
	wsClientSet := wsClients[userID]
	wsMu.Unlock()
	for client := range wsClientSet {
		select {
		case client.send <- payload:
		default:
		}
	}
}

// handleWebSocket handles GET /realtime/ws
func (r *Router) handleWebSocket(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	deviceID := getDeviceID(req.Context())

	upgrader := r.newWebSocketUpgrader()
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("Failed to upgrade WebSocket connection: %v", err)
		return
	}
	defer conn.Close()

	log.Printf("WebSocket connected: user=%s device=%s", userID, deviceID)

	client := &wsClient{
		userID:   userID,
		deviceID: deviceID,
		conn:     conn,
		send:     make(chan string, 20),
	}
	registerWS(userID, client)
	defer unregisterWS(userID, client)
	defer close(client.send)

	// Writer loop for outgoing notifications + periodic server pings so idle
	// connections are proactively probed rather than silently going stale.
	// A `device_revoked` notification targeted at this device triggers an
	// immediate graceful close so the revoked client stops syncing.
	go func() {
		pingTicker := time.NewTicker(30 * time.Second)
		defer pingTicker.Stop()

		for {
			select {
			case msg, ok := <-client.send:
				if !ok {
					return
				}
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
					return
				}
				if isRevocationFor(msg, deviceID) {
					closeMsg := websocket.FormatCloseMessage(
						websocket.ClosePolicyViolation, "device revoked",
					)
					conn.SetWriteDeadline(time.Now().Add(1 * time.Second))
					_ = conn.WriteMessage(websocket.CloseMessage, closeMsg)
					conn.Close()
					return
				}
			case <-pingTicker.C:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second)) 
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	conn.SetReadLimit(4096)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		if messageType == websocket.TextMessage {
			body := strings.TrimSpace(string(message))
			if body == "ping" {
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				_ = conn.WriteMessage(websocket.TextMessage, []byte("pong"))
			}
		}
	}

	log.Printf("WebSocket disconnected: user=%s device=%s", userID, deviceID)
}

// handleSSE handles GET /realtime/sse
func (r *Router) handleSSE(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	deviceID := getDeviceID(req.Context())

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	log.Printf("SSE connected: user=%s device=%s", userID, deviceID)

	// Send initial connection confirmation
	if _, err := w.Write([]byte("data: {\"type\":\"connected\"}\n\n")); err != nil {
		log.Printf("Failed to write SSE message: %v", err)
		return
	}

	// Flush to send the message immediately
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}

	ch := make(chan string, 10)
	registerSSE(userID, ch)
	defer unregisterSSE(userID, ch)

	// Keep connection alive with periodic pings (some proxies drop idle streams ~60–120s)
	ticker := time.NewTicker(12 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-req.Context().Done():
			log.Printf("SSE disconnected: user=%s device=%s", userID, deviceID)
			return
		case msg := <-ch:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
				log.Printf("Failed to write SSE message: %v", err)
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		case <-ticker.C:
			// Comment line keeps some intermediaries from treating the stream as idle.
			if _, err := fmt.Fprintf(w, ": keepalive\n\ndata: {\"type\":\"ping\"}\n\n"); err != nil {
				log.Printf("Failed to write SSE ping: %v", err)
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
	}
}
