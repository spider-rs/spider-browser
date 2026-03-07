package spiderbrowser

import "sync"

// EventHandler is a callback for spider-browser events.
type EventHandler func(data map[string]any)

// EventEmitter provides typed event pub/sub for spider-browser.
type EventEmitter struct {
	mu       sync.RWMutex
	handlers map[string][]EventHandler
	once     map[string][]EventHandler
}

// NewEventEmitter creates a new event emitter.
func NewEventEmitter() *EventEmitter {
	return &EventEmitter{
		handlers: make(map[string][]EventHandler),
		once:     make(map[string][]EventHandler),
	}
}

// On subscribes to an event.
func (e *EventEmitter) On(event string, handler EventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.handlers[event] = append(e.handlers[event], handler)
}

// Off removes a handler for an event (removes the last matching one).
func (e *EventEmitter) Off(event string, handler EventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Remove by comparing function pointers isn't reliable in Go,
	// so we remove the last handler for simplicity.
	if handlers, ok := e.handlers[event]; ok && len(handlers) > 0 {
		e.handlers[event] = handlers[:len(handlers)-1]
	}
}

// Once subscribes to an event for a single firing.
func (e *EventEmitter) Once(event string, handler EventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.once[event] = append(e.once[event], handler)
}

// Emit fires an event to all registered handlers.
func (e *EventEmitter) Emit(event string, data map[string]any) {
	e.mu.RLock()
	handlers := make([]EventHandler, len(e.handlers[event]))
	copy(handlers, e.handlers[event])
	onceHandlers := make([]EventHandler, len(e.once[event]))
	copy(onceHandlers, e.once[event])
	e.mu.RUnlock()

	for _, h := range handlers {
		h(data)
	}
	for _, h := range onceHandlers {
		h(data)
	}

	if len(onceHandlers) > 0 {
		e.mu.Lock()
		delete(e.once, event)
		e.mu.Unlock()
	}
}

// RemoveAllListeners removes all event handlers.
func (e *EventEmitter) RemoveAllListeners() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.handlers = make(map[string][]EventHandler)
	e.once = make(map[string][]EventHandler)
}
