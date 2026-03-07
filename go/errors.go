// Package spiderbrowser provides a browser automation client for Spider's
// pre-warmed browser fleet with smart retry and browser switching.
package spiderbrowser

import "fmt"

// SpiderError is the base error type for all spider-browser errors.
type SpiderError struct {
	Message   string
	Code      string
	Retryable bool
}

func (e *SpiderError) Error() string { return e.Message }

// ConnectionError represents a WebSocket connection or transport error.
type ConnectionError struct {
	SpiderError
	WSCode int
}

func newConnectionError(msg string, wsCode ...int) *ConnectionError {
	code := 0
	if len(wsCode) > 0 {
		code = wsCode[0]
	}
	return &ConnectionError{
		SpiderError: SpiderError{Message: msg, Code: "CONNECTION_ERROR", Retryable: true},
		WSCode:      code,
	}
}

// AuthError represents an authentication failure (401/402). Never retried.
type AuthError struct{ SpiderError }

func newAuthError(msg string) *AuthError {
	return &AuthError{SpiderError{Message: msg, Code: "AUTH_ERROR", Retryable: false}}
}

// RateLimitError represents a rate limit (429). Retried with delay.
type RateLimitError struct {
	SpiderError
	RetryAfterMs int
}

func newRateLimitError(msg string, retryAfterMs ...int) *RateLimitError {
	ms := 0
	if len(retryAfterMs) > 0 {
		ms = retryAfterMs[0]
	}
	return &RateLimitError{
		SpiderError:  SpiderError{Message: msg, Code: "RATE_LIMIT", Retryable: true},
		RetryAfterMs: ms,
	}
}

// BlockedError indicates the browser was blocked by the target site.
type BlockedError struct{ SpiderError }

func newBlockedError(msg string) *BlockedError {
	return &BlockedError{SpiderError{Message: msg, Code: "BLOCKED", Retryable: true}}
}

// BackendUnavailableError indicates the requested browser backend is unavailable.
type BackendUnavailableError struct{ SpiderError }

func newBackendUnavailableError(msg string) *BackendUnavailableError {
	return &BackendUnavailableError{SpiderError{Message: msg, Code: "BACKEND_UNAVAILABLE", Retryable: true}}
}

// TimeoutError indicates a timeout waiting for a response or navigation.
type TimeoutError struct{ SpiderError }

func newTimeoutError(msg string) *TimeoutError {
	return &TimeoutError{SpiderError{Message: msg, Code: "TIMEOUT", Retryable: true}}
}

// ProtocolError indicates a protocol-level error (invalid CDP/BiDi response).
type ProtocolError struct{ SpiderError }

func newProtocolError(msg string) *ProtocolError {
	return &ProtocolError{SpiderError{Message: msg, Code: "PROTOCOL_ERROR", Retryable: false}}
}

// NavigationError indicates a retryable navigation error.
type NavigationError struct{ SpiderError }

func newNavigationError(msg string) *NavigationError {
	return &NavigationError{SpiderError{Message: msg, Code: "NAVIGATION_ERROR", Retryable: true}}
}

// LLMError indicates an LLM call failure.
type LLMError struct{ SpiderError }

func newLLMError(msg string) *LLMError {
	return &LLMError{SpiderError{Message: msg, Code: "LLM_ERROR", Retryable: true}}
}

// ErrNotInitialized is returned when methods are called before Init().
var ErrNotInitialized = fmt.Errorf("SpiderBrowser not initialized — call Init() first")

// ErrLLMNotConfigured is returned when AI methods are called without LLM config.
var ErrLLMNotConfigured = fmt.Errorf("LLM not configured — pass LLM option to SpiderBrowserOptions for AI methods")

// ErrElementNotFound is returned when a CSS selector matches no elements.
type ErrElementNotFound struct {
	Selector string
}

func (e *ErrElementNotFound) Error() string {
	return fmt.Sprintf("element not found: %s", e.Selector)
}
