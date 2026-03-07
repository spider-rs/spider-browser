package spiderbrowser

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

// ProtocolAdapter provides a unified interface over CDP and BiDi sessions.
type ProtocolAdapter struct {
	cdp           *CDPSession
	bidi          *BiDiSession
	transport     *Transport
	emitter       *EventEmitter
	protocol      string // "cdp", "bidi", or "auto"
	commandTimeout time.Duration
}

// NewProtocolAdapter creates a new protocol adapter.
func NewProtocolAdapter(transport *Transport, emitter *EventEmitter, browser string, commandTimeout time.Duration) *ProtocolAdapter {
	if commandTimeout == 0 {
		commandTimeout = 30 * time.Second
	}
	pa := &ProtocolAdapter{
		transport:      transport,
		emitter:        emitter,
		commandTimeout: commandTimeout,
	}

	if browser == "auto" {
		pa.protocol = "auto"
	} else if browser == "firefox" {
		pa.protocol = "bidi"
		pa.bidi = NewBiDiSession(transport, commandTimeout)
	} else {
		pa.protocol = "cdp"
		pa.cdp = NewCDPSession(transport, commandTimeout)
	}

	// Wire up message routing
	transport.OnMessage(func(data string) {
		pa.routeMessage(data)
	})

	return pa
}

// ProtocolType returns "cdp", "bidi", or "auto".
func (pa *ProtocolAdapter) ProtocolType() string {
	return pa.protocol
}

func (pa *ProtocolAdapter) routeMessage(data string) {
	// Check for Spider.* events first
	var raw map[string]any
	if err := json.Unmarshal([]byte(data), &raw); err == nil {
		if method, ok := raw["method"].(string); ok && strings.HasPrefix(method, "Spider.") {
			params, _ := raw["params"].(map[string]any)
			if params == nil {
				params = map[string]any{}
			}
			pa.handleSpiderEvent(method, params)
			return
		}
	}

	if pa.cdp != nil {
		pa.cdp.HandleMessage(data)
	} else if pa.bidi != nil {
		pa.bidi.HandleMessage(data)
	}
}

func (pa *ProtocolAdapter) handleSpiderEvent(method string, params map[string]any) {
	switch method {
	case "Spider.captchaDetected":
		pa.emitter.Emit("captcha.detected", params)
	case "Spider.captchaSolving":
		pa.emitter.Emit("captcha.solving", params)
	case "Spider.captchaSolved":
		pa.emitter.Emit("captcha.solved", params)
	case "Spider.captchaFailed":
		pa.emitter.Emit("captcha.failed", params)
	default:
		defaultLogger.debug("unhandled Spider event: " + method)
	}
}

// Init initializes the protocol session.
func (pa *ProtocolAdapter) Init() error {
	if pa.protocol == "auto" {
		return pa.autoDetectAndInit()
	}
	if pa.cdp != nil {
		_, err := pa.cdp.AttachToPage()
		return err
	}
	if pa.bidi != nil {
		_, err := pa.bidi.GetOrCreateContext()
		return err
	}
	return nil
}

func (pa *ProtocolAdapter) autoDetectAndInit() error {
	// Try CDP first
	pa.cdp = NewCDPSession(pa.transport, pa.commandTimeout)
	pa.transport.OnMessage(func(data string) { pa.routeMessage(data) })
	if _, err := pa.cdp.AttachToPage(); err == nil {
		pa.protocol = "cdp"
		defaultLogger.info("auto-detected CDP protocol")
		return nil
	}
	pa.cdp.Destroy()
	pa.cdp = nil

	// Try BiDi
	pa.bidi = NewBiDiSession(pa.transport, pa.commandTimeout)
	pa.transport.OnMessage(func(data string) { pa.routeMessage(data) })
	if _, err := pa.bidi.GetOrCreateContext(); err != nil {
		return err
	}
	pa.protocol = "bidi"
	defaultLogger.info("auto-detected BiDi protocol")
	return nil
}

// Navigate navigates to a URL.
func (pa *ProtocolAdapter) Navigate(url string) error {
	if pa.cdp != nil {
		return pa.cdp.Navigate(url)
	}
	return pa.bidi.Navigate(url)
}

// NavigateFast navigates without full load wait.
func (pa *ProtocolAdapter) NavigateFast(url string) error {
	if pa.cdp != nil {
		return pa.cdp.NavigateFast(url)
	}
	return pa.bidi.Navigate(url)
}

// NavigateDom navigates with DOMContentLoaded wait.
func (pa *ProtocolAdapter) NavigateDom(url string) error {
	if pa.cdp != nil {
		return pa.cdp.NavigateDom(url)
	}
	return pa.bidi.Navigate(url)
}

// GetHTML returns the page HTML.
func (pa *ProtocolAdapter) GetHTML() (string, error) {
	if pa.cdp != nil {
		return pa.cdp.GetHTML()
	}
	return pa.bidi.GetHTML()
}

// Evaluate evaluates JavaScript.
func (pa *ProtocolAdapter) Evaluate(expression string) (any, error) {
	if pa.cdp != nil {
		return pa.cdp.Evaluate(expression)
	}
	return pa.bidi.Evaluate(expression)
}

// CaptureScreenshot captures a screenshot as base64 PNG.
func (pa *ProtocolAdapter) CaptureScreenshot() (string, error) {
	if pa.cdp != nil {
		return pa.cdp.CaptureScreenshot()
	}
	return pa.bidi.CaptureScreenshot()
}

// ClickPoint clicks at viewport coordinates.
func (pa *ProtocolAdapter) ClickPoint(x, y float64) error {
	if pa.cdp != nil {
		return pa.cdp.ClickPoint(x, y)
	}
	return pa.bidi.ClickPoint(x, y)
}

// RightClickPoint right-clicks at coordinates.
func (pa *ProtocolAdapter) RightClickPoint(x, y float64) error {
	if pa.cdp != nil {
		return pa.cdp.RightClickPoint(x, y)
	}
	return pa.bidi.PerformActions([]map[string]any{
		{
			"type": "pointer", "id": "mouse",
			"actions": []map[string]any{
				{"type": "pointerMove", "x": int(math.Round(x)), "y": int(math.Round(y))},
				{"type": "pointerDown", "button": 2},
				{"type": "pointerUp", "button": 2},
			},
		},
	})
}

// DoubleClickPoint double-clicks at coordinates.
func (pa *ProtocolAdapter) DoubleClickPoint(x, y float64) error {
	if pa.cdp != nil {
		return pa.cdp.DoubleClickPoint(x, y)
	}
	return pa.bidi.PerformActions([]map[string]any{
		{
			"type": "pointer", "id": "mouse",
			"actions": []map[string]any{
				{"type": "pointerMove", "x": int(math.Round(x)), "y": int(math.Round(y))},
				{"type": "pointerDown", "button": 0},
				{"type": "pointerUp", "button": 0},
				{"type": "pointerDown", "button": 0},
				{"type": "pointerUp", "button": 0},
			},
		},
	})
}

// ClickHoldPoint clicks and holds at coordinates.
func (pa *ProtocolAdapter) ClickHoldPoint(x, y float64, holdMs int) error {
	if pa.cdp != nil {
		return pa.cdp.ClickHoldPoint(x, y, holdMs)
	}
	return pa.bidi.PerformActions([]map[string]any{
		{
			"type": "pointer", "id": "mouse",
			"actions": []map[string]any{
				{"type": "pointerMove", "x": int(math.Round(x)), "y": int(math.Round(y))},
				{"type": "pointerDown", "button": 0},
				{"type": "pause", "duration": holdMs},
				{"type": "pointerUp", "button": 0},
			},
		},
	})
}

// HoverPoint moves the mouse to coordinates.
func (pa *ProtocolAdapter) HoverPoint(x, y float64) error {
	if pa.cdp != nil {
		return pa.cdp.HoverPoint(x, y)
	}
	return pa.bidi.PerformActions([]map[string]any{
		{
			"type": "pointer", "id": "mouse",
			"actions": []map[string]any{
				{"type": "pointerMove", "x": int(math.Round(x)), "y": int(math.Round(y))},
			},
		},
	})
}

// DragPoint smoothly drags from one point to another.
func (pa *ProtocolAdapter) DragPoint(fromX, fromY, toX, toY float64) error {
	if pa.cdp != nil {
		return pa.cdp.DragPoint(fromX, fromY, toX, toY)
	}
	steps := 10
	actions := []map[string]any{
		{"type": "pointerMove", "x": int(math.Round(fromX)), "y": int(math.Round(fromY))},
		{"type": "pointerDown", "button": 0},
	}
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		actions = append(actions, map[string]any{
			"type":     "pointerMove",
			"x":        int(math.Round(fromX + (toX-fromX)*t)),
			"y":        int(math.Round(fromY + (toY-fromY)*t)),
			"duration": 16,
		})
	}
	actions = append(actions, map[string]any{"type": "pointerUp", "button": 0})
	return pa.bidi.PerformActions([]map[string]any{
		{"type": "pointer", "id": "mouse", "actions": actions},
	})
}

// InsertText inserts text.
func (pa *ProtocolAdapter) InsertText(text string) error {
	if pa.cdp != nil {
		return pa.cdp.InsertText(text)
	}
	return pa.bidi.InsertText(text)
}

// PressKey presses a named key.
func (pa *ProtocolAdapter) PressKey(keyName string) error {
	p := getKeyParams(keyName)
	if pa.cdp != nil {
		return pa.cdp.PressKey(p.Key, p.Code, p.KeyCode)
	}
	return pa.bidi.PerformActions([]map[string]any{
		{
			"type": "key", "id": "keyboard",
			"actions": []map[string]any{
				{"type": "keyDown", "value": p.Key},
				{"type": "keyUp", "value": p.Key},
			},
		},
	})
}

// KeyDown sends a keyDown event.
func (pa *ProtocolAdapter) KeyDown(keyName string) error {
	p := getKeyParams(keyName)
	if pa.cdp != nil {
		return pa.cdp.KeyDown(p.Key, p.Code, p.KeyCode)
	}
	return pa.bidi.PerformActions([]map[string]any{
		{
			"type": "key", "id": "keyboard",
			"actions": []map[string]any{
				{"type": "keyDown", "value": p.Key},
			},
		},
	})
}

// KeyUp sends a keyUp event.
func (pa *ProtocolAdapter) KeyUp(keyName string) error {
	p := getKeyParams(keyName)
	if pa.cdp != nil {
		return pa.cdp.KeyUp(p.Key, p.Code, p.KeyCode)
	}
	return pa.bidi.PerformActions([]map[string]any{
		{
			"type": "key", "id": "keyboard",
			"actions": []map[string]any{
				{"type": "keyUp", "value": p.Key},
			},
		},
	})
}

// SetViewport sets viewport dimensions.
func (pa *ProtocolAdapter) SetViewport(width, height int, deviceScaleFactor float64, mobile bool) error {
	if pa.cdp != nil {
		return pa.cdp.SetViewport(width, height, deviceScaleFactor, mobile)
	}
	expr := fmt.Sprintf("window.resizeTo(%d, %d)", width, height)
	_, err := pa.bidi.Evaluate(expr)
	return err
}

// Destroy cleans up resources.
func (pa *ProtocolAdapter) Destroy() {
	if pa.cdp != nil {
		pa.cdp.Destroy()
		pa.cdp = nil
	}
	if pa.bidi != nil {
		pa.bidi.Destroy()
		pa.bidi = nil
	}
}
