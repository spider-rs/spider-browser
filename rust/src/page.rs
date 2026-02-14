//! SpiderPage -- deterministic browser tab abstraction.
//!
//! All standard browser automation methods (no LLM required).
//! Works over both CDP (Chrome/Servo/LightPanda) and BiDi (Firefox)
//! through the [`ProtocolAdapter`].

use crate::errors::{Result, SpiderError};
use crate::protocol::protocol_adapter::ProtocolAdapter;
use arc_swap::ArcSwap;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::sleep;

/// Browser tab abstraction with full automation API.
///
/// Wraps a [`ProtocolAdapter`] and exposes high-level navigation, content
/// extraction, click/input/scroll primitives, wait helpers, and viewport
/// control. The adapter can be swapped atomically via [`set_adapter`] during
/// browser rotation without dropping inflight references.
pub struct SpiderPage {
    adapter: ArcSwap<ProtocolAdapter>,
}

impl SpiderPage {
    // -----------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------

    /// Create a new `SpiderPage` wrapping the given protocol adapter.
    pub fn new(adapter: ProtocolAdapter) -> Self {
        Self {
            adapter: ArcSwap::from_pointee(adapter),
        }
    }

    /// Create a new `SpiderPage` from an already-`Arc`-wrapped adapter.
    pub fn from_arc(adapter: Arc<ProtocolAdapter>) -> Self {
        Self {
            adapter: ArcSwap::from(adapter),
        }
    }

    /// Load the current adapter snapshot. All methods go through this.
    #[inline]
    pub(crate) fn adapter(&self) -> arc_swap::Guard<Arc<ProtocolAdapter>> {
        self.adapter.load()
    }

    // =================================================================
    // Navigation
    // =================================================================

    /// Navigate to a URL and wait for load.
    pub async fn goto(&self, url: &str) -> Result<()> {
        self.adapter().navigate(url).await
    }

    /// Navigate without waiting for full page load (5 s max wait).
    /// Use with [`content_with_early_return`] for SPAs that never fire
    /// `loadEventFired`.
    pub async fn goto_fast(&self, url: &str) -> Result<()> {
        self.adapter().navigate_fast(url).await
    }

    /// Navigate and return as soon as `DOMContentLoaded` fires (3 s max).
    /// Fastest option -- the DOM shell is ready but subresources may still
    /// load. Pair with [`content_with_early_return`] or
    /// [`content_with_network_idle`] for best results.
    pub async fn goto_dom(&self, url: &str) -> Result<()> {
        self.adapter().navigate_dom(url).await
    }

    /// Go back in browser history.
    pub async fn go_back(&self) -> Result<()> {
        self.adapter().evaluate("window.history.back()").await?;
        Ok(())
    }

    /// Go forward in browser history.
    pub async fn go_forward(&self) -> Result<()> {
        self.adapter().evaluate("window.history.forward()").await?;
        Ok(())
    }

    /// Reload the page.
    pub async fn reload(&self) -> Result<()> {
        self.adapter().evaluate("window.location.reload()").await?;
        Ok(())
    }

    // =================================================================
    // Content
    // =================================================================

    /// Get the full page HTML, ensuring the page is ready first.
    ///
    /// Waits for network idle + DOM stability, then checks content quality.
    /// If the content seems incomplete (too short or looks like a loading
    /// state), does incremental waits with exponential backoff before
    /// returning.
    ///
    /// * `wait_ms`   -- Max time to wait for readiness (default 8000).
    ///                  Pass 0 to skip readiness checks and return
    ///                  immediately.
    /// * `min_length` -- Minimum content length to consider "good"
    ///                   (default 1000).
    pub async fn content(&self, wait_ms: u64, min_length: usize) -> Result<String> {
        // ---- SSR fast path ----
        // Check if content is already sufficient before waiting for network
        // idle.  SSR pages have full HTML available immediately after
        // navigation, so this skips the expensive networkIdle wait.
        if wait_ms > 0 {
            let early_html = self.adapter().get_html().await.unwrap_or_default();
            if early_html.len() >= min_length
                && !Self::is_interstitial_content(&early_html)
                && !Self::is_rate_limit_content(&early_html)
            {
                return Ok(early_html);
            }
            self.wait_for_network_idle(wait_ms).await?;
        }

        let mut html = self.adapter().get_html().await.unwrap_or_default();

        // ---- Interstitial detection ----
        // Cloudflare "Just a moment...", PerimeterX "Verifying the
        // device...", and similar interstitials auto-resolve after a few
        // seconds.  PerimeterX can take 30-45 s.
        // Graduated waits: 2+2+3+4+5+7+7 = 30 s max.
        // No no-growth early exit: PerimeterX pages stay identical during
        // JS verification then suddenly redirect when challenge passes.
        // Must wait the full budget.
        if wait_ms > 0 && Self::is_interstitial_content(&html) {
            let interstitial_waits: &[u64] = &[2000, 2000, 3000, 4000, 5000, 7000, 7000];
            for &wait in interstitial_waits {
                sleep(Duration::from_millis(wait)).await;
                html = self.adapter().get_html().await.unwrap_or_default();
                if !Self::is_interstitial_content(&html) {
                    break;
                }
                // Content-growth early exit: real page rendered
                if html.len() > 15_000 {
                    break;
                }
            }
            // If still an interstitial after all waits, throw Blocked so
            // retry engine rotates browser.
            if Self::is_interstitial_content(&html) {
                return Err(SpiderError::Blocked(
                    "Page stuck on interstitial challenge".into(),
                ));
            }
        }

        // ---- Site-level rate limiting ----
        // Throw Blocked so retry engine rotates browser (new profile).
        if wait_ms > 0 && Self::is_rate_limit_content(&html) {
            return Err(SpiderError::Blocked(
                "Rate limit exceeded (site-level)".into(),
            ));
        }

        // ---- Incremental quality check ----
        // If content seems incomplete, wait progressively.  After
        // incremental waits, fall back to polling (catches SPAs that never
        // fire load but have content available via client-side rendering).
        if wait_ms > 0 && html.len() < min_length {
            let increments: &[u64] = &[300, 500, 800, 1200];
            for &extra in increments {
                sleep(Duration::from_millis(extra)).await;
                let updated = self.adapter().get_html().await.unwrap_or_default();
                if updated.len() > html.len() {
                    html = updated;
                }
                if html.len() >= min_length {
                    break;
                }
            }
            // If still short after incremental waits, do a brief polling
            // phase. This catches SPAs that render content asynchronously
            // after page load.
            if html.len() < min_length {
                let poll_deadline = Instant::now() + Duration::from_millis(3000);
                while Instant::now() < poll_deadline {
                    sleep(Duration::from_millis(1000)).await;
                    let polled = self.adapter().get_html().await.unwrap_or_default();
                    if polled.len() > html.len() {
                        html = polled;
                    }
                    if html.len() >= min_length {
                        break;
                    }
                }
            }
        }

        Ok(html)
    }

    /// Get the raw page HTML without any readiness waiting.
    /// Use this when you need immediate access or have already waited.
    pub async fn raw_content(&self) -> Result<String> {
        self.adapter().get_html().await
    }

    /// Poll for content with early return -- for SPAs that never fire
    /// `loadEventFired`.
    ///
    /// Instead of waiting for a full page load event, this polls for HTML
    /// content at regular intervals and returns as soon as sufficient
    /// content is available.  Useful for timeout retries where the page
    /// loads data asynchronously.
    ///
    /// * `max_wait_ms`        -- Max time to poll (default 15 s).
    /// * `min_content_length` -- Minimum HTML length to accept (default 500).
    /// * `poll_interval_ms`   -- Interval between polls (default 2 s).
    pub async fn content_with_early_return(
        &self,
        max_wait_ms: u64,
        min_content_length: usize,
        poll_interval_ms: u64,
    ) -> Result<String> {
        let deadline = Instant::now() + Duration::from_millis(max_wait_ms);
        while Instant::now() < deadline {
            let html = self.adapter().get_html().await.unwrap_or_default();
            if html.len() >= min_content_length
                && !Self::is_interstitial_content(&html)
                && !Self::is_rate_limit_content(&html)
            {
                return Ok(html);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let wait = Duration::from_millis(poll_interval_ms).min(remaining);
            sleep(wait).await;
        }
        // Final attempt -- return whatever we have
        Ok(self.adapter().get_html().await.unwrap_or_default())
    }

    /// Get content using network idle detection + polling hybrid approach.
    ///
    /// Best for heavy SPAs: uses `PerformanceObserver` + `MutationObserver`
    /// to detect when the page stops loading, combined with content-length
    /// thresholds.
    ///
    /// Strategy:
    /// 1. Wait for `readyState=interactive` (DOM parsed)
    /// 2. Start network+DOM idle monitoring (400 ms silence threshold)
    /// 3. Poll HTML length -- return early if sufficient + idle
    /// 4. Interstitial detection with configurable wait budget
    ///
    /// * `max_wait_ms`           -- Max total time to wait (default 20 s).
    /// * `min_content_length`    -- Minimum HTML length to accept (default 1000).
    /// * `interstitial_budget_ms` -- Max time to wait for interstitials to
    ///                               resolve (default 16 s, use 30 s for
    ///                               retries).
    pub async fn content_with_network_idle(
        &self,
        max_wait_ms: u64,
        min_content_length: usize,
        interstitial_budget_ms: u64,
    ) -> Result<String> {
        let deadline = Instant::now() + Duration::from_millis(max_wait_ms);

        // Phase 1: Quick check -- SSR pages have content immediately
        let mut html = self.adapter().get_html().await.unwrap_or_default();
        if html.len() >= min_content_length
            && !Self::is_interstitial_content(&html)
            && !Self::is_rate_limit_content(&html)
        {
            return Ok(html);
        }

        // Phase 2: Wait for readyState=interactive or complete (DOM parsed)
        let dom_deadline = deadline.min(Instant::now() + Duration::from_millis(5000));
        while Instant::now() < dom_deadline {
            let state = self.adapter().evaluate("document.readyState").await;
            if let Ok(val) = state {
                let s = val.as_str().unwrap_or("");
                if s == "interactive" || s == "complete" {
                    break;
                }
            }
            sleep(Duration::from_millis(200)).await;
        }

        // Phase 3: Network + DOM idle monitoring with content polling.
        // Inject a combined observer that tracks resource loads and DOM
        // mutations.
        let idle_ms: u64 = 400;
        let idle_check_ms = {
            let remaining = deadline.saturating_duration_since(Instant::now());
            remaining.as_millis().min(8000) as u64
        };
        if idle_check_ms > 500 {
            let js = format!(
                r#"
                new Promise((resolve) => {{
                    let lastActivity = Date.now();
                    const idleThreshold = {idle_ms};
                    const deadline = Date.now() + {idle_check_ms};
                    const perfObs = new PerformanceObserver(() => {{ lastActivity = Date.now(); }});
                    try {{ perfObs.observe({{ entryTypes: ['resource'] }}); }} catch(e) {{}}
                    const mutObs = new MutationObserver(() => {{ lastActivity = Date.now(); }});
                    mutObs.observe(document.documentElement, {{ childList: true, subtree: true, attributes: true }});
                    const check = () => {{
                        const now = Date.now();
                        if (now >= deadline || (now - lastActivity >= idleThreshold)) {{
                            perfObs.disconnect(); mutObs.disconnect(); resolve(true); return;
                        }}
                        setTimeout(check, 100);
                    }};
                    setTimeout(check, idleThreshold);
                }})
                "#
            );
            if self.adapter().evaluate(&js).await.is_err() {
                sleep(Duration::from_millis(500)).await;
            }
        }

        // Check content after idle
        html = self.adapter().get_html().await.unwrap_or_default();
        if html.len() >= min_content_length
            && !Self::is_interstitial_content(&html)
            && !Self::is_rate_limit_content(&html)
        {
            return Ok(html);
        }

        // Phase 4: Interstitial handling with configurable budget.
        // No no-growth early exit: PerimeterX/Akamai pages stay identical
        // during JS verification then suddenly redirect. Must wait the
        // full budget.
        if Self::is_interstitial_content(&html) {
            let i_deadline =
                deadline.min(Instant::now() + Duration::from_millis(interstitial_budget_ms));
            let waits: &[u64] = &[2000, 2000, 3000, 4000, 5000, 7000, 10000];
            for &wait in waits {
                if Instant::now() >= i_deadline {
                    break;
                }
                let remaining = i_deadline.saturating_duration_since(Instant::now());
                let actual_wait = Duration::from_millis(wait).min(remaining);
                sleep(actual_wait).await;
                html = self.adapter().get_html().await.unwrap_or_default();
                if !Self::is_interstitial_content(&html) {
                    break;
                }
                if html.len() > 15_000 {
                    break;
                }
            }
            if Self::is_interstitial_content(&html) {
                return Err(SpiderError::Blocked(
                    "Page stuck on interstitial challenge".into(),
                ));
            }
        }

        if Self::is_rate_limit_content(&html) {
            return Err(SpiderError::Blocked(
                "Rate limit exceeded (site-level)".into(),
            ));
        }

        // Phase 5: Final polling for async content
        if html.len() < min_content_length {
            while Instant::now() < deadline {
                sleep(Duration::from_millis(1000)).await;
                let polled = self.adapter().get_html().await.unwrap_or_default();
                if polled.len() > html.len() {
                    html = polled;
                }
                if html.len() >= min_content_length {
                    break;
                }
            }
        }

        Ok(html)
    }

    // =================================================================
    // Info
    // =================================================================

    /// Get the page title.
    pub async fn title(&self) -> Result<String> {
        let val = self.adapter().evaluate("document.title").await?;
        Ok(val.as_str().unwrap_or("").to_string())
    }

    /// Get the current page URL.
    pub async fn url(&self) -> Result<String> {
        let val = self.adapter().evaluate("window.location.href").await?;
        Ok(val.as_str().unwrap_or("").to_string())
    }

    /// Capture a screenshot as base64 PNG.
    pub async fn screenshot(&self) -> Result<String> {
        self.adapter().capture_screenshot().await
    }

    /// Evaluate arbitrary JavaScript and return the result.
    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        self.adapter().evaluate(expression).await
    }

    // =================================================================
    // Click Actions
    // =================================================================

    /// Click an element by CSS selector.
    pub async fn click(&self, selector: &str) -> Result<()> {
        let (x, y) = self.get_element_center(selector).await?;
        self.adapter().click_point(x, y).await
    }

    /// Click at specific viewport coordinates.
    pub async fn click_at(&self, x: f64, y: f64) -> Result<()> {
        self.adapter().click_point(x, y).await
    }

    /// Double-click an element by CSS selector.
    pub async fn dblclick(&self, selector: &str) -> Result<()> {
        let (x, y) = self.get_element_center(selector).await?;
        self.adapter().double_click_point(x, y).await
    }

    /// Right-click an element by CSS selector.
    pub async fn right_click(&self, selector: &str) -> Result<()> {
        let (x, y) = self.get_element_center(selector).await?;
        self.adapter().right_click_point(x, y).await
    }

    /// Click and hold an element for a duration.
    ///
    /// Useful for long-press interactions, drag initiation, and
    /// mobile-style gestures.
    ///
    /// * `selector` -- CSS selector of the element.
    /// * `hold_ms`  -- Duration in milliseconds to hold (default 1000).
    pub async fn click_and_hold(&self, selector: &str, hold_ms: u64) -> Result<()> {
        let (x, y) = self.get_element_center(selector).await?;
        self.adapter().click_hold_point(x, y, hold_ms).await
    }

    /// Click and hold at specific viewport coordinates for a duration.
    ///
    /// * `x`       -- X coordinate (CSS pixels).
    /// * `y`       -- Y coordinate (CSS pixels).
    /// * `hold_ms` -- Duration in milliseconds to hold (default 1000).
    pub async fn click_and_hold_at(&self, x: f64, y: f64, hold_ms: u64) -> Result<()> {
        self.adapter().click_hold_point(x, y, hold_ms).await
    }

    /// Click all elements matching a selector.
    pub async fn click_all(&self, selector: &str) -> Result<()> {
        let escaped = serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!(
            r#"
            (function() {{
                const els = document.querySelectorAll({escaped});
                return Array.from(els).map(el => {{
                    const r = el.getBoundingClientRect();
                    return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
                }});
            }})()
            "#
        );
        let result = self.adapter().evaluate(&js).await?;
        if let Some(points) = result.as_array() {
            for pt in points {
                let x = pt.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = pt.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                self.adapter().click_point(x, y).await?;
                sleep(Duration::from_millis(100)).await;
            }
        }
        Ok(())
    }

    // =================================================================
    // Input Actions
    // =================================================================

    /// Fill a form field -- focus, clear existing value, type new value.
    pub async fn fill(&self, selector: &str, value: &str) -> Result<()> {
        let escaped_sel =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        // Clear via JS
        let clear_js = format!(
            r#"
            (function() {{
                const el = document.querySelector({escaped_sel});
                if (el) {{ el.focus(); el.value = ''; }}
            }})()
            "#
        );
        self.adapter().evaluate(&clear_js).await?;

        // Click to ensure focus with real browser event
        if let Ok((x, y)) = self.get_element_center(selector).await {
            let _ = self.adapter().click_point(x, y).await;
        }

        // Insert text
        self.adapter().insert_text(value).await?;

        // Dispatch input + change events
        let dispatch_js = format!(
            r#"
            (function() {{
                const el = document.querySelector({escaped_sel});
                if (el) {{
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }})()
            "#
        );
        self.adapter().evaluate(&dispatch_js).await?;
        Ok(())
    }

    /// Type text into the currently focused element.
    pub async fn type_text(&self, value: &str) -> Result<()> {
        self.adapter().insert_text(value).await
    }

    /// Press a named key (e.g. "Enter", "Tab", "Escape").
    pub async fn press(&self, key: &str) -> Result<()> {
        self.adapter().press_key(key).await
    }

    /// Clear an input field.
    pub async fn clear(&self, selector: &str) -> Result<()> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!("document.querySelector({escaped}).value = ''");
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    /// Select an option in a `<select>` element.
    pub async fn select(&self, selector: &str, value: &str) -> Result<()> {
        let escaped_sel =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let escaped_val =
            serde_json::to_string(value).unwrap_or_else(|_| format!("\"{}\"", value));
        let js = format!(
            r#"
            (function() {{
                const el = document.querySelector({escaped_sel});
                if (el) {{
                    el.value = {escaped_val};
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }})()
            "#
        );
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    // =================================================================
    // Focus & Hover
    // =================================================================

    /// Focus an element.
    pub async fn focus(&self, selector: &str) -> Result<()> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!("document.querySelector({escaped})?.focus()");
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    /// Blur (unfocus) an element.
    pub async fn blur(&self, selector: &str) -> Result<()> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!("document.querySelector({escaped})?.blur()");
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    /// Hover over an element.
    pub async fn hover(&self, selector: &str) -> Result<()> {
        let (x, y) = self.get_element_center(selector).await?;
        self.adapter().hover_point(x, y).await
    }

    // =================================================================
    // Drag
    // =================================================================

    /// Drag from one element to another.
    pub async fn drag(&self, from_selector: &str, to_selector: &str) -> Result<()> {
        let (fx, fy) = self.get_element_center(from_selector).await?;
        let (tx, ty) = self.get_element_center(to_selector).await?;
        self.adapter().drag_point(fx, fy, tx, ty).await
    }

    // =================================================================
    // Scroll
    // =================================================================

    /// Scroll vertically by pixels (positive = down).
    pub async fn scroll_y(&self, pixels: i64) -> Result<()> {
        let js = format!("window.scrollBy(0, {pixels})");
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    /// Scroll horizontally by pixels (positive = right).
    pub async fn scroll_x(&self, pixels: i64) -> Result<()> {
        let js = format!("window.scrollBy({pixels}, 0)");
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    /// Scroll an element into view.
    pub async fn scroll_to(&self, selector: &str) -> Result<()> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!(
            "document.querySelector({escaped})?.scrollIntoView({{ behavior: 'smooth', block: 'center' }})"
        );
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    /// Scroll to absolute page coordinates.
    pub async fn scroll_to_point(&self, x: f64, y: f64) -> Result<()> {
        let js = format!("window.scrollTo({x}, {y})");
        self.adapter().evaluate(&js).await?;
        Ok(())
    }

    // =================================================================
    // Wait
    // =================================================================

    /// Wait for a CSS selector to appear in the DOM.
    pub async fn wait_for_selector(&self, selector: &str, timeout_ms: u64) -> Result<()> {
        let interval: u64 = 100;
        let max_iter = (timeout_ms + interval - 1) / interval; // ceil division
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let check_js = format!("!!document.querySelector({escaped})");
        for _ in 0..max_iter {
            let found = self.adapter().evaluate(&check_js).await?;
            if found.as_bool().unwrap_or(false) {
                return Ok(());
            }
            sleep(Duration::from_millis(interval)).await;
        }
        Err(SpiderError::Timeout(format!(
            "Timeout waiting for selector: {selector}"
        )))
    }

    /// Wait for navigation/page load (simple delay).
    pub async fn wait_for_navigation(&self, timeout_ms: u64) -> Result<()> {
        let wait = timeout_ms.min(1000);
        sleep(Duration::from_millis(wait)).await;
        Ok(())
    }

    /// Wait until the page is fully loaded and DOM is stable.
    ///
    /// Checks:
    /// 1. `document.readyState === 'complete'`
    /// 2. DOM content length stabilizes (no changes for 500 ms)
    ///
    /// Use after `goto()` for SPAs and dynamic pages to ensure all
    /// content is rendered before extracting HTML.
    pub async fn wait_for_ready(&self, timeout_ms: u64) -> Result<()> {
        let start = Instant::now();
        let poll_interval: u64 = 200;
        let stable_threshold = Duration::from_millis(500);
        let timeout = Duration::from_millis(timeout_ms);

        // Phase 1: wait for document.readyState === 'complete'
        while start.elapsed() < timeout {
            let state = self.adapter().evaluate("document.readyState").await;
            if let Ok(val) = state {
                if val.as_str() == Some("complete") {
                    break;
                }
            }
            sleep(Duration::from_millis(poll_interval)).await;
        }

        // Phase 2: wait for DOM content length to stabilize
        let mut last_length: i64 = 0;
        let mut stable_since = Instant::now();

        while start.elapsed() < timeout {
            let length = self
                .adapter()
                .evaluate("document.documentElement.innerHTML.length")
                .await
                .ok()
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            if length != last_length {
                last_length = length;
                stable_since = Instant::now();
            } else if stable_since.elapsed() >= stable_threshold {
                return Ok(());
            }

            sleep(Duration::from_millis(poll_interval)).await;
        }

        Ok(())
    }

    /// Wait until page content exceeds a minimum length.
    /// Useful for SPAs where content loads asynchronously.
    pub async fn wait_for_content(&self, min_length: usize, timeout_ms: u64) -> Result<()> {
        let start = Instant::now();
        let timeout = Duration::from_millis(timeout_ms);
        while start.elapsed() < timeout {
            let length = self
                .adapter()
                .evaluate("document.documentElement.innerHTML.length")
                .await
                .ok()
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
            if length >= min_length {
                return Ok(());
            }
            sleep(Duration::from_millis(200)).await;
        }
        Ok(())
    }

    /// Wait for network idle + DOM stability (cross-platform).
    ///
    /// Uses the Performance/Resource Timing API and `MutationObserver`
    /// (works in both Chrome/CDP and Firefox/BiDi) to detect when:
    /// 1. `document.readyState === 'complete'`
    /// 2. No new network resources loading (`PerformanceObserver`)
    /// 3. DOM mutations have settled
    ///
    /// This is more comprehensive than [`wait_for_ready`] -- it also
    /// catches lazy-loaded images, XHR/fetch requests, and
    /// script-injected content.
    pub async fn wait_for_network_idle(&self, timeout_ms: u64) -> Result<()> {
        let start = Instant::now();
        let poll_interval: u64 = 250;
        let timeout = Duration::from_millis(timeout_ms);

        // Phase 1: wait for document.readyState === 'complete'
        while start.elapsed() < timeout {
            let state = self.adapter().evaluate("document.readyState").await;
            if let Ok(val) = state {
                if val.as_str() == Some("complete") {
                    break;
                }
            }
            sleep(Duration::from_millis(poll_interval)).await;
        }

        // Phase 2: inject a combined network + DOM stability checker.
        // Uses PerformanceObserver for resource timing + MutationObserver
        // for DOM changes. Returns a promise that resolves when both are
        // quiet for `idle_ms`.
        let idle_ms: u64 = 400;
        let remaining = {
            let elapsed = start.elapsed();
            if timeout > elapsed {
                (timeout - elapsed).as_millis().max(1000) as u64
            } else {
                1000
            }
        };
        let js = format!(
            r#"
            new Promise((resolve) => {{
                let lastActivity = Date.now();
                const idleThreshold = {idle_ms};
                const deadline = Date.now() + {remaining};

                const perfObs = new PerformanceObserver(() => {{ lastActivity = Date.now(); }});
                try {{ perfObs.observe({{ entryTypes: ['resource'] }}); }} catch(e) {{}}

                const mutObs = new MutationObserver(() => {{ lastActivity = Date.now(); }});
                mutObs.observe(document.documentElement, {{
                    childList: true, subtree: true, attributes: true
                }});

                const check = () => {{
                    const now = Date.now();
                    if (now >= deadline || (now - lastActivity >= idleThreshold)) {{
                        perfObs.disconnect();
                        mutObs.disconnect();
                        resolve(true);
                        return;
                    }}
                    setTimeout(check, 100);
                }};
                setTimeout(check, idleThreshold);
            }})
            "#
        );
        if self.adapter().evaluate(&js).await.is_err() {
            // If the evaluate fails (e.g. page navigated away), just
            // continue.
            sleep(Duration::from_millis(500)).await;
        }

        Ok(())
    }

    // =================================================================
    // Viewport
    // =================================================================

    /// Set the viewport dimensions.
    pub async fn set_viewport(
        &self,
        width: u32,
        height: u32,
        device_scale_factor: f64,
        mobile: bool,
    ) -> Result<()> {
        self.adapter()
            .set_viewport(width, height, device_scale_factor, mobile)
            .await
    }

    // =================================================================
    // DOM Queries
    // =================================================================

    /// Query a single element and return its outer HTML.
    pub async fn query_selector(&self, selector: &str) -> Result<Option<String>> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!("document.querySelector({escaped})?.outerHTML ?? null");
        let val = self.adapter().evaluate(&js).await?;
        if val.is_null() {
            Ok(None)
        } else {
            Ok(val.as_str().map(|s| s.to_string()))
        }
    }

    /// Query all matching elements and return their outer HTML.
    pub async fn query_selector_all(&self, selector: &str) -> Result<Vec<String>> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!(
            "Array.from(document.querySelectorAll({escaped})).map(el => el.outerHTML)"
        );
        let val = self.adapter().evaluate(&js).await?;
        let items = val
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok(items)
    }

    /// Get text content of an element.
    pub async fn text_content(&self, selector: &str) -> Result<Option<String>> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!("document.querySelector({escaped})?.textContent ?? null");
        let val = self.adapter().evaluate(&js).await?;
        if val.is_null() {
            Ok(None)
        } else {
            Ok(val.as_str().map(|s| s.to_string()))
        }
    }

    // =================================================================
    // Internals
    // =================================================================

    /// Get the center coordinates of a DOM element (scrolls into view
    /// first).
    async fn get_element_center(&self, selector: &str) -> Result<(f64, f64)> {
        let escaped =
            serde_json::to_string(selector).unwrap_or_else(|_| format!("\"{}\"", selector));
        let js = format!(
            r#"
            (function() {{
                const el = document.querySelector({escaped});
                if (!el) return null;
                el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                const r = el.getBoundingClientRect();
                return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
            }})()
            "#
        );
        let result = self.adapter().evaluate(&js).await?;

        if result.is_null() {
            return Err(SpiderError::Other(format!(
                "Element not found: {selector}"
            )));
        }

        let x = result
            .get("x")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| SpiderError::Other(format!("Element not found: {selector}")))?;
        let y = result
            .get("y")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| SpiderError::Other(format!("Element not found: {selector}")))?;

        Ok((x, y))
    }

    /// Route an incoming WebSocket message to the underlying protocol session.
    pub fn route_message(&self, data: &str) {
        self.adapter.load().route_message(data);
    }

    /// Clean up protocol resources.
    pub fn destroy(&self) {
        self.adapter.load().destroy();
    }

    /// Replace the adapter (used during browser switching).
    ///
    /// Atomically swaps the underlying [`ProtocolAdapter`] so that
    /// inflight operations on the old adapter can finish while new
    /// operations use the replacement.
    pub fn set_adapter(&self, adapter: ProtocolAdapter) {
        self.adapter.store(Arc::new(adapter));
    }

    /// Replace the adapter with an already-`Arc`-wrapped instance.
    pub fn set_adapter_arc(&self, adapter: Arc<ProtocolAdapter>) {
        self.adapter.store(adapter);
    }

    /// Detect challenge interstitials that may auto-resolve (e.g.
    /// Cloudflare "Just a moment...").
    ///
    /// These pages show briefly before redirecting to the real content.
    pub fn is_interstitial_content(html: &str) -> bool {
        if html.len() > 15_000 {
            return false; // Real pages are larger
        }
        let lower = html.to_lowercase();

        // Challenge / WAF interstitials
        if lower.contains("just a moment")
            || lower.contains("checking your browser")
            || lower.contains("please wait while we verify")
            || lower.contains("verifying the device")
            || lower.contains("available after verification")
            || lower.contains("ddos-guard")
            || lower.contains("challenge-platform")
            || lower.contains("px-captcha")
            || lower.contains("_cf_chl_opt")
            || lower.contains("managed_challenge")
            || lower.contains("datadome")
            || lower.contains("ak_bmsc")
            || lower.contains("please enable cookies")
        {
            return true;
        }

        // SPA loading states -- page shell rendered but content still
        // loading.  These auto-resolve once JS fetches actual data.
        // Only match on very small pages to avoid false positives on
        // real pages that mention "loading".
        if html.len() < 5_000 {
            if lower.contains("loading...") || lower.contains("loading results") {
                return true;
            }
            if lower.contains("please wait") && !lower.contains("article") {
                return true;
            }
        }

        false
    }

    /// Detect site-level rate limiting in page content.
    ///
    /// Browser rotation gives a new profile which bypasses per-session
    /// rate limits.
    pub fn is_rate_limit_content(html: &str) -> bool {
        if html.len() > 20_000 {
            return false; // Real pages won't be just a rate limit message
        }
        let lower = html.to_lowercase();
        lower.contains("rate limit exceeded")
            || lower.contains("too many requests")
            || (lower.contains("rate limit") && lower.contains("please try again"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // is_interstitial_content tests
    // -----------------------------------------------------------------

    #[test]
    fn interstitial_cloudflare() {
        let html = "<html><body>Just a moment...</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_checking_browser() {
        let html = "<html><body>Checking your browser before accessing</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_perimeterx() {
        let html = "<html><body>Verifying the device...</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_ddos_guard() {
        let html = "<html><head></head><body>ddos-guard check</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_challenge_platform() {
        let html = "<html><body class='challenge-platform'>wait</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_px_captcha() {
        let html = "<html><body><div id='px-captcha'></div></body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_cf_chl_opt() {
        let html = "<html><body><script>var _cf_chl_opt={}</script></body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_managed_challenge() {
        let html = "<html><body>managed_challenge page</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_datadome() {
        let html = "<html><body>DataDome verification</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_akamai() {
        let html = "<html><body><script>ak_bmsc=cookie</script></body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_enable_cookies() {
        let html = "<html><body>Please enable cookies to continue</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_loading_small() {
        let html = "<html><body>Loading...</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_loading_results() {
        let html = "<html><body>Loading results</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_please_wait_small() {
        let html = "<html><body>Please wait</body></html>";
        assert!(SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_please_wait_with_article_not_detected() {
        let html = "<html><body>Please wait for this article</body></html>";
        assert!(!SpiderPage::is_interstitial_content(html));
    }

    #[test]
    fn interstitial_large_page_not_detected() {
        let html = "x".repeat(16_000);
        assert!(!SpiderPage::is_interstitial_content(&html));
    }

    #[test]
    fn interstitial_normal_page_not_detected() {
        let html = "<html><body><h1>Welcome</h1><p>Normal content here.</p></body></html>";
        assert!(!SpiderPage::is_interstitial_content(html));
    }

    // -----------------------------------------------------------------
    // is_rate_limit_content tests
    // -----------------------------------------------------------------

    #[test]
    fn rate_limit_exceeded() {
        let html = "<html><body>Rate limit exceeded</body></html>";
        assert!(SpiderPage::is_rate_limit_content(html));
    }

    #[test]
    fn rate_limit_too_many_requests() {
        let html = "<html><body>Too many requests</body></html>";
        assert!(SpiderPage::is_rate_limit_content(html));
    }

    #[test]
    fn rate_limit_try_again() {
        let html = "<html><body>Rate limit hit. Please try again later.</body></html>";
        assert!(SpiderPage::is_rate_limit_content(html));
    }

    #[test]
    fn rate_limit_large_page_not_detected() {
        let html = format!(
            "<html><body>{}</body></html>",
            "x".repeat(21_000)
        );
        assert!(!SpiderPage::is_rate_limit_content(&html));
    }

    #[test]
    fn rate_limit_normal_page_not_detected() {
        let html = "<html><body><h1>Normal page</h1></body></html>";
        assert!(!SpiderPage::is_rate_limit_content(html));
    }
}
