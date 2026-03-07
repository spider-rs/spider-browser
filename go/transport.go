package spiderbrowser

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// TransportOptions configures the WebSocket connection to Spider.
type TransportOptions struct {
	APIKey          string
	ServerURL       string
	Browser         string
	URL             string
	Captcha         string // "off", "detect", or "solve"
	StealthLevel    int
	Country         string
	ProxyURL        string
	ConnectTimeout  time.Duration
	CommandTimeout  time.Duration
	Hedge           bool
	Record          bool
	Mode            string // "scraping" or "cua"
}

func (o *TransportOptions) defaults() {
	if o.ServerURL == "" {
		o.ServerURL = "wss://browser.spider.cloud"
	}
	if o.Browser == "" {
		o.Browser = "auto"
	}
	if o.Captcha == "" {
		o.Captcha = "solve"
	}
	if o.ConnectTimeout == 0 {
		o.ConnectTimeout = 30 * time.Second
	}
	if o.CommandTimeout == 0 {
		o.CommandTimeout = 30 * time.Second
	}
}

// Transport manages the WebSocket connection to Spider's browser fleet.
type Transport struct {
	mu             sync.Mutex
	conn           *websocket.Conn
	opts           TransportOptions
	emitter        *EventEmitter
	currentBrowser string
	stealthLevel   int
	generation     int64
	messageHandler func(data string)

	upgradeCredits    *float64
	upgradeStealthTier *int
	upgradeProxyTier  *int
	sessionCreditsUsed *float64

	closed int32 // atomic
}

// NewTransport creates a new WebSocket transport.
func NewTransport(opts TransportOptions, emitter *EventEmitter) *Transport {
	opts.defaults()
	browser := opts.Browser
	if browser == "auto" {
		browser = "chrome-h"
	}
	return &Transport{
		opts:           opts,
		emitter:        emitter,
		currentBrowser: browser,
		stealthLevel:   opts.StealthLevel,
	}
}

// Browser returns the current browser type.
func (t *Transport) Browser() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.currentBrowser
}

// Connected returns whether the WebSocket is currently open.
func (t *Transport) Connected() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.conn != nil
}

// StealthLevel returns the active stealth level.
func (t *Transport) StealthLevel() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stealthLevel
}

// SetStealthLevel sets the stealth level (clamped to 0-3).
func (t *Transport) SetStealthLevel(level int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if level < 0 {
		level = 0
	}
	if level > 3 {
		level = 3
	}
	t.stealthLevel = level
}

// UpgradeCredits returns credits remaining from the last upgrade response.
func (t *Transport) UpgradeCredits() *float64 { return t.upgradeCredits }

// SessionCreditsUsed returns credits consumed during this session.
func (t *Transport) SessionCreditsUsed() *float64 { return t.sessionCreditsUsed }

// OnMessage sets the handler that receives raw JSON messages from the WebSocket.
func (t *Transport) OnMessage(handler func(data string)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.messageHandler = handler
}

// Connect establishes the WebSocket connection with retry.
func (t *Transport) Connect(maxAttempts int) error {
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		err := t.connectInternal()
		if err == nil {
			return nil
		}
		lastErr = err
		if _, ok := err.(*AuthError); ok {
			return err
		}
		if attempt < maxAttempts {
			backoff := time.Duration(500*attempt) * time.Millisecond
			defaultLogger.warn(fmt.Sprintf("connect attempt %d/%d failed, retrying in %v", attempt, maxAttempts, backoff), "error", lastErr)
			time.Sleep(backoff)
		}
	}
	return lastErr
}

// Reconnect closes and reconnects with a different browser type.
func (t *Transport) Reconnect(browser string) error {
	t.mu.Lock()
	prev := t.currentBrowser
	t.currentBrowser = browser
	t.mu.Unlock()

	t.Close()
	defaultLogger.info(fmt.Sprintf("switching browser: %s -> %s", prev, browser))
	return t.connectInternal()
}

// Send sends a raw JSON string through the WebSocket.
func (t *Transport) Send(data string) error {
	t.mu.Lock()
	conn := t.conn
	t.mu.Unlock()

	if conn == nil {
		return newConnectionError("WebSocket is not connected")
	}
	return conn.WriteMessage(websocket.TextMessage, []byte(data))
}

// Close closes the WebSocket connection.
func (t *Transport) Close() {
	if !atomic.CompareAndSwapInt32(&t.closed, 0, 1) {
		// Allow re-closing after reconnect
	}
	t.mu.Lock()
	conn := t.conn
	t.conn = nil
	t.mu.Unlock()

	if conn != nil {
		conn.Close()
	}
	atomic.StoreInt32(&t.closed, 0) // Reset for potential reconnect
}

// RequestMetering sends Spider.getMetering and waits for the response.
func (t *Transport) RequestMetering(timeout time.Duration) (float64, error) {
	if timeout == 0 {
		timeout = 3 * time.Second
	}
	t.mu.Lock()
	conn := t.conn
	t.mu.Unlock()
	if conn == nil {
		if t.sessionCreditsUsed != nil {
			return *t.sessionCreditsUsed, nil
		}
		return 0, nil
	}

	meteringID := 2147483640
	cmd, _ := json.Marshal(map[string]any{
		"id":     meteringID,
		"method": "Spider.getMetering",
	})

	ch := make(chan float64, 1)

	// Temporarily intercept in the message handler
	origHandler := t.messageHandler
	t.mu.Lock()
	t.messageHandler = func(data string) {
		if strings.Contains(data, fmt.Sprintf(`"id":%d`, meteringID)) {
			var msg struct {
				ID     int `json:"id"`
				Result struct {
					CreditsUsed float64 `json:"credits_used"`
				} `json:"result"`
			}
			if json.Unmarshal([]byte(data), &msg) == nil && msg.ID == meteringID {
				cu := msg.Result.CreditsUsed
				t.sessionCreditsUsed = &cu
				t.mu.Lock()
				t.messageHandler = origHandler
				t.mu.Unlock()
				select {
				case ch <- cu:
				default:
				}
				return
			}
		}
		if origHandler != nil {
			origHandler(data)
		}
	}
	t.mu.Unlock()

	if err := t.Send(string(cmd)); err != nil {
		t.mu.Lock()
		t.messageHandler = origHandler
		t.mu.Unlock()
		if t.sessionCreditsUsed != nil {
			return *t.sessionCreditsUsed, nil
		}
		return 0, nil
	}

	select {
	case credits := <-ch:
		return credits, nil
	case <-time.After(timeout):
		t.mu.Lock()
		t.messageHandler = origHandler
		t.mu.Unlock()
		if t.sessionCreditsUsed != nil {
			return *t.sessionCreditsUsed, nil
		}
		return 0, nil
	}
}

func (t *Transport) buildURL() string {
	base := strings.TrimRight(t.opts.ServerURL, "/")
	params := url.Values{}
	params.Set("token", t.opts.APIKey)

	t.mu.Lock()
	browser := t.currentBrowser
	stealth := t.stealthLevel
	t.mu.Unlock()

	if browser != "auto" {
		params.Set("browser", browser)
	}
	if t.opts.URL != "" {
		params.Set("url", t.opts.URL)
	}
	if t.opts.Captcha != "" && t.opts.Captcha != "off" {
		params.Set("ai_captcha", t.opts.Captcha)
	}
	if stealth > 0 {
		params.Set("s", strconv.Itoa(stealth))
	}
	if t.opts.Hedge {
		params.Set("hedge", "true")
	}
	if t.opts.Record {
		params.Set("record", "true")
	}
	if t.opts.Mode != "" {
		params.Set("mode", t.opts.Mode)
	}
	if t.opts.Country != "" {
		params.Set("country", t.opts.Country)
	}
	if t.opts.ProxyURL != "" {
		params.Set("proxy_url", t.opts.ProxyURL)
	}
	return fmt.Sprintf("%s/v1/browser?%s", base, params.Encode())
}

func (t *Transport) connectInternal() error {
	gen := atomic.AddInt64(&t.generation, 1)

	wsURL := t.buildURL()
	maskedURL := strings.Replace(wsURL, t.opts.APIKey, "***", 1)
	defaultLogger.debug(fmt.Sprintf("connecting to %s", maskedURL))

	dialer := websocket.Dialer{
		HandshakeTimeout: t.opts.ConnectTimeout,
	}

	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		if resp != nil {
			switch resp.StatusCode {
			case 401, 402:
				return newAuthError(fmt.Sprintf("Authentication failed (%d)", resp.StatusCode))
			case 429:
				return newRateLimitError("Server at capacity (429)")
			case 503:
				return newBackendUnavailableError("Backend unavailable (503)")
			}
		}
		return newConnectionError(fmt.Sprintf("WebSocket connection failed: %v", err))
	}

	// Parse upgrade headers
	if resp != nil {
		if sc := resp.Header.Get("X-Sc"); sc != "" {
			if v, err := strconv.ParseFloat(sc, 64); err == nil {
				t.upgradeCredits = &v
			}
		}
		if sr := resp.Header.Get("X-Sr"); sr != "" {
			if v, err := strconv.Atoi(sr); err == nil {
				t.upgradeStealthTier = &v
			}
		}
		if pt := resp.Header.Get("X-Pt"); pt != "" {
			if v, err := strconv.Atoi(pt); err == nil {
				t.upgradeProxyTier = &v
			}
		}
		if t.upgradeCredits != nil {
			rate := 0
			if t.upgradeStealthTier != nil {
				rate = *t.upgradeStealthTier
			}
			t.emitter.Emit("metering", map[string]any{
				"credits": *t.upgradeCredits,
				"rate":    rate,
			})
		}
	}

	t.mu.Lock()
	t.conn = conn
	t.mu.Unlock()

	t.emitter.Emit("ws.open", map[string]any{})
	defaultLogger.info(fmt.Sprintf("connected (browser=%s, stealth=%d)", t.currentBrowser, t.stealthLevel))

	// Start read loop in goroutine
	go t.readLoop(conn, gen)

	return nil
}

func (t *Transport) readLoop(conn *websocket.Conn, gen int64) {
	defer func() {
		t.mu.Lock()
		if t.conn == conn {
			t.conn = nil
		}
		t.mu.Unlock()
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			// Only emit close for current generation
			if atomic.LoadInt64(&t.generation) == gen {
				code := 0
				reason := err.Error()
				if closeErr, ok := err.(*websocket.CloseError); ok {
					code = closeErr.Code
					reason = closeErr.Text
				}
				t.emitter.Emit("ws.close", map[string]any{
					"code":   code,
					"reason": reason,
				})
			}
			return
		}

		// Guard: ignore messages from stale WebSocket instances
		if atomic.LoadInt64(&t.generation) != gen {
			continue
		}

		str := string(message)

		// Intercept Spider.* events
		if strings.Contains(str, `"Spider.`) {
			if t.handleSpiderMessage(str) {
				continue
			}
		}

		// Intercept Spider.metering events
		if strings.Contains(str, `"Spider.metering"`) {
			var msg struct {
				Method string `json:"method"`
				Params struct {
					CreditsUsed float64 `json:"credits_used"`
				} `json:"params"`
			}
			if json.Unmarshal(message, &msg) == nil && msg.Method == "Spider.metering" {
				cu := msg.Params.CreditsUsed
				t.sessionCreditsUsed = &cu
				credits := float64(0)
				if t.upgradeCredits != nil {
					credits = *t.upgradeCredits
				}
				rate := 0
				if t.upgradeStealthTier != nil {
					rate = *t.upgradeStealthTier
				}
				t.emitter.Emit("metering", map[string]any{
					"credits":              credits,
					"rate":                 rate,
					"session_credits_used": cu,
				})
				continue
			}
		}

		t.mu.Lock()
		handler := t.messageHandler
		t.mu.Unlock()
		if handler != nil {
			handler(str)
		}
	}
}

func (t *Transport) handleSpiderMessage(data string) bool {
	var msg struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal([]byte(data), &msg); err != nil {
		return false
	}

	switch msg.Method {
	case "Spider.screencastFrame":
		t.emitter.Emit("screencast.frame", msg.Params)
		return true
	case "Spider.interactionEvents":
		t.emitter.Emit("screencast.interactionEvents", msg.Params)
		return true
	case "Spider.rrwebEvents":
		t.emitter.Emit("screencast.rrwebEvents", msg.Params)
		return true
	case "Spider.recordingStarted":
		t.emitter.Emit("recording.started", msg.Params)
		return true
	case "Spider.recordingCompleted":
		t.emitter.Emit("recording.completed", msg.Params)
		return true
	}
	return false
}

// httpHeaderToMap converts http.Header to a simple map for upgrade header parsing.
func httpHeaderToMap(h http.Header) map[string]string {
	m := make(map[string]string)
	for k, v := range h {
		if len(v) > 0 {
			m[k] = v[0]
		}
	}
	return m
}
