package spiderbrowser

import (
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type bidiPendingRequest struct {
	ch    chan *BiDiResponse
	timer *time.Timer
}

// BiDiSession manages a WebDriver BiDi session (for Firefox).
type BiDiSession struct {
	mu             sync.Mutex
	nextID         int64
	pending        sync.Map // int -> *bidiPendingRequest
	eventHandlers  sync.Map // string -> []func(map[string]any)
	transport      *Transport
	contextID      string
	commandTimeout time.Duration
}

// NewBiDiSession creates a new BiDi session.
func NewBiDiSession(transport *Transport, commandTimeout time.Duration) *BiDiSession {
	if commandTimeout == 0 {
		commandTimeout = 30 * time.Second
	}
	return &BiDiSession{
		transport:      transport,
		commandTimeout: commandTimeout,
	}
}

// HandleMessage processes a raw message from the transport.
func (s *BiDiSession) HandleMessage(data string) bool {
	var raw map[string]any
	if err := json.Unmarshal([]byte(data), &raw); err != nil {
		return false
	}

	// Response (has "id")
	if idRaw, ok := raw["id"]; ok {
		id := toInt(idRaw)
		if val, loaded := s.pending.LoadAndDelete(id); loaded {
			pr := val.(*bidiPendingRequest)
			pr.timer.Stop()
			var resp BiDiResponse
			json.Unmarshal([]byte(data), &resp)
			pr.ch <- &resp
			return true
		}
		return false
	}

	// Event (type === "event")
	if tp, ok := raw["type"].(string); ok && tp == "event" {
		method, _ := raw["method"].(string)
		params := map[string]any{}
		if p, ok := raw["params"].(map[string]any); ok {
			params = p
		}
		s.fireEvent(method, params)
		return true
	}

	return false
}

// Send sends a BiDi command and waits for the response.
func (s *BiDiSession) Send(method string, params map[string]any) (*BiDiResponse, error) {
	id := int(atomic.AddInt64(&s.nextID, 1))
	if params == nil {
		params = map[string]any{}
	}
	cmd := BiDiCommand{
		ID:     id,
		Method: method,
		Params: params,
	}

	cmdJSON, err := json.Marshal(cmd)
	if err != nil {
		return nil, err
	}

	pr := &bidiPendingRequest{
		ch: make(chan *BiDiResponse, 1),
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
		return nil, newTimeoutError(fmt.Sprintf("BiDi command timeout: %s (%v)", method, s.commandTimeout))
	}
	if resp.Type == "error" {
		return nil, newProtocolError(fmt.Sprintf("BiDi error: %s: %s", resp.Error, resp.Message))
	}
	return resp, nil
}

// On subscribes to a BiDi event.
func (s *BiDiSession) On(method string, handler func(map[string]any)) {
	val, _ := s.eventHandlers.LoadOrStore(method, &[]func(map[string]any){})
	handlers := val.(*[]func(map[string]any))
	s.mu.Lock()
	*handlers = append(*handlers, handler)
	s.mu.Unlock()
}

// Off removes a BiDi event handler.
func (s *BiDiSession) Off(method string, handler func(map[string]any)) {
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

func (s *BiDiSession) fireEvent(method string, params map[string]any) {
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

// GetOrCreateContext gets or creates a browsing context.
func (s *BiDiSession) GetOrCreateContext() (string, error) {
	// Try to get existing contexts
	resp, err := s.Send("browsingContext.getTree", map[string]any{})
	if err == nil && resp.Result != nil {
		if contexts, ok := resp.Result["contexts"].([]any); ok && len(contexts) > 0 {
			if ctx, ok := contexts[0].(map[string]any); ok {
				if ctxID, ok := ctx["context"].(string); ok {
					s.contextID = ctxID
					return ctxID, nil
				}
			}
		}
	}

	// Create a new context
	resp, err = s.Send("browsingContext.create", map[string]any{
		"type": "tab",
	})
	if err != nil {
		return "", err
	}
	if resp.Result != nil {
		if ctxID, ok := resp.Result["context"].(string); ok {
			s.contextID = ctxID
			return ctxID, nil
		}
	}

	return "", newProtocolError("Failed to create browsing context")
}

// Navigate navigates to a URL in the BiDi context.
func (s *BiDiSession) Navigate(url string) error {
	_, err := s.Send("browsingContext.navigate", map[string]any{
		"context": s.contextID,
		"url":     url,
		"wait":    "complete",
	})
	return err
}

// GetHTML returns the full page HTML via script.evaluate.
func (s *BiDiSession) GetHTML() (string, error) {
	val, err := s.Evaluate("document.documentElement.outerHTML")
	if err != nil {
		return "", err
	}
	if str, ok := val.(string); ok {
		return str, nil
	}
	return "", nil
}

// Evaluate evaluates a JavaScript expression.
func (s *BiDiSession) Evaluate(expression string) (any, error) {
	resp, err := s.Send("script.evaluate", map[string]any{
		"expression":  expression,
		"target":      map[string]any{"context": s.contextID},
		"awaitPromise": true,
		"resultOwnership": "none",
	})
	if err != nil {
		return nil, err
	}
	if resp.Result != nil {
		if result, ok := resp.Result["result"].(map[string]any); ok {
			return extractBiDiValue(result), nil
		}
	}
	return nil, nil
}

// CaptureScreenshot captures a screenshot via BiDi.
func (s *BiDiSession) CaptureScreenshot() (string, error) {
	resp, err := s.Send("browsingContext.captureScreenshot", map[string]any{
		"context": s.contextID,
	})
	if err != nil {
		return "", err
	}
	if resp.Result != nil {
		if data, ok := resp.Result["data"].(string); ok {
			return data, nil
		}
	}
	return "", newProtocolError("captureScreenshot: missing result.data")
}

// ClickPoint clicks at viewport coordinates via BiDi input actions.
func (s *BiDiSession) ClickPoint(x, y float64) error {
	return s.PerformActions([]map[string]any{
		{
			"type": "pointer",
			"id":   "mouse",
			"actions": []map[string]any{
				{"type": "pointerMove", "x": int(x), "y": int(y)},
				{"type": "pointerDown", "button": 0},
				{"type": "pointerUp", "button": 0},
			},
		},
	})
}

// PerformActions performs input actions via BiDi.
func (s *BiDiSession) PerformActions(actions []map[string]any) error {
	_, err := s.Send("input.performActions", map[string]any{
		"context": s.contextID,
		"actions": actions,
	})
	return err
}

// InsertText inserts text via BiDi key actions.
func (s *BiDiSession) InsertText(text string) error {
	actions := make([]map[string]any, 0, len(text)*2)
	for _, ch := range text {
		actions = append(actions,
			map[string]any{"type": "keyDown", "value": string(ch)},
			map[string]any{"type": "keyUp", "value": string(ch)},
		)
	}
	return s.PerformActions([]map[string]any{
		{
			"type":    "key",
			"id":      "keyboard",
			"actions": actions,
		},
	})
}

// Destroy cleans up the BiDi session.
func (s *BiDiSession) Destroy() {
	s.pending.Range(func(key, value any) bool {
		pr := value.(*bidiPendingRequest)
		pr.timer.Stop()
		close(pr.ch)
		s.pending.Delete(key)
		return true
	})
	s.eventHandlers = sync.Map{}
}

// extractBiDiValue extracts a value from a BiDi result object.
func extractBiDiValue(result map[string]any) any {
	tp, _ := result["type"].(string)
	switch tp {
	case "string":
		return result["value"]
	case "number":
		return result["value"]
	case "boolean":
		return result["value"]
	case "null", "undefined":
		return nil
	case "array":
		if arr, ok := result["value"].([]any); ok {
			out := make([]any, len(arr))
			for i, v := range arr {
				if m, ok := v.(map[string]any); ok {
					out[i] = extractBiDiValue(m)
				} else {
					out[i] = v
				}
			}
			return out
		}
	case "object":
		if pairs, ok := result["value"].([]any); ok {
			out := make(map[string]any)
			for _, pair := range pairs {
				if p, ok := pair.([]any); ok && len(p) == 2 {
					key, _ := p[0].(string)
					if vm, ok := p[1].(map[string]any); ok {
						out[key] = extractBiDiValue(vm)
					} else {
						out[key] = p[1]
					}
				}
			}
			return out
		}
	}
	return result["value"]
}
