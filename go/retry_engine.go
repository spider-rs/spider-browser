package spiderbrowser

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Browser rotation constants
var (
	primaryRotation  = []string{"chrome", "chrome-new", "chrome-h", "navi"}
	extendedRotation = []string{"firefox", "lightpanda", "servo"}
)

// RetryEngineOptions configures the retry engine.
type RetryEngineOptions struct {
	MaxRetries      int
	Emitter         *EventEmitter
	MaxStealthLevel int
	InitialStealth  int
	RetryTimeout    time.Duration
	CommandTimeout  time.Duration
}

// RetryContext provides the context for retry operations.
type RetryContext struct {
	Transport        *Transport
	Adapter          *ProtocolAdapter
	CurrentURL       string
	Emitter          *EventEmitter
	OnAdapterChanged func(*ProtocolAdapter)
}

// RetryEngine orchestrates retries with browser switching and stealth escalation.
type RetryEngine struct {
	maxRetries     int
	emitter        *EventEmitter
	maxStealth     int
	currentStealth int
	retryTimeout   time.Duration
	commandTimeout time.Duration
	downBackends   map[string]bool
}

// NewRetryEngine creates a new retry engine.
func NewRetryEngine(opts RetryEngineOptions) *RetryEngine {
	if opts.MaxRetries == 0 {
		opts.MaxRetries = 12
	}
	if opts.MaxStealthLevel == 0 {
		opts.MaxStealthLevel = 3
	}
	if opts.RetryTimeout == 0 {
		opts.RetryTimeout = 15 * time.Second
	}
	if opts.CommandTimeout == 0 {
		opts.CommandTimeout = 30 * time.Second
	}
	return &RetryEngine{
		maxRetries:     opts.MaxRetries,
		emitter:        opts.Emitter,
		maxStealth:     opts.MaxStealthLevel,
		currentStealth: opts.InitialStealth,
		retryTimeout:   opts.RetryTimeout,
		commandTimeout: opts.CommandTimeout,
		downBackends:   make(map[string]bool),
	}
}

// StealthLevel returns the current stealth level.
func (re *RetryEngine) StealthLevel() int {
	return re.currentStealth
}

// Execute runs an action with smart retry across browsers and stealth levels.
func (re *RetryEngine) Execute(fn func() error, ctx *RetryContext) error {
	var lastErr error
	totalAttempts := 0
	budget := re.maxRetries + 1
	re.downBackends = make(map[string]bool)
	wasBlocked := false
	consecutiveDisconnects := 0
	primaryDisconnects := 0

	stealthLevels := re.getStealthProgression()
	initialBrowser := ctx.Transport.Browser()

	for si, stealth := range stealthLevels {
		if totalAttempts >= budget {
			break
		}

		// Stealth escalation
		if si > 0 {
			prev := stealthLevels[si-1]
			re.currentStealth = stealth
			ctx.Transport.SetStealthLevel(stealth)
			defaultLogger.info(fmt.Sprintf("retry: escalating stealth %d -> %d", prev, stealth))
			re.emitter.Emit("stealth.escalated", map[string]any{
				"from":   prev,
				"to":     stealth,
				"reason": classifyErrorStr(lastErr),
			})
		}

		// Phase 1: Try PRIMARY browsers
		primaryBrowsers := primaryRotation
		if si == 0 {
			primaryBrowsers = orderedPrimaryBrowsers(initialBrowser)
		}

		triedAny := false

		for _, browser := range primaryBrowsers {
			if totalAttempts >= budget {
				break
			}
			if re.downBackends[browser] {
				continue
			}
			if consecutiveDisconnects >= 3 {
				defaultLogger.warn("retry: 3+ consecutive disconnects, aborting")
				break
			}

			success, tried, attempts, err := re.tryBrowser(fn, ctx, browser, stealth, totalAttempts, budget, true)
			totalAttempts = attempts
			if tried {
				triedAny = true
			}
			if success {
				return nil
			}
			if err != nil {
				lastErr = err
				errClass := classifyError(err)
				wasBlocked = errClass == "blocked"
				if errClass == "auth" {
					return err
				}
				if isDisconnectionError(err) {
					consecutiveDisconnects++
					primaryDisconnects++
				} else {
					consecutiveDisconnects = 0
				}
			}
		}

		// Phase 2: Try EXTENDED browsers if blocked
		if primaryDisconnects >= 2 && !wasBlocked {
			wasBlocked = true
		}
		if wasBlocked && totalAttempts < budget {
			for _, browser := range extendedRotation {
				if totalAttempts >= budget {
					break
				}
				if re.downBackends[browser] {
					continue
				}

				success, tried, attempts, err := re.tryBrowser(fn, ctx, browser, stealth, totalAttempts, budget, false)
				totalAttempts = attempts
				if tried {
					triedAny = true
				}
				if success {
					return nil
				}
				if err != nil {
					lastErr = err
					if classifyError(err) == "auth" {
						return err
					}
				}
			}
		}

		if !triedAny {
			defaultLogger.warn("retry: all browser backends unavailable")
			break
		}
	}

	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("all browsers and stealth levels exhausted")
}

func (re *RetryEngine) tryBrowser(fn func() error, ctx *RetryContext, browser string, stealth, totalAttempts, budget int, allowTransient bool) (bool, bool, int, error) {
	var lastErr error

	// Switch browser
	if totalAttempts > 0 {
		prevBrowser := ctx.Transport.Browser()
		defaultLogger.info(fmt.Sprintf("retry: switching %s -> %s (stealth=%d)", prevBrowser, browser, stealth))
		re.emitter.Emit("browser.switching", map[string]any{
			"from": prevBrowser, "to": browser, "reason": "rotation",
		})
		if err := re.switchBrowser(ctx, browser); err != nil {
			if _, ok := err.(*BackendUnavailableError); ok {
				re.downBackends[browser] = true
				return false, false, totalAttempts, nil
			}
			defaultLogger.warn(fmt.Sprintf("retry: switch to %s failed: %v", browser, err))
			return false, false, totalAttempts, err
		}
		re.emitter.Emit("browser.switched", map[string]any{"browser": browser})
	}

	maxTransient := 0
	if allowTransient {
		maxTransient = 2
	}
	transientRetries := 0

	for totalAttempts < budget {
		totalAttempts++

		err := fn()
		if err == nil {
			return true, true, totalAttempts, nil
		}

		lastErr = err
		errClass := classifyError(err)

		defaultLogger.warn(fmt.Sprintf("retry: attempt %d/%d failed error=%v class=%s browser=%s stealth=%d",
			totalAttempts, budget, err, errClass, browser, stealth))
		re.emitter.Emit("retry.attempt", map[string]any{
			"attempt": totalAttempts, "maxRetries": re.maxRetries, "error": err.Error(),
		})

		if errClass == "auth" {
			return false, true, totalAttempts, lastErr
		}
		if errClass == "rate_limit" {
			time.Sleep(2 * time.Second)
			continue
		}
		if errClass == "backend_down" {
			re.downBackends[browser] = true
			return false, true, totalAttempts, lastErr
		}
		if errClass == "blocked" {
			return false, true, totalAttempts, lastErr
		}
		if errClass == "transient" && isDisconnectionError(err) {
			return false, true, totalAttempts, lastErr
		}
		if errClass == "transient" && transientRetries < maxTransient {
			transientRetries++
			time.Sleep(100 * time.Millisecond)
			continue
		}
		return false, true, totalAttempts, lastErr
	}

	return false, true, totalAttempts, lastErr
}

func (re *RetryEngine) switchBrowser(ctx *RetryContext, newBrowser string) error {
	ctx.Adapter.Destroy()
	if err := ctx.Transport.Reconnect(newBrowser); err != nil {
		return err
	}

	newAdapter := NewProtocolAdapter(ctx.Transport, ctx.Emitter, newBrowser, re.commandTimeout)
	if err := newAdapter.Init(); err != nil {
		return err
	}
	ctx.Adapter = newAdapter
	if ctx.OnAdapterChanged != nil {
		ctx.OnAdapterChanged(newAdapter)
	}

	if ctx.CurrentURL != "" {
		if err := newAdapter.Navigate(ctx.CurrentURL); err != nil {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil
}

func (re *RetryEngine) getStealthProgression() []int {
	levels := []int{re.currentStealth}
	next := 1
	if re.currentStealth >= 1 {
		next = re.currentStealth + 1
	}
	for next <= re.maxStealth {
		levels = append(levels, next)
		next++
	}
	return levels
}

func orderedPrimaryBrowsers(start string) []string {
	idx := -1
	for i, b := range primaryRotation {
		if b == start {
			idx = i
			break
		}
	}
	if idx <= 0 {
		result := make([]string, len(primaryRotation))
		copy(result, primaryRotation)
		return result
	}
	return append(append([]string{}, primaryRotation[idx:]...), primaryRotation[:idx]...)
}

func classifyError(err error) string {
	if err == nil {
		return "transient"
	}
	switch err.(type) {
	case *AuthError:
		return "auth"
	case *RateLimitError:
		return "rate_limit"
	case *BlockedError:
		return "blocked"
	case *BackendUnavailableError:
		return "backend_down"
	case *TimeoutError:
		return "transient"
	case *ConnectionError:
		return "transient"
	case *NavigationError:
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "err_aborted") || strings.Contains(msg, "err_blocked_by_client") {
			return "blocked"
		}
		return "transient"
	}
	return classifyErrorStr(err)
}

func classifyErrorStr(err error) string {
	if err == nil {
		return "transient"
	}
	msg := strings.ToLower(err.Error())

	blockedKW := []string{
		"bot detection", "bot detected", "are you a robot",
		"blocked", "403", "captcha", "network security",
		"human verification", "verify you are human",
		"checking your browser", "bot protection",
		"automated access", "pardon our interruption",
		"powered and protected by", "request could not be processed",
		"access to this page has been denied", "access denied",
		"please complete the security check", "enable cookies",
		"browser check", "just a moment",
		"rate limit exceeded", "too many requests",
		"err_aborted", "err_blocked_by_client",
	}
	for _, kw := range blockedKW {
		if strings.Contains(msg, kw) {
			return "blocked"
		}
	}
	if strings.Contains(msg, "401") || strings.Contains(msg, "402") || strings.Contains(msg, "unauthorized") {
		return "auth"
	}
	if strings.Contains(msg, "429") {
		return "rate_limit"
	}
	backendKW := []string{"backend unavailable", "no backend", "service unavailable", "503"}
	for _, kw := range backendKW {
		if strings.Contains(msg, kw) {
			return "backend_down"
		}
	}
	return "transient"
}

func isDisconnectionError(err error) bool {
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "err_aborted") || strings.Contains(msg, "err_blocked_by_client") {
		return false
	}
	if _, ok := err.(*NavigationError); ok {
		return true
	}
	dcKW := []string{
		"websocket is not connected", "websocket closed",
		"session destroyed", "session with given id not found",
		"err_connection_reset", "err_connection_closed",
		"err_empty_response", "socket hang up",
	}
	for _, kw := range dcKW {
		if strings.Contains(msg, kw) {
			return true
		}
	}
	return false
}

func extractDomain(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
