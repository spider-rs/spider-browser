package spiderbrowser

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SpiderPage provides deterministic browser tab automation.
// All standard browser automation methods (no LLM required).
type SpiderPage struct {
	adapter *ProtocolAdapter
	emitter *EventEmitter
	llm     LLMProvider
}

// NewSpiderPage creates a new page instance.
func NewSpiderPage(adapter *ProtocolAdapter) *SpiderPage {
	return &SpiderPage{adapter: adapter}
}

// newSpiderPageWithAI creates a new page instance with the parent browser's
// event emitter and LLM provider wired through so SpiderPage.Agent works
// with zero extra config. Used internally by SpiderBrowser.Init.
func newSpiderPageWithAI(adapter *ProtocolAdapter, emitter *EventEmitter, llm LLMProvider) *SpiderPage {
	return &SpiderPage{adapter: adapter, emitter: emitter, llm: llm}
}

// SetAdapter replaces the adapter (used during browser switching).
func (p *SpiderPage) SetAdapter(adapter *ProtocolAdapter) {
	p.adapter = adapter
}

// Agent runs an autonomous agent scoped to THIS page/tab only.
//
// Unlike SpiderBrowser.NewAgent, the agent is instructed (and best-effort
// guarded via an injected script) to stay in the current tab: no new
// tabs/windows, target="_blank" links open in-place.
//
// Uses the browser's configured LLM by default; set opts.LLM to override
// with a different provider for this run.
func (p *SpiderPage) Agent(instruction string, opts *AgentOptions) (*AgentResult, error) {
	o := AgentOptions{}
	if opts != nil {
		o = *opts
	}
	provider := p.llm
	if o.LLM != nil {
		provider = CreateProvider(*o.LLM)
	}
	if provider == nil {
		return nil, ErrLLMNotConfigured
	}
	o.Scope = AgentScopePage
	emitter := p.emitter
	if emitter == nil {
		emitter = NewEventEmitter()
	}
	agent := NewAgent(p.adapter, provider, emitter, &o)
	return agent.Execute(instruction)
}

// --- Navigation ---

// Goto navigates to a URL and waits for load.
func (p *SpiderPage) Goto(url string) error {
	return p.adapter.Navigate(url)
}

// GotoFast navigates without waiting for full page load (5s max).
func (p *SpiderPage) GotoFast(url string) error {
	return p.adapter.NavigateFast(url)
}

// GotoDom navigates and returns on DOMContentLoaded (3s max).
func (p *SpiderPage) GotoDom(url string) error {
	return p.adapter.NavigateDom(url)
}

// GoBack navigates back in browser history.
func (p *SpiderPage) GoBack() error {
	_, err := p.adapter.Evaluate("window.history.back()")
	return err
}

// GoForward navigates forward in browser history.
func (p *SpiderPage) GoForward() error {
	_, err := p.adapter.Evaluate("window.history.forward()")
	return err
}

// Reload reloads the page.
func (p *SpiderPage) Reload() error {
	_, err := p.adapter.Evaluate("window.location.reload()")
	return err
}

// --- Content ---

// Content gets the full page HTML with readiness detection.
func (p *SpiderPage) Content(waitMs int, minLength int) (string, error) {
	if waitMs == 0 {
		waitMs = 8000
	}
	if minLength == 0 {
		minLength = 1000
	}

	// Fast path: check if content is already sufficient
	if waitMs > 0 {
		earlyHTML, err := p.adapter.GetHTML()
		if err == nil && len(earlyHTML) >= minLength &&
			!isInterstitialContent(earlyHTML) && !isRateLimitContent(earlyHTML) {
			return earlyHTML, nil
		}
		p.WaitForNetworkIdle(waitMs)
	}

	html, err := p.adapter.GetHTML()
	if err != nil {
		return "", err
	}

	// Interstitial detection
	if waitMs > 0 && isInterstitialContent(html) {
		waits := []time.Duration{2000, 2000, 3000, 4000, 5000, 7000, 7000}
		for _, wait := range waits {
			time.Sleep(wait * time.Millisecond)
			html, _ = p.adapter.GetHTML()
			if !isInterstitialContent(html) {
				break
			}
			if len(html) > 15000 {
				break
			}
		}
		if isInterstitialContent(html) {
			return "", newBlockedError("Page stuck on interstitial challenge")
		}
	}

	// Rate limit detection
	if waitMs > 0 && isRateLimitContent(html) {
		return "", newBlockedError("Rate limit exceeded (site-level)")
	}

	// Incremental quality check
	if waitMs > 0 && len(html) < minLength {
		increments := []time.Duration{300, 500, 800, 1200}
		for _, extra := range increments {
			time.Sleep(extra * time.Millisecond)
			updated, _ := p.adapter.GetHTML()
			if len(updated) > len(html) {
				html = updated
			}
			if len(html) >= minLength {
				break
			}
		}
		// Polling phase
		if len(html) < minLength {
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				time.Sleep(1 * time.Second)
				polled, _ := p.adapter.GetHTML()
				if len(polled) > len(html) {
					html = polled
				}
				if len(html) >= minLength {
					break
				}
			}
		}
	}

	return html, nil
}

// RawContent gets the page HTML without readiness waiting.
func (p *SpiderPage) RawContent() (string, error) {
	return p.adapter.GetHTML()
}

// ContentWithEarlyReturn polls for content with early return.
func (p *SpiderPage) ContentWithEarlyReturn(maxWaitMs, minContentLength, pollIntervalMs int) (string, error) {
	if maxWaitMs == 0 {
		maxWaitMs = 15000
	}
	if minContentLength == 0 {
		minContentLength = 500
	}
	if pollIntervalMs == 0 {
		pollIntervalMs = 2000
	}

	deadline := time.Now().Add(time.Duration(maxWaitMs) * time.Millisecond)
	for time.Now().Before(deadline) {
		html, _ := p.adapter.GetHTML()
		if len(html) >= minContentLength &&
			!isInterstitialContent(html) && !isRateLimitContent(html) {
			return html, nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		interval := time.Duration(pollIntervalMs) * time.Millisecond
		if interval > remaining {
			interval = remaining
		}
		time.Sleep(interval)
	}
	html, err := p.adapter.GetHTML()
	if err != nil {
		return "", err
	}
	return html, nil
}

// ContentWithNetworkIdle uses network idle detection + polling.
func (p *SpiderPage) ContentWithNetworkIdle(maxWaitMs, minContentLength, interstitialBudgetMs int) (string, error) {
	if maxWaitMs == 0 {
		maxWaitMs = 20000
	}
	if minContentLength == 0 {
		minContentLength = 1000
	}
	if interstitialBudgetMs == 0 {
		interstitialBudgetMs = 16000
	}

	deadline := time.Now().Add(time.Duration(maxWaitMs) * time.Millisecond)

	// Phase 1: Quick check
	html, _ := p.adapter.GetHTML()
	if len(html) >= minContentLength && !isInterstitialContent(html) && !isRateLimitContent(html) {
		return html, nil
	}

	// Phase 2: Wait for readyState
	domDeadline := time.Now().Add(5 * time.Second)
	if domDeadline.After(deadline) {
		domDeadline = deadline
	}
	for time.Now().Before(domDeadline) {
		state, _ := p.adapter.Evaluate("document.readyState")
		if s, ok := state.(string); ok && (s == "interactive" || s == "complete") {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Phase 3: Network+DOM idle via JS
	idleMs := 400
	idleCheckMs := 8000
	remaining := int(time.Until(deadline).Milliseconds())
	if remaining < idleCheckMs {
		idleCheckMs = remaining
	}
	if idleCheckMs > 500 {
		p.adapter.Evaluate(fmt.Sprintf(`
			new Promise((resolve) => {
				let lastActivity = Date.now();
				const idleThreshold = %d;
				const deadline = Date.now() + %d;
				const perfObs = new PerformanceObserver(() => { lastActivity = Date.now(); });
				try { perfObs.observe({ entryTypes: ['resource'] }); } catch(e) {}
				const mutObs = new MutationObserver(() => { lastActivity = Date.now(); });
				mutObs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
				const check = () => {
					const now = Date.now();
					if (now >= deadline || (now - lastActivity >= idleThreshold)) {
						perfObs.disconnect(); mutObs.disconnect(); resolve(true); return;
					}
					setTimeout(check, 100);
				};
				setTimeout(check, idleThreshold);
			})
		`, idleMs, idleCheckMs))
	}

	html, _ = p.adapter.GetHTML()
	if len(html) >= minContentLength && !isInterstitialContent(html) && !isRateLimitContent(html) {
		return html, nil
	}

	// Phase 4: Interstitial handling
	if isInterstitialContent(html) {
		iDeadline := time.Now().Add(time.Duration(interstitialBudgetMs) * time.Millisecond)
		if iDeadline.After(deadline) {
			iDeadline = deadline
		}
		waits := []time.Duration{2000, 2000, 3000, 4000, 5000, 7000, 10000}
		for _, wait := range waits {
			if time.Now().After(iDeadline) {
				break
			}
			w := wait * time.Millisecond
			rem := time.Until(iDeadline)
			if w > rem {
				w = rem
			}
			time.Sleep(w)
			html, _ = p.adapter.GetHTML()
			if !isInterstitialContent(html) {
				break
			}
			if len(html) > 15000 {
				break
			}
		}
		if isInterstitialContent(html) {
			return "", newBlockedError("Page stuck on interstitial challenge")
		}
	}

	if isRateLimitContent(html) {
		return "", newBlockedError("Rate limit exceeded (site-level)")
	}

	// Phase 5: Final polling
	if len(html) < minContentLength {
		for time.Now().Before(deadline) {
			time.Sleep(1 * time.Second)
			polled, _ := p.adapter.GetHTML()
			if len(polled) > len(html) {
				html = polled
			}
			if len(html) >= minContentLength {
				break
			}
		}
	}

	return html, nil
}

// Title gets the page title.
func (p *SpiderPage) Title() (string, error) {
	val, err := p.adapter.Evaluate("document.title")
	if err != nil {
		return "", err
	}
	if s, ok := val.(string); ok {
		return s, nil
	}
	return "", nil
}

// URL gets the current page URL.
func (p *SpiderPage) URL() (string, error) {
	val, err := p.adapter.Evaluate("window.location.href")
	if err != nil {
		return "", err
	}
	if s, ok := val.(string); ok {
		return s, nil
	}
	return "", nil
}

// Screenshot captures a screenshot as base64 PNG.
func (p *SpiderPage) Screenshot() (string, error) {
	return p.adapter.CaptureScreenshot()
}

// Evaluate evaluates JavaScript and returns the result.
func (p *SpiderPage) Evaluate(expression string) (any, error) {
	return p.adapter.Evaluate(expression)
}

// ---------------------------------------------------------------------
// Session snapshots — persist a session and resume it later
// ---------------------------------------------------------------------

// SaveSnapshot saves the current session as a portable snapshot to persist and
// restore later — cookies, local/session storage, the current URL, extra
// request headers, and the viewport. Returns the snapshot blob; store it and
// pass it back to RestoreSnapshot to resume. Pass an empty snapshotID to let
// the server assign one.
func (p *SpiderPage) SaveSnapshot(snapshotID string) (any, error) {
	params := map[string]any{}
	if snapshotID != "" {
		params["id"] = snapshotID
	}
	resp, err := p.adapter.SendCommand("Snapshot.capture", params)
	if err != nil {
		return nil, err
	}
	// Return the blob directly for ergonomic round-tripping.
	if m, ok := resp.(map[string]any); ok {
		if blob, ok := m["snapshot"]; ok {
			return blob, nil
		}
	}
	return resp, nil
}

// RestoreSnapshot restores a previously saved session snapshot into this page.
// Accepts the blob returned by SaveSnapshot or the full capture result.
func (p *SpiderPage) RestoreSnapshot(snapshot any) (any, error) {
	blob := snapshot
	if m, ok := snapshot.(map[string]any); ok {
		if inner, ok := m["snapshot"]; ok {
			blob = inner
		}
	}
	return p.adapter.SendCommand("Snapshot.restore", map[string]any{"snapshot": blob})
}

// DeleteSnapshot deletes a saved snapshot by id from the browser's local cache.
func (p *SpiderPage) DeleteSnapshot(snapshotID string) (any, error) {
	return p.adapter.SendCommand("Snapshot.delete", map[string]any{"id": snapshotID})
}

// --- Click Actions ---

// Click clicks an element by CSS selector.
func (p *SpiderPage) Click(selector string) error {
	x, y, err := p.getElementCenter(selector)
	if err != nil {
		return err
	}
	return p.adapter.ClickPoint(x, y)
}

// ClickAt clicks at specific viewport coordinates.
func (p *SpiderPage) ClickAt(x, y float64) error {
	return p.adapter.ClickPoint(x, y)
}

// Dblclick double-clicks an element by CSS selector.
func (p *SpiderPage) Dblclick(selector string) error {
	x, y, err := p.getElementCenter(selector)
	if err != nil {
		return err
	}
	return p.adapter.DoubleClickPoint(x, y)
}

// RightClick right-clicks an element by CSS selector.
func (p *SpiderPage) RightClick(selector string) error {
	x, y, err := p.getElementCenter(selector)
	if err != nil {
		return err
	}
	return p.adapter.RightClickPoint(x, y)
}

// ClickAndHold clicks and holds an element for a duration.
func (p *SpiderPage) ClickAndHold(selector string, holdMs int) error {
	if holdMs == 0 {
		holdMs = 1000
	}
	x, y, err := p.getElementCenter(selector)
	if err != nil {
		return err
	}
	return p.adapter.ClickHoldPoint(x, y, holdMs)
}

// ClickAndHoldAt clicks and holds at coordinates for a duration.
func (p *SpiderPage) ClickAndHoldAt(x, y float64, holdMs int) error {
	if holdMs == 0 {
		holdMs = 1000
	}
	return p.adapter.ClickHoldPoint(x, y, holdMs)
}

// ClickAll clicks all elements matching a selector.
func (p *SpiderPage) ClickAll(selector string) error {
	val, err := p.adapter.Evaluate(fmt.Sprintf(`
		(function() {
			var els = document.querySelectorAll(%s);
			return Array.from(els).map(function(el) {
				var r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			});
		})()
	`, jsonString(selector)))
	if err != nil {
		return err
	}
	if points, ok := val.([]any); ok {
		for _, pt := range points {
			if m, ok := pt.(map[string]any); ok {
				x, _ := toFloat64(m["x"])
				y, _ := toFloat64(m["y"])
				if err := p.adapter.ClickPoint(x, y); err != nil {
					return err
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
	}
	return nil
}

// --- Input Actions ---

// Fill fills a form field — focus, clear, type new value.
func (p *SpiderPage) Fill(selector, value string) error {
	// Clear via JS
	p.adapter.Evaluate(fmt.Sprintf(`
		(function() {
			var el = document.querySelector(%s);
			if (el) { el.focus(); el.value = ''; }
		})()
	`, jsonString(selector)))

	// Click for real focus
	x, y, err := p.getElementCenter(selector)
	if err == nil {
		p.adapter.ClickPoint(x, y)
	}

	// Insert text
	if err := p.adapter.InsertText(value); err != nil {
		return err
	}

	// Dispatch events
	_, err = p.adapter.Evaluate(fmt.Sprintf(`
		(function() {
			var el = document.querySelector(%s);
			if (el) {
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}
		})()
	`, jsonString(selector)))
	return err
}

// Type types text into the currently focused element.
func (p *SpiderPage) Type(value string) error {
	return p.adapter.InsertText(value)
}

// Press presses a named key (e.g. "Enter", "Tab", "Escape").
func (p *SpiderPage) Press(key string) error {
	return p.adapter.PressKey(key)
}

// Clear clears an input field.
func (p *SpiderPage) Clear(selector string) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf(
		"document.querySelector(%s).value = ''", jsonString(selector),
	))
	return err
}

// Select selects an option in a <select> element.
func (p *SpiderPage) Select(selector, value string) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf(`
		(function() {
			var el = document.querySelector(%s);
			if (el) {
				el.value = %s;
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}
		})()
	`, jsonString(selector), jsonString(value)))
	return err
}

// --- Focus & Hover ---

// Focus focuses an element.
func (p *SpiderPage) Focus(selector string) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf(
		"document.querySelector(%s)?.focus()", jsonString(selector),
	))
	return err
}

// Blur unfocuses an element.
func (p *SpiderPage) Blur(selector string) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf(
		"document.querySelector(%s)?.blur()", jsonString(selector),
	))
	return err
}

// Hover hovers over an element.
func (p *SpiderPage) Hover(selector string) error {
	x, y, err := p.getElementCenter(selector)
	if err != nil {
		return err
	}
	return p.adapter.HoverPoint(x, y)
}

// --- Drag ---

// Drag drags from one element to another.
func (p *SpiderPage) Drag(fromSelector, toSelector string) error {
	fx, fy, err := p.getElementCenter(fromSelector)
	if err != nil {
		return err
	}
	tx, ty, err := p.getElementCenter(toSelector)
	if err != nil {
		return err
	}
	return p.adapter.DragPoint(fx, fy, tx, ty)
}

// --- Scroll ---

// ScrollY scrolls vertically by pixels (positive = down).
func (p *SpiderPage) ScrollY(pixels int) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf("window.scrollBy(0, %d)", pixels))
	return err
}

// ScrollX scrolls horizontally by pixels (positive = right).
func (p *SpiderPage) ScrollX(pixels int) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf("window.scrollBy(%d, 0)", pixels))
	return err
}

// ScrollTo scrolls an element into view.
func (p *SpiderPage) ScrollTo(selector string) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf(
		"document.querySelector(%s)?.scrollIntoView({ behavior: 'smooth', block: 'center' })",
		jsonString(selector),
	))
	return err
}

// ScrollToPoint scrolls to absolute page coordinates.
func (p *SpiderPage) ScrollToPoint(x, y int) error {
	_, err := p.adapter.Evaluate(fmt.Sprintf("window.scrollTo(%d, %d)", x, y))
	return err
}

// --- Wait ---

// WaitForSelector waits for a CSS selector to appear in the DOM.
func (p *SpiderPage) WaitForSelector(selector string, timeoutMs int) error {
	if timeoutMs == 0 {
		timeoutMs = 5000
	}
	interval := 100 * time.Millisecond
	maxIter := timeoutMs / 100
	checkJS := fmt.Sprintf("!!document.querySelector(%s)", jsonString(selector))
	for i := 0; i < maxIter; i++ {
		found, _ := p.adapter.Evaluate(checkJS)
		if b, ok := found.(bool); ok && b {
			return nil
		}
		time.Sleep(interval)
	}
	return newTimeoutError(fmt.Sprintf("Timeout waiting for selector: %s", selector))
}

// WaitForNavigation waits for navigation/page load (simple delay).
func (p *SpiderPage) WaitForNavigation(timeoutMs int) error {
	if timeoutMs == 0 {
		timeoutMs = 5000
	}
	wait := timeoutMs
	if wait > 1000 {
		wait = 1000
	}
	time.Sleep(time.Duration(wait) * time.Millisecond)
	return nil
}

// WaitForReady waits until page is fully loaded and DOM is stable.
func (p *SpiderPage) WaitForReady(timeoutMs int) error {
	if timeoutMs == 0 {
		timeoutMs = 10000
	}
	start := time.Now()
	pollInterval := 200 * time.Millisecond
	stableThreshold := 500 * time.Millisecond

	// Phase 1: wait for readyState === 'complete'
	for time.Since(start) < time.Duration(timeoutMs)*time.Millisecond {
		state, _ := p.adapter.Evaluate("document.readyState")
		if s, ok := state.(string); ok && s == "complete" {
			break
		}
		time.Sleep(pollInterval)
	}

	// Phase 2: wait for DOM content length to stabilize
	lastLength := 0
	stableSince := time.Now()
	for time.Since(start) < time.Duration(timeoutMs)*time.Millisecond {
		val, _ := p.adapter.Evaluate("document.documentElement.innerHTML.length")
		length := toIntVal(val)
		if length != lastLength {
			lastLength = length
			stableSince = time.Now()
		} else if time.Since(stableSince) >= stableThreshold {
			return nil
		}
		time.Sleep(pollInterval)
	}
	return nil
}

// WaitForContent waits until page content exceeds a minimum length.
func (p *SpiderPage) WaitForContent(minLength, timeoutMs int) error {
	if minLength == 0 {
		minLength = 500
	}
	if timeoutMs == 0 {
		timeoutMs = 8000
	}
	start := time.Now()
	for time.Since(start) < time.Duration(timeoutMs)*time.Millisecond {
		val, _ := p.adapter.Evaluate("document.documentElement.innerHTML.length")
		if toIntVal(val) >= minLength {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil
}

// WaitForNetworkIdle waits for network idle + DOM stability.
func (p *SpiderPage) WaitForNetworkIdle(timeoutMs int) error {
	if timeoutMs == 0 {
		timeoutMs = 8000
	}
	start := time.Now()
	pollInterval := 250 * time.Millisecond

	// Phase 1: wait for readyState
	for time.Since(start) < time.Duration(timeoutMs)*time.Millisecond {
		state, _ := p.adapter.Evaluate("document.readyState")
		if s, ok := state.(string); ok && s == "complete" {
			break
		}
		time.Sleep(pollInterval)
	}

	// Phase 2: inject network+DOM stability checker
	idleMs := 400
	remaining := timeoutMs - int(time.Since(start).Milliseconds())
	if remaining < 1000 {
		remaining = 1000
	}
	p.adapter.Evaluate(fmt.Sprintf(`
		new Promise((resolve) => {
			let lastActivity = Date.now();
			const idleThreshold = %d;
			const deadline = Date.now() + %d;
			const perfObs = new PerformanceObserver(() => { lastActivity = Date.now(); });
			try { perfObs.observe({ entryTypes: ['resource'] }); } catch(e) {}
			const mutObs = new MutationObserver(() => { lastActivity = Date.now(); });
			mutObs.observe(document.documentElement, {
				childList: true, subtree: true, attributes: true
			});
			const check = () => {
				const now = Date.now();
				if (now >= deadline || (now - lastActivity >= idleThreshold)) {
					perfObs.disconnect(); mutObs.disconnect(); resolve(true); return;
				}
				setTimeout(check, 100);
			};
			setTimeout(check, idleThreshold);
		})
	`, idleMs, remaining))
	return nil
}

// --- Viewport ---

// SetViewport sets the viewport dimensions.
func (p *SpiderPage) SetViewport(width, height int, deviceScaleFactor float64, mobile bool) error {
	if deviceScaleFactor == 0 {
		deviceScaleFactor = 2
	}
	return p.adapter.SetViewport(width, height, deviceScaleFactor, mobile)
}

// --- DOM Queries ---

// QuerySelector returns the outer HTML of the first matching element.
func (p *SpiderPage) QuerySelector(selector string) (string, error) {
	val, err := p.adapter.Evaluate(fmt.Sprintf(
		"document.querySelector(%s)?.outerHTML ?? null", jsonString(selector),
	))
	if err != nil {
		return "", err
	}
	if s, ok := val.(string); ok {
		return s, nil
	}
	return "", nil
}

// QuerySelectorAll returns outer HTML of all matching elements.
func (p *SpiderPage) QuerySelectorAll(selector string) ([]string, error) {
	val, err := p.adapter.Evaluate(fmt.Sprintf(
		"Array.from(document.querySelectorAll(%s)).map(function(el) { return el.outerHTML; })",
		jsonString(selector),
	))
	if err != nil {
		return nil, err
	}
	if arr, ok := val.([]any); ok {
		result := make([]string, 0, len(arr))
		for _, v := range arr {
			if s, ok := v.(string); ok {
				result = append(result, s)
			}
		}
		return result, nil
	}
	return nil, nil
}

// TextContent gets the text content of an element.
func (p *SpiderPage) TextContent(selector string) (string, error) {
	val, err := p.adapter.Evaluate(fmt.Sprintf(
		"document.querySelector(%s)?.textContent ?? null", jsonString(selector),
	))
	if err != nil {
		return "", err
	}
	if s, ok := val.(string); ok {
		return s, nil
	}
	return "", nil
}

// FieldSpec describes how to extract a field. Use TextSelector for text content
// or AttrSelector for attribute values.
type FieldSpec struct {
	Selector  string
	Attribute string // empty = textContent
}

// ExtractFields extracts multiple fields from the page in a single call.
func (p *SpiderPage) ExtractFields(fields map[string]FieldSpec) (map[string]string, error) {
	type fieldEntry struct {
		Key       string  `json:"key"`
		Selector  string  `json:"selector"`
		Attribute *string `json:"attribute"`
	}

	entries := make([]fieldEntry, 0, len(fields))
	for key, spec := range fields {
		var attr *string
		if spec.Attribute != "" {
			attr = &spec.Attribute
		}
		entries = append(entries, fieldEntry{
			Key:       key,
			Selector:  spec.Selector,
			Attribute: attr,
		})
	}

	entriesJSON, _ := json.Marshal(entries)

	val, err := p.adapter.Evaluate(fmt.Sprintf(`
		(function() {
			var fields = %s;
			var result = {};
			for (var i = 0; i < fields.length; i++) {
				var f = fields[i];
				var el = document.querySelector(f.selector);
				result[f.key] = el
					? (f.attribute ? el.getAttribute(f.attribute) : (el.textContent || '').trim()) || null
					: null;
			}
			return JSON.stringify(result);
		})()
	`, string(entriesJSON)))
	if err != nil {
		return nil, err
	}

	result := make(map[string]string)
	if s, ok := val.(string); ok {
		var parsed map[string]*string
		if err := json.Unmarshal([]byte(s), &parsed); err == nil {
			for k, v := range parsed {
				if v != nil {
					result[k] = *v
				}
			}
		}
	}
	return result, nil
}

// ScrapeOptions configures Scrape. The zero value declares nothing, which is
// the zero-config mode: the AI infers the fields from the page itself.
type ScrapeOptions struct {
	// Fields holds your own CSS selectors. Nil lets the AI choose the fields.
	Fields map[string]FieldSpec
	// Domain is a target domain for built-in pattern lookup (e.g. "amazon.com").
	Domain string
	// Slug selects a specific built-in pattern (e.g. "amazon-scraper").
	Slug string
	// DisableAI turns off AI resolution of fields CSS can't reach. The
	// zero-config mode requires AI, so it fails when this is set.
	DisableAI bool
}

// Scrape extracts structured data from the current page.
//
// Server-side CSS extraction with an AI fallback for fields selectors can't
// resolve. Four modes, selected by opts:
//
//  1. Nothing declared, AI names the fields itself from the page
//  2. Fields, your own CSS selectors
//  3. Domain, built-in patterns
//  4. Slug, a specific built-in pattern
//
// A Domain or Slug with no built-in pattern falls through to mode 1 rather
// than returning nothing.
//
// Falls back to client-side ExtractFields when the server has no
// Spider.scrape (e.g. a raw CDP endpoint). Mode 1 needs the server, since the
// AI runs there.
func (p *SpiderPage) Scrape(opts ScrapeOptions) (map[string]string, error) {
	params := map[string]any{"aiFallback": !opts.DisableAI}

	if opts.Fields != nil {
		fields := make(map[string]any, len(opts.Fields))
		for key, spec := range opts.Fields {
			if spec.Attribute == "" {
				fields[key] = spec.Selector
			} else {
				fields[key] = map[string]string{
					"selector":  spec.Selector,
					"attribute": spec.Attribute,
				}
			}
		}
		params["fields"] = fields
	}
	if opts.Domain != "" {
		params["domain"] = opts.Domain
	}
	if opts.Slug != "" {
		params["slug"] = opts.Slug
	}

	// Try server-side Spider.scrape first (browser_server with extract crate).
	if resp, err := p.adapter.SendCommand("Spider.scrape", params); err == nil {
		if obj, ok := resp.(map[string]any); ok {
			if _, isErr := obj["error"]; !isErr {
				result := make(map[string]string, len(obj))
				for k, v := range obj {
					if s, ok := v.(string); ok {
						result[k] = s
					}
				}
				return result, nil
			}
		}
	}

	// Fallback: client-side ExtractFields (only works with custom fields).
	if opts.Fields != nil {
		return p.ExtractFields(opts.Fields)
	}

	return nil, fmt.Errorf(
		"Scrape without Fields needs server-side AI extraction, which this connection " +
			"does not support. Connect through Spider (not a raw CDP endpoint), or set Fields " +
			"with CSS selectors")
}

// --- Internals ---

func (p *SpiderPage) getElementCenter(selector string) (float64, float64, error) {
	val, err := p.adapter.Evaluate(fmt.Sprintf(`
		(function() {
			var el = document.querySelector(%s);
			if (!el) return null;
			el.scrollIntoView({ block: 'center', behavior: 'instant' });
			var r = el.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		})()
	`, jsonString(selector)))
	if err != nil {
		return 0, 0, err
	}
	if m, ok := val.(map[string]any); ok {
		x, _ := toFloat64(m["x"])
		y, _ := toFloat64(m["y"])
		return x, y, nil
	}
	return 0, 0, &ErrElementNotFound{Selector: selector}
}

func isInterstitialContent(html string) bool {
	if len(html) > 15000 {
		return false
	}
	lower := strings.ToLower(html)
	keywords := []string{
		"just a moment", "checking your browser",
		"please wait while we verify", "verifying the device",
		"available after verification", "ddos-guard",
		"challenge-platform", "px-captcha",
		"_cf_chl_opt", "managed_challenge",
		"datadome", "ak_bmsc", "please enable cookies",
	}
	for _, kw := range keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	if len(html) < 5000 {
		if strings.Contains(lower, "loading...") || strings.Contains(lower, "loading results") {
			return true
		}
		if strings.Contains(lower, "please wait") && !strings.Contains(lower, "article") {
			return true
		}
	}
	return false
}

func isRateLimitContent(html string) bool {
	if len(html) > 20000 {
		return false
	}
	lower := strings.ToLower(html)
	return strings.Contains(lower, "rate limit exceeded") ||
		strings.Contains(lower, "too many requests") ||
		(strings.Contains(lower, "rate limit") && strings.Contains(lower, "please try again"))
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func toIntVal(v any) int {
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
