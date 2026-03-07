package spiderbrowser

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type pendingRequest struct {
	ch    chan *CDPResponse
	timer *time.Timer
}

// CDPSession manages a CDP JSON-RPC session over the Spider WebSocket transport.
type CDPSession struct {
	mu              sync.Mutex
	nextID          int64
	pending         sync.Map // int -> *pendingRequest
	eventHandlers   sync.Map // string -> []func(map[string]any)
	transport       *Transport
	targetSessionID string
	commandTimeout  time.Duration
}

// NewCDPSession creates a new CDP session.
func NewCDPSession(transport *Transport, commandTimeout time.Duration) *CDPSession {
	if commandTimeout == 0 {
		commandTimeout = 30 * time.Second
	}
	return &CDPSession{
		transport:      transport,
		commandTimeout: commandTimeout,
	}
}

// SessionID returns the attached target session ID.
func (s *CDPSession) SessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.targetSessionID
}

// HandleMessage processes a raw message from the transport.
func (s *CDPSession) HandleMessage(data string) bool {
	var raw map[string]any
	if err := json.Unmarshal([]byte(data), &raw); err != nil {
		return false
	}

	// Response (has "id")
	if idRaw, ok := raw["id"]; ok {
		id := toInt(idRaw)
		if val, loaded := s.pending.LoadAndDelete(id); loaded {
			pr := val.(*pendingRequest)
			pr.timer.Stop()
			var resp CDPResponse
			json.Unmarshal([]byte(data), &resp)
			pr.ch <- &resp
			return true
		}
		return false
	}

	// Event (has "method")
	if method, ok := raw["method"].(string); ok {
		params := map[string]any{}
		if p, ok := raw["params"].(map[string]any); ok {
			params = p
		}
		s.fireEvent(method, params)
		s.fireEvent("*", mergeMaps(map[string]any{"method": method}, params))
		return true
	}

	return false
}

// Send sends a CDP command and waits for the response.
func (s *CDPSession) Send(method string, params map[string]any) (*CDPResponse, error) {
	id := int(atomic.AddInt64(&s.nextID, 1))
	cmd := CDPCommand{
		ID:     id,
		Method: method,
		Params: params,
	}

	cmdJSON, err := json.Marshal(cmd)
	if err != nil {
		return nil, err
	}

	pr := &pendingRequest{
		ch: make(chan *CDPResponse, 1),
	}
	pr.timer = time.AfterFunc(s.commandTimeout, func() {
		if _, loaded := s.pending.LoadAndDelete(id); loaded {
			pr.ch <- nil
		}
	})

	s.pending.Store(id, pr)
	if err := s.transport.Send(string(cmdJSON)); err != nil {
		s.pending.Delete(id)
		pr.timer.Stop()
		return nil, err
	}

	resp := <-pr.ch
	if resp == nil {
		return nil, newTimeoutError(fmt.Sprintf("CDP command timeout: %s (%v)", method, s.commandTimeout))
	}
	return resp, nil
}

// SendToTarget sends a CDP command scoped to the attached page session.
func (s *CDPSession) SendToTarget(method string, params map[string]any) (*CDPResponse, error) {
	s.mu.Lock()
	sessionID := s.targetSessionID
	s.mu.Unlock()

	if sessionID == "" {
		return nil, newProtocolError("No target session — call AttachToPage() first")
	}

	id := int(atomic.AddInt64(&s.nextID, 1))
	cmd := CDPCommand{
		ID:        id,
		Method:    method,
		Params:    params,
		SessionID: sessionID,
	}

	cmdJSON, err := json.Marshal(cmd)
	if err != nil {
		return nil, err
	}

	pr := &pendingRequest{
		ch: make(chan *CDPResponse, 1),
	}
	pr.timer = time.AfterFunc(s.commandTimeout, func() {
		if _, loaded := s.pending.LoadAndDelete(id); loaded {
			pr.ch <- nil
		}
	})

	s.pending.Store(id, pr)
	if err := s.transport.Send(string(cmdJSON)); err != nil {
		s.pending.Delete(id)
		pr.timer.Stop()
		return nil, err
	}

	resp := <-pr.ch
	if resp == nil {
		return nil, newTimeoutError(fmt.Sprintf("CDP command timeout: %s (%v)", method, s.commandTimeout))
	}
	return resp, nil
}

// On subscribes to a CDP event.
func (s *CDPSession) On(method string, handler func(map[string]any)) {
	val, _ := s.eventHandlers.LoadOrStore(method, &[]func(map[string]any){})
	handlers := val.(*[]func(map[string]any))
	s.mu.Lock()
	*handlers = append(*handlers, handler)
	s.mu.Unlock()
}

// Off removes a CDP event handler.
func (s *CDPSession) Off(method string, handler func(map[string]any)) {
	val, ok := s.eventHandlers.Load(method)
	if !ok {
		return
	}
	handlers := val.(*[]func(map[string]any))
	s.mu.Lock()
	if len(*handlers) > 0 {
		*handlers = (*handlers)[:len(*handlers)-1]
	}
	s.mu.Unlock()
}

func (s *CDPSession) fireEvent(method string, params map[string]any) {
	val, ok := s.eventHandlers.Load(method)
	if !ok {
		return
	}
	handlers := val.(*[]func(map[string]any))
	s.mu.Lock()
	hs := make([]func(map[string]any), len(*handlers))
	copy(hs, *handlers)
	s.mu.Unlock()
	for _, h := range hs {
		func() {
			defer func() { recover() }()
			h(params)
		}()
	}
}

// AttachToPage discovers page targets, attaches to one, and enables CDP domains.
func (s *CDPSession) AttachToPage() (string, error) {
	// Step 1: Enable target discovery
	_, err := s.Send("Target.setDiscoverTargets", map[string]any{"discover": true})
	if err != nil {
		return "", err
	}

	// Step 2: Create a fresh page target
	defaultLogger.debug("creating fresh page target for session isolation")
	createResp, err := s.Send("Target.createTarget", map[string]any{"url": "about:blank"})
	if err != nil {
		return "", err
	}

	var targetID string
	if createResp.Result != nil {
		if tid, ok := createResp.Result["targetId"].(string); ok {
			targetID = tid
		}
	}
	if targetID == "" {
		return "", newProtocolError("Failed to create page target")
	}
	defaultLogger.debug(fmt.Sprintf("created page target: %s", targetID))

	// Step 3: Attach with flatten: true
	attachResp, err := s.Send("Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	})
	if err != nil {
		return "", err
	}

	var sessionID string
	if attachResp.Result != nil {
		if sid, ok := attachResp.Result["sessionId"].(string); ok {
			sessionID = sid
		}
	}

	if sessionID == "" {
		// Wait for Target.attachedToTarget event
		ch := make(chan string, 1)
		timer := time.AfterFunc(5*time.Second, func() {
			ch <- ""
		})
		handler := func(params map[string]any) {
			if sid, ok := params["sessionId"].(string); ok && sid != "" {
				timer.Stop()
				ch <- sid
			}
		}
		s.On("Target.attachedToTarget", handler)
		sessionID = <-ch
		s.Off("Target.attachedToTarget", handler)
		if sessionID == "" {
			return "", newTimeoutError("Timeout waiting for Target.attachedToTarget event")
		}
	}

	s.mu.Lock()
	s.targetSessionID = sessionID
	s.mu.Unlock()

	defaultLogger.info(fmt.Sprintf("attached to page target (targetId=%s, sessionId=%s)", targetID, sessionID))

	// Step 4: Enable domains
	if _, err := s.SendToTarget("Page.enable", nil); err != nil {
		return "", err
	}
	if _, err := s.SendToTarget("Runtime.enable", nil); err != nil {
		return "", err
	}

	return sessionID, nil
}

// CaptureScreenshot captures a screenshot as base64 PNG.
func (s *CDPSession) CaptureScreenshot() (string, error) {
	resp, err := s.SendToTarget("Page.captureScreenshot", map[string]any{"format": "png"})
	if err != nil {
		return "", err
	}
	if resp.Error != nil {
		return "", newProtocolError(fmt.Sprintf("captureScreenshot: %s", resp.Error.Message))
	}
	data, ok := resp.Result["data"].(string)
	if !ok {
		return "", newProtocolError("captureScreenshot: missing result.data")
	}
	return data, nil
}

// GetHTML returns the full page HTML.
func (s *CDPSession) GetHTML() (string, error) {
	resp, err := s.SendToTarget("Runtime.evaluate", map[string]any{
		"expression":    "document.documentElement.outerHTML",
		"returnByValue": true,
	})
	if err != nil {
		return "", err
	}
	val, err := extractEvalValue(resp)
	if err != nil {
		return "", err
	}
	if str, ok := val.(string); ok {
		return str, nil
	}
	return "", nil
}

// Evaluate evaluates a JavaScript expression and returns the value.
func (s *CDPSession) Evaluate(expression string) (any, error) {
	resp, err := s.SendToTarget("Runtime.evaluate", map[string]any{
		"expression":    expression,
		"returnByValue": true,
	})
	if err != nil {
		return nil, err
	}
	return extractEvalValue(resp)
}

// WaitForEvent waits for a CDP event, returning true if fired, false on timeout.
func (s *CDPSession) WaitForEvent(method string, timeout time.Duration) bool {
	ch := make(chan struct{}, 1)
	timer := time.AfterFunc(timeout, func() {
		select {
		case ch <- struct{}{}:
		default:
		}
	})

	fired := false
	handler := func(params map[string]any) {
		if !fired {
			fired = true
			timer.Stop()
			select {
			case ch <- struct{}{}:
			default:
			}
		}
	}
	s.On(method, handler)
	<-ch
	s.Off(method, handler)
	return fired
}

// Navigate navigates to a URL and waits for page load.
func (s *CDPSession) Navigate(url string) error {
	loadCh := make(chan bool, 1)
	stopCh := make(chan bool, 1)

	loadTimer := time.AfterFunc(8*time.Second, func() { loadCh <- false })
	loadHandler := func(params map[string]any) {
		loadTimer.Stop()
		select {
		case loadCh <- true:
		default:
		}
	}
	s.On("Page.loadEventFired", loadHandler)

	stopTimer := time.AfterFunc(10*time.Second, func() { stopCh <- false })
	stopHandler := func(params map[string]any) {
		stopTimer.Stop()
		select {
		case stopCh <- true:
		default:
		}
	}
	s.On("Page.frameStoppedLoading", stopHandler)

	resp, err := s.SendToTarget("Page.navigate", map[string]any{"url": url})
	if err != nil {
		s.Off("Page.loadEventFired", loadHandler)
		s.Off("Page.frameStoppedLoading", stopHandler)
		loadTimer.Stop()
		stopTimer.Stop()
		return err
	}

	if resp.Result != nil {
		if errorText, ok := resp.Result["errorText"].(string); ok && errorText != "" {
			s.Off("Page.loadEventFired", loadHandler)
			s.Off("Page.frameStoppedLoading", stopHandler)
			loadTimer.Stop()
			stopTimer.Stop()
			if isRetryableNavError(errorText) {
				return newNavigationError(fmt.Sprintf("Navigation failed: %s", errorText))
			}
			return newProtocolError(fmt.Sprintf("Navigation failed: %s", errorText))
		}
	}

	loaded := <-loadCh
	s.Off("Page.loadEventFired", loadHandler)
	if !loaded {
		<-stopCh
	}
	s.Off("Page.frameStoppedLoading", stopHandler)

	return nil
}

// NavigateFast navigates without waiting for full load (5s max).
func (s *CDPSession) NavigateFast(url string) error {
	loadCh := make(chan bool, 1)
	loadTimer := time.AfterFunc(5*time.Second, func() { loadCh <- false })
	loadHandler := func(params map[string]any) {
		loadTimer.Stop()
		select {
		case loadCh <- true:
		default:
		}
	}
	s.On("Page.loadEventFired", loadHandler)

	resp, err := s.SendToTarget("Page.navigate", map[string]any{"url": url})
	if err != nil {
		s.Off("Page.loadEventFired", loadHandler)
		loadTimer.Stop()
		return err
	}

	if resp.Result != nil {
		if errorText, ok := resp.Result["errorText"].(string); ok && errorText != "" {
			s.Off("Page.loadEventFired", loadHandler)
			loadTimer.Stop()
			if isRetryableNavError(errorText) {
				return newNavigationError(fmt.Sprintf("Navigation failed: %s", errorText))
			}
			return newProtocolError(fmt.Sprintf("Navigation failed: %s", errorText))
		}
	}

	<-loadCh
	s.Off("Page.loadEventFired", loadHandler)
	return nil
}

// NavigateDom navigates and returns on DOMContentLoaded (3s max).
func (s *CDPSession) NavigateDom(url string) error {
	domCh := make(chan bool, 1)
	domTimer := time.AfterFunc(3*time.Second, func() { domCh <- false })
	domHandler := func(params map[string]any) {
		domTimer.Stop()
		select {
		case domCh <- true:
		default:
		}
	}
	s.On("Page.domContentEventFired", domHandler)

	resp, err := s.SendToTarget("Page.navigate", map[string]any{"url": url})
	if err != nil {
		s.Off("Page.domContentEventFired", domHandler)
		domTimer.Stop()
		return err
	}

	if resp.Result != nil {
		if errorText, ok := resp.Result["errorText"].(string); ok && errorText != "" {
			s.Off("Page.domContentEventFired", domHandler)
			domTimer.Stop()
			if isRetryableNavError(errorText) {
				return newNavigationError(fmt.Sprintf("Navigation failed: %s", errorText))
			}
			return newProtocolError(fmt.Sprintf("Navigation failed: %s", errorText))
		}
	}

	<-domCh
	s.Off("Page.domContentEventFired", domHandler)
	return nil
}

// DispatchMouseEvent sends a mouse event.
func (s *CDPSession) DispatchMouseEvent(eventType string, x, y float64, button string, clickCount int) error {
	_, err := s.SendToTarget("Input.dispatchMouseEvent", map[string]any{
		"type":       eventType,
		"x":         x,
		"y":         y,
		"button":    button,
		"clickCount": clickCount,
	})
	return err
}

// ClickPoint clicks at viewport coordinates.
func (s *CDPSession) ClickPoint(x, y float64) error {
	if err := s.DispatchMouseEvent("mouseMoved", x, y, "none", 0); err != nil {
		return err
	}
	if err := s.DispatchMouseEvent("mousePressed", x, y, "left", 1); err != nil {
		return err
	}
	return s.DispatchMouseEvent("mouseReleased", x, y, "left", 1)
}

// RightClickPoint right-clicks at coordinates.
func (s *CDPSession) RightClickPoint(x, y float64) error {
	if err := s.DispatchMouseEvent("mouseMoved", x, y, "none", 0); err != nil {
		return err
	}
	if err := s.DispatchMouseEvent("mousePressed", x, y, "right", 1); err != nil {
		return err
	}
	return s.DispatchMouseEvent("mouseReleased", x, y, "right", 1)
}

// DoubleClickPoint double-clicks at coordinates.
func (s *CDPSession) DoubleClickPoint(x, y float64) error {
	if err := s.DispatchMouseEvent("mouseMoved", x, y, "none", 0); err != nil {
		return err
	}
	if err := s.DispatchMouseEvent("mousePressed", x, y, "left", 1); err != nil {
		return err
	}
	if err := s.DispatchMouseEvent("mouseReleased", x, y, "left", 1); err != nil {
		return err
	}
	if err := s.DispatchMouseEvent("mousePressed", x, y, "left", 2); err != nil {
		return err
	}
	return s.DispatchMouseEvent("mouseReleased", x, y, "left", 2)
}

// ClickHoldPoint clicks and holds at coordinates for a duration.
func (s *CDPSession) ClickHoldPoint(x, y float64, holdMs int) error {
	if err := s.DispatchMouseEvent("mouseMoved", x, y, "none", 0); err != nil {
		return err
	}
	if err := s.DispatchMouseEvent("mousePressed", x, y, "left", 1); err != nil {
		return err
	}
	time.Sleep(time.Duration(holdMs) * time.Millisecond)
	return s.DispatchMouseEvent("mouseReleased", x, y, "left", 1)
}

// HoverPoint moves the mouse to coordinates.
func (s *CDPSession) HoverPoint(x, y float64) error {
	return s.DispatchMouseEvent("mouseMoved", x, y, "none", 0)
}

// DragPoint smoothly drags from one point to another.
func (s *CDPSession) DragPoint(fromX, fromY, toX, toY float64) error {
	steps := 10
	if err := s.DispatchMouseEvent("mouseMoved", fromX, fromY, "none", 0); err != nil {
		return err
	}
	if err := s.DispatchMouseEvent("mousePressed", fromX, fromY, "left", 1); err != nil {
		return err
	}
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		x := fromX + (toX-fromX)*t
		y := fromY + (toY-fromY)*t
		if err := s.DispatchMouseEvent("mouseMoved", x, y, "left", 0); err != nil {
			return err
		}
		time.Sleep(16 * time.Millisecond)
	}
	return s.DispatchMouseEvent("mouseReleased", toX, toY, "left", 1)
}

// InsertText inserts text via Input.insertText.
func (s *CDPSession) InsertText(text string) error {
	_, err := s.SendToTarget("Input.insertText", map[string]any{"text": text})
	return err
}

// PressKey presses a key (keyDown + keyUp).
func (s *CDPSession) PressKey(key, code string, keyCode int) error {
	if _, err := s.SendToTarget("Input.dispatchKeyEvent", map[string]any{
		"type":                  "keyDown",
		"key":                   key,
		"code":                  code,
		"windowsVirtualKeyCode": keyCode,
		"text":                  key,
	}); err != nil {
		return err
	}
	_, err := s.SendToTarget("Input.dispatchKeyEvent", map[string]any{
		"type":                  "keyUp",
		"key":                   key,
		"code":                  code,
		"windowsVirtualKeyCode": keyCode,
	})
	return err
}

// KeyDown sends a keyDown event.
func (s *CDPSession) KeyDown(key, code string, keyCode int) error {
	_, err := s.SendToTarget("Input.dispatchKeyEvent", map[string]any{
		"type":                  "keyDown",
		"key":                   key,
		"code":                  code,
		"windowsVirtualKeyCode": keyCode,
		"text":                  key,
	})
	return err
}

// KeyUp sends a keyUp event.
func (s *CDPSession) KeyUp(key, code string, keyCode int) error {
	_, err := s.SendToTarget("Input.dispatchKeyEvent", map[string]any{
		"type":                  "keyUp",
		"key":                   key,
		"code":                  code,
		"windowsVirtualKeyCode": keyCode,
	})
	return err
}

// SetViewport sets viewport dimensions via Emulation.setDeviceMetricsOverride.
func (s *CDPSession) SetViewport(width, height int, deviceScaleFactor float64, mobile bool) error {
	_, err := s.SendToTarget("Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            height,
		"deviceScaleFactor": deviceScaleFactor,
		"mobile":            mobile,
	})
	return err
}

// Destroy cleans up all pending commands and event handlers.
func (s *CDPSession) Destroy() {
	s.pending.Range(func(key, value any) bool {
		pr := value.(*pendingRequest)
		pr.timer.Stop()
		close(pr.ch)
		s.pending.Delete(key)
		return true
	})
	s.eventHandlers = sync.Map{}
	s.mu.Lock()
	s.targetSessionID = ""
	s.mu.Unlock()
}

// extractEvalValue extracts the value from a Runtime.evaluate response.
func extractEvalValue(resp *CDPResponse) (any, error) {
	if resp.Error != nil {
		return nil, newProtocolError(fmt.Sprintf("CDP error: %s", resp.Error.Message))
	}
	if resp.Result == nil {
		return nil, nil
	}
	result, ok := resp.Result["result"].(map[string]any)
	if !ok {
		return nil, nil
	}
	return result["value"], nil
}

// retryableNavErrors lists navigation errors that should be retried.
var retryableNavErrors = []string{
	"net::ERR_ABORTED",
	"net::ERR_CONNECTION_RESET",
	"net::ERR_CONNECTION_CLOSED",
	"net::ERR_CONNECTION_REFUSED",
	"net::ERR_CONNECTION_TIMED_OUT",
	"net::ERR_TIMED_OUT",
	"net::ERR_EMPTY_RESPONSE",
	"net::ERR_SOCKET_NOT_CONNECTED",
	"net::ERR_NETWORK_CHANGED",
}

func isRetryableNavError(errorText string) bool {
	for _, e := range retryableNavErrors {
		if strings.Contains(errorText, e) {
			return true
		}
	}
	return false
}

// Helper functions

func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return 0
}

func mergeMaps(a, b map[string]any) map[string]any {
	result := make(map[string]any)
	for k, v := range a {
		result[k] = v
	}
	for k, v := range b {
		result[k] = v
	}
	return result
}
