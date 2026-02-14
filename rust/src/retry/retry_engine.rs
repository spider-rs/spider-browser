//! Smart retry engine with stealth-first escalation.
//!
//! **Strategy: escalate proxy quality (stealth) FAST, try alternative engines LAST.**
//!
//! - **Phase 1 (Stealth escalation)**: For each stealth level `[0 -> max]`,
//!   try PRIMARY browsers `[chrome-h, chrome-new]` with transient retries.
//!   If blocked -> skip remaining primary browsers, escalate stealth immediately.
//!
//! - **Phase 2 (Extended rotation)**: Only at max stealth, if still blocked,
//!   try EXTENDED browsers `[firefox, lightpanda, servo]` for different engine
//!   fingerprints + best proxies.
//!
//! ```text
//! Phase 1 -- stealth escalation across primary browsers:
//!   for each stealth level (initial -> maxStealthLevel):
//!     for each PRIMARY browser [chrome-h, chrome-new]:
//!       attempt action
//!       if transient   -> reconnect same browser, retry up to 2x
//!       if blocked     -> skip remaining primary, escalate stealth immediately
//!       if backend_down-> mark down, next browser
//!       if auth        -> throw immediately
//!       if rate_limit  -> wait, retry same browser
//!
//! Phase 2 -- extended rotation at max stealth only (if blocked):
//!   for each EXTENDED browser [firefox, lightpanda, servo]:
//!     single attempt (no transient retries)
//! ```

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use serde_json::json;
use tracing::{info, warn};
use url::Url;

use crate::errors::SpiderError;
use crate::events::SpiderEventEmitter;
use crate::protocol::protocol_adapter::{ProtocolAdapter, ProtocolAdapterOptions};
use crate::protocol::transport::{Transport, TransportOptions};

use super::browser_selector::{BrowserSelector, EXTENDED_ROTATION, PRIMARY_ROTATION};
use super::failure_tracker::FailureTracker;
use super::keyword_classifier::KeywordClassifier;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/// Error classification for retry decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Transient,
    Blocked,
    BackendDown,
    Auth,
    RateLimit,
}

/// Build the error classifier (Aho-Corasick, O(n) single-pass).
///
/// Rules are priority-ordered -- first match wins.
fn build_error_classifier() -> KeywordClassifier<ErrorClass> {
    KeywordClassifier::new(&[
        // Blocked -- checked first (most common heuristic case)
        (
            &[
                "bot detect",
                "are you a robot",
                "bot or not",
                "blocked",
                "403",
                "captcha",
                "network security",
                "human verification",
                "verify you are human",
                "show us your human side",
                "can't tell if you're a human",
                "checking your browser",
                "bot protection",
                "automated access",
                "suspected automated",
                "prove you're not a robot",
                "pardon our interruption",
                "powered and protected by",
                "request could not be processed",
                "access to this page has been denied",
                "access denied",
                "please complete the security check",
                "enable cookies",
                "browser check",
                "just a moment",
                "rate limit exceeded",
                "too many requests",
                "err_blocked_by_client",
            ],
            ErrorClass::Blocked,
        ),
        // Auth
        (&["401", "402", "unauthorized"], ErrorClass::Auth),
        // Backend down
        (
            &[
                "backend unavailable",
                "no backend",
                "service unavailable",
                "503",
                "failed to create page target",
                "unexpected server response",
            ],
            ErrorClass::BackendDown,
        ),
        // Transient (connection)
        (
            &[
                "err_connection_reset",
                "err_connection_closed",
                "err_empty_response",
                "err_ssl_protocol_error",
                "err_ssl_version_or_cipher_mismatch",
                "err_cert",
                "timeout",
            ],
            ErrorClass::Transient,
        ),
        // Transient (WebSocket / session)
        (
            &[
                "websocket is not connected",
                "websocket closed",
                "session with given id not found",
                "content contamination",
                "insufficient content",
            ],
            ErrorClass::Transient,
        ),
    ])
}

/// Build the disconnection classifier (determines whether to reconnect).
fn build_disconnection_classifier() -> KeywordClassifier<bool> {
    KeywordClassifier::new(&[
        // NOT disconnections (page-level) -- checked first
        (&["err_blocked_by_client"], false),
        // Actual disconnections
        (
            &[
                "websocket is not connected",
                "websocket closed",
                "session destroyed",
                "session with given id not found",
                "err_connection_reset",
                "err_connection_closed",
                "err_empty_response",
                "socket hang up",
                "err_aborted",
                "content contamination",
                "insufficient content",
                "err_ssl_protocol_error",
                "err_ssl_version_or_cipher_mismatch",
            ],
            true,
        ),
    ])
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Options for constructing a [`RetryEngine`].
pub struct RetryOptions {
    pub max_retries: u32,
    pub transport_opts: TransportOptions,
    pub emitter: SpiderEventEmitter,
    /// Maximum stealth level to escalate to (1-3, default 3).
    pub max_stealth_level: Option<u32>,
    /// Timeout for retry attempts -- shorter than first try (default: 15 000 ms).
    pub retry_timeout_ms: Option<u64>,
    /// CDP/BiDi command timeout in ms, passed through to new adapters (default: 30 000).
    pub command_timeout_ms: Option<u64>,
}

/// Mutable context threaded through retry attempts.
pub struct RetryContext {
    pub transport: Arc<Transport>,
    pub adapter: ProtocolAdapter,
    pub current_url: Option<String>,
    pub on_adapter_changed: Box<dyn Fn(&ProtocolAdapter) + Send + Sync>,
}

// ---------------------------------------------------------------------------
// Result of a single-browser try
// ---------------------------------------------------------------------------

struct TryResult<T> {
    success: bool,
    value: Option<T>,
    total_attempts: u32,
    tried_action: bool,
    last_error: Option<SpiderError>,
}

// ---------------------------------------------------------------------------
// RetryEngine
// ---------------------------------------------------------------------------

/// Smart retry engine with stealth-first escalation and browser rotation.
///
/// All internal state is lock-free: atomics for counters, `DashMap`-backed
/// `FailureTracker`, and plain local sets for down-backend tracking (the
/// engine is `!Sync` by design -- a single owner drives the retry loop).
pub struct RetryEngine {
    opts: RetryOptions,
    selector: BrowserSelector,
    current_stealth_level: AtomicU32,
    max_stealth_level: u32,
    retry_timeout_ms: u64,
    command_timeout_ms: u64,
    /// Browser backends that returned 503/unavailable -- persists across stealth levels.
    down_backends: HashSet<String>,
    /// Count of timeout errors -- used for progressive timeout escalation.
    timeout_count: AtomicU32,
    /// Pre-built Aho-Corasick classifiers (zero per-call cost).
    error_classifier: KeywordClassifier<ErrorClass>,
    disconnection_classifier: KeywordClassifier<bool>,
}

impl RetryEngine {
    /// Create a new retry engine from the given options.
    pub fn new(opts: RetryOptions) -> Self {
        let stealth = opts.transport_opts.stealth_level;
        let max_stealth = opts.max_stealth_level.unwrap_or(3);
        let retry_timeout = opts.retry_timeout_ms.unwrap_or(15_000);
        let cmd_timeout = opts.command_timeout_ms.unwrap_or(30_000);

        Self {
            selector: BrowserSelector::new(FailureTracker::new()),
            current_stealth_level: AtomicU32::new(stealth),
            max_stealth_level: max_stealth,
            retry_timeout_ms: retry_timeout,
            command_timeout_ms: cmd_timeout,
            down_backends: HashSet::new(),
            timeout_count: AtomicU32::new(0),
            error_classifier: build_error_classifier(),
            disconnection_classifier: build_disconnection_classifier(),
            opts,
        }
    }

    /// Current stealth level (0 = auto, 1-3 = explicit tiers).
    pub fn stealth_level(&self) -> u32 {
        self.current_stealth_level.load(Ordering::Relaxed)
    }

    /// Progressive page timeout: fail fast initially, escalate on retries.
    ///
    /// 1st attempt: 35 s, 2nd: 50 s, 3rd+: 65 s.
    /// Must exceed server-side nav timeout (20 s) + retry (15 s).
    fn progressive_timeout(&self) -> u64 {
        match self.timeout_count.load(Ordering::Relaxed) {
            0 => 35_000,
            1 => 50_000,
            _ => 65_000,
        }
    }

    /// Execute an action with stealth-first retry across browsers and stealth levels.
    pub async fn execute<T, F, Fut>(
        &mut self,
        mut make_future: F,
        ctx: &mut RetryContext,
    ) -> Result<T, SpiderError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, SpiderError>>,
    {
        let mut last_error: Option<SpiderError> = None;
        let mut total_attempts: u32 = 0;
        let budget = self.opts.max_retries + 1; // total attempts allowed
        self.down_backends.clear();

        let stealth_levels = self.get_stealth_progression();
        let initial_browser = ctx.transport.browser();
        let mut consecutive_disconnects: u32 = 0;
        let mut was_blocked = false;
        let mut had_timeout = false;
        let mut phase1_timeouts: u32 = 0;

        // ---- Phase 1: Stealth escalation across primary browsers ----
        for si in 0..stealth_levels.len() {
            if total_attempts >= budget {
                break;
            }
            // 1+ timeout on Chrome -> different Chrome variant won't help.
            // Jump to Phase 2 (Firefox).
            if phase1_timeouts >= 1 {
                had_timeout = true;
                break;
            }

            let stealth = stealth_levels[si];

            // Stealth escalation (skip for first level)
            if si > 0 {
                let prev = stealth_levels[si - 1];
                self.current_stealth_level.store(stealth, Ordering::Relaxed);
                ctx.transport.set_stealth_level(stealth);

                info!("retry: escalating stealth {} -> {}", prev, stealth);
                self.opts.emitter.emit(
                    "stealth.escalated",
                    json!({
                        "from": prev,
                        "to": stealth,
                        "reason": last_error.as_ref().map(|e| format!("{:?}", self.classify_error(e))).unwrap_or_else(|| "exhausted".into()),
                    }),
                );

                // Clear domain failure tracking so all browsers are available again
                if let Some(domain) = Self::extract_domain(ctx.current_url.as_deref()) {
                    self.selector.failure_tracker().clear(&domain);
                }
            }

            let primary_browsers: Vec<&str> = if si == 0 {
                Self::ordered_primary_browsers(&initial_browser)
            } else {
                PRIMARY_ROTATION.to_vec()
            };

            let mut tried_any = false;

            for &browser in &primary_browsers {
                if total_attempts >= budget {
                    break;
                }
                if self.down_backends.contains(browser) {
                    continue;
                }
                // 6+ consecutive WS disconnects -> server overloaded
                if consecutive_disconnects >= 6 {
                    warn!("retry: 6+ consecutive disconnects, server overloaded -- aborting");
                    break;
                }

                let result = self
                    .try_browser(&mut make_future, ctx, browser, stealth, total_attempts, budget, true)
                    .await;

                total_attempts = result.total_attempts;
                if result.success {
                    return Ok(result.value.unwrap());
                }
                if result.tried_action {
                    tried_any = true;
                }
                if let Some(ref err) = result.last_error {
                    let error_class = self.classify_error(err);
                    was_blocked = error_class == ErrorClass::Blocked;
                    if error_class == ErrorClass::Auth {
                        return Err(result.last_error.unwrap());
                    }
                    // Track consecutive disconnects
                    if self.is_disconnection_error(err) {
                        consecutive_disconnects += 1;
                    } else {
                        consecutive_disconnects = 0;
                    }
                    // Timeout -> track count, break to Phase 2
                    if matches!(err, SpiderError::Timeout(_)) {
                        phase1_timeouts += 1;
                        self.timeout_count.fetch_add(1, Ordering::Relaxed);
                        had_timeout = true;
                        break;
                    }
                    // Blocked -> skip remaining primary, escalate stealth
                    if was_blocked {
                        break;
                    }
                }
                last_error = result.last_error.or(last_error);
            }

            if !tried_any {
                warn!("retry: all browser backends unavailable, stopping");
                break;
            }
        }

        // ---- Phase 2: Extended rotation at max stealth ----
        if (was_blocked || had_timeout || total_attempts > 0)
            && total_attempts < budget
            && !EXTENDED_ROTATION.is_empty()
        {
            for &browser in EXTENDED_ROTATION {
                if total_attempts >= budget {
                    break;
                }
                if self.down_backends.contains(browser) {
                    continue;
                }

                let max_stealth =
                    stealth_levels.last().copied().unwrap_or(self.max_stealth_level);
                let result = self
                    .try_browser(&mut make_future, ctx, browser, max_stealth, total_attempts, budget, false)
                    .await;

                total_attempts = result.total_attempts;
                if result.success {
                    return Ok(result.value.unwrap());
                }
                if let Some(ref err) = result.last_error {
                    if self.classify_error(err) == ErrorClass::Auth {
                        return Err(result.last_error.unwrap());
                    }
                }
                last_error = result.last_error.or(last_error);
            }
        }

        Err(last_error
            .unwrap_or_else(|| SpiderError::Other("All browsers and stealth levels exhausted".into())))
    }

    /// Attempt an action on a specific browser, with optional transient retries.
    async fn try_browser<T, F, Fut>(
        &mut self,
        make_future: &mut F,
        ctx: &mut RetryContext,
        browser: &str,
        stealth: u32,
        mut total_attempts: u32,
        budget: u32,
        allow_transient_retries: bool,
    ) -> TryResult<T>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, SpiderError>>,
    {
        let last_error: Option<SpiderError> = None;

        // Switch browser (skip on very first attempt -- already connected)
        if total_attempts > 0 {
            let prev_browser = ctx.transport.browser();
            info!(
                "retry: switching {} -> {} (stealth={})",
                prev_browser, browser, stealth
            );
            self.opts.emitter.emit(
                "browser.switching",
                json!({
                    "from": prev_browser,
                    "to": browser,
                    "reason": last_error.as_ref().map(|e| format!("{:?}", self.classify_error(e))).unwrap_or_else(|| "rotation".into()),
                }),
            );

            match self.switch_browser(ctx, browser).await {
                Ok(()) => {
                    self.opts
                        .emitter
                        .emit("browser.switched", json!({ "browser": browser }));
                }
                Err(switch_err) => {
                    warn!(
                        "retry: switch to {} failed, skipping: {}",
                        browser, switch_err
                    );
                    if matches!(switch_err, SpiderError::BackendUnavailable(_)) {
                        self.down_backends.insert(browser.to_string());
                    }
                    return TryResult {
                        success: false,
                        value: None,
                        total_attempts,
                        tried_action: false,
                        last_error: Some(switch_err),
                    };
                }
            }
        }

        let max_transient_retries: u32 = if allow_transient_retries { 2 } else { 0 };
        let max_disconnect_retries: u32 = if allow_transient_retries { 2 } else { 0 };
        let mut transient_retries: u32 = 0;
        let mut disconnect_retries: u32 = 0;

        while total_attempts < budget {
            total_attempts += 1;

            match make_future().await {
                Ok(value) => {
                    if let Some(domain) = Self::extract_domain(ctx.current_url.as_deref()) {
                        self.selector
                            .failure_tracker()
                            .record_success(&domain, browser);
                    }
                    return TryResult {
                        success: true,
                        value: Some(value),
                        total_attempts,
                        tried_action: true,
                        last_error: None,
                    };
                }
                Err(err) => {
                    let error_class = self.classify_error(&err);

                    warn!(
                        "retry: attempt {}/{} failed: {} (class={:?}, browser={}, stealth={})",
                        total_attempts, budget, err, error_class, browser, stealth
                    );

                    self.opts.emitter.emit(
                        "retry.attempt",
                        json!({
                            "attempt": total_attempts,
                            "maxRetries": self.opts.max_retries,
                            "error": err.to_string(),
                        }),
                    );

                    // Auth -> bubble up immediately
                    if error_class == ErrorClass::Auth {
                        return TryResult {
                            success: false,
                            value: None,
                            total_attempts,
                            tried_action: true,
                            last_error: Some(err),
                        };
                    }

                    // Rate limit -> exponential backoff with jitter
                    if error_class == ErrorClass::RateLimit {
                        transient_retries += 1;
                        if transient_retries >= 2 {
                            if let Some(domain) = Self::extract_domain(ctx.current_url.as_deref())
                            {
                                self.selector
                                    .failure_tracker()
                                    .record_failure(&domain, browser);
                            }
                            return TryResult {
                                success: false,
                                value: None,
                                total_attempts,
                                tried_action: true,
                                last_error: Some(err),
                            };
                        }
                        let base_ms = match &err {
                            SpiderError::RateLimit {
                                retry_after_ms: Some(ms),
                                ..
                            } => *ms,
                            _ => 2000 * transient_retries as u64,
                        };
                        let jitter = (base_ms / 4).min(1000); // deterministic jitter approximation
                        tokio::time::sleep(tokio::time::Duration::from_millis(base_ms + jitter))
                            .await;
                        continue;
                    }

                    // Backend down -> mark and move on
                    if error_class == ErrorClass::BackendDown {
                        self.down_backends.insert(browser.to_string());
                        return TryResult {
                            success: false,
                            value: None,
                            total_attempts,
                            tried_action: true,
                            last_error: Some(err),
                        };
                    }

                    // Blocked -> record failure, move to next browser
                    if error_class == ErrorClass::Blocked {
                        if let Some(domain) = Self::extract_domain(ctx.current_url.as_deref()) {
                            self.selector
                                .failure_tracker()
                                .record_failure(&domain, browser);
                        }
                        return TryResult {
                            success: false,
                            value: None,
                            total_attempts,
                            tried_action: true,
                            last_error: Some(err),
                        };
                    }

                    // Timeout -> rotate immediately
                    if matches!(&err, SpiderError::Timeout(_)) {
                        if let Some(domain) = Self::extract_domain(ctx.current_url.as_deref()) {
                            self.selector
                                .failure_tracker()
                                .record_failure(&domain, browser);
                        }
                        return TryResult {
                            success: false,
                            value: None,
                            total_attempts,
                            tried_action: true,
                            last_error: Some(err),
                        };
                    }

                    // WS disconnection -> reconnect with backoff
                    if error_class == ErrorClass::Transient && self.is_disconnection_error(&err) {
                        if disconnect_retries < max_disconnect_retries {
                            disconnect_retries += 1;
                            let backoff_ms = if disconnect_retries == 1 { 1000 } else { 3000 };
                            tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms))
                                .await;

                            // Second disconnect -> try a different engine
                            let reconnect_browser = if disconnect_retries >= 2 {
                                self.pick_alternate_engine(browser)
                                    .unwrap_or_else(|| browser.to_string())
                            } else {
                                browser.to_string()
                            };

                            if self.switch_browser(ctx, &reconnect_browser).await.is_err() {
                                if let Some(domain) =
                                    Self::extract_domain(ctx.current_url.as_deref())
                                {
                                    self.selector
                                        .failure_tracker()
                                        .record_failure(&domain, browser);
                                }
                                return TryResult {
                                    success: false,
                                    value: None,
                                    total_attempts,
                                    tried_action: true,
                                    last_error: Some(err),
                                };
                            }
                            continue; // retry the action
                        }
                        if let Some(domain) = Self::extract_domain(ctx.current_url.as_deref()) {
                            self.selector
                                .failure_tracker()
                                .record_failure(&domain, browser);
                        }
                        return TryResult {
                            success: false,
                            value: None,
                            total_attempts,
                            tried_action: true,
                            last_error: Some(err),
                        };
                    }

                    // Non-disconnect transient -> retry same browser
                    if error_class == ErrorClass::Transient
                        && transient_retries < max_transient_retries
                    {
                        transient_retries += 1;
                        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                        continue;
                    }

                    // Transient retry exhausted -> move to next browser
                    if let Some(domain) = Self::extract_domain(ctx.current_url.as_deref()) {
                        self.selector
                            .failure_tracker()
                            .record_failure(&domain, browser);
                    }
                    return TryResult {
                        success: false,
                        value: None,
                        total_attempts,
                        tried_action: true,
                        last_error: Some(err),
                    };
                }
            }
        }

        TryResult {
            success: false,
            value: None,
            total_attempts,
            tried_action: true,
            last_error,
        }
    }

    // ------------------------------------------------------------------
    // Error classification
    // ------------------------------------------------------------------

    /// Classify an error to determine retry strategy.
    ///
    /// Fast path: typed error variants (`match`, no string scan).
    /// Slow path: Aho-Corasick O(n) single-pass keyword matching.
    fn classify_error(&self, err: &SpiderError) -> ErrorClass {
        match err {
            SpiderError::Auth(_) => ErrorClass::Auth,
            SpiderError::RateLimit { .. } => ErrorClass::RateLimit,
            SpiderError::Blocked(_) => ErrorClass::Blocked,
            SpiderError::BackendUnavailable(_) => ErrorClass::BackendDown,
            SpiderError::Timeout(_) => ErrorClass::Transient,
            SpiderError::Connection { ws_code, message, .. } => {
                if let Some(code) = ws_code {
                    match *code {
                        1006 | 1011 => return ErrorClass::Transient,
                        4001 | 4002 => return ErrorClass::Auth,
                        _ => {}
                    }
                }
                // Fall through to keyword scan on the message
                self.error_classifier
                    .classify(message)
                    .copied()
                    .unwrap_or(ErrorClass::Transient)
            }
            SpiderError::Navigation(msg) => {
                let cls = self.error_classifier.classify(msg).copied();
                if cls == Some(ErrorClass::Blocked) {
                    ErrorClass::Blocked
                } else {
                    ErrorClass::Transient
                }
            }
            _ => {
                let msg = err.to_string();
                let cls = self.error_classifier.classify(&msg).copied();
                if let Some(c) = cls {
                    return c;
                }
                // Transport-level 429 fallback
                if msg.contains("429") {
                    return ErrorClass::RateLimit;
                }
                ErrorClass::Transient
            }
        }
    }

    /// Check if an error indicates the WebSocket/session is dead.
    fn is_disconnection_error(&self, err: &SpiderError) -> bool {
        let msg = err.to_string();
        match err {
            // NavigationError: page-level errors (false) vs actual disconnections (true).
            // `None` (no keyword match) -> treat as disconnection for NavigationError.
            SpiderError::Navigation(_) => {
                self.disconnection_classifier.classify(&msg) != Some(&false)
            }
            _ => self.disconnection_classifier.classify(&msg) == Some(&true),
        }
    }

    // ------------------------------------------------------------------
    // Browser switching
    // ------------------------------------------------------------------

    /// Reconnect with a (possibly different) browser, re-navigate to the same URL.
    async fn switch_browser(
        &self,
        ctx: &mut RetryContext,
        new_browser: &str,
    ) -> Result<(), SpiderError> {
        ctx.adapter.destroy();

        ctx.transport.reconnect(new_browser).await?;

        let adapter_opts = if self.command_timeout_ms != 30_000 {
            Some(ProtocolAdapterOptions {
                command_timeout_ms: Some(self.command_timeout_ms),
            })
        } else {
            None
        };

        // We need a sender that relays to the transport. Create a relay channel.
        let (proto_tx, mut proto_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let transport_clone = ctx.transport.clone();
        tokio::spawn(async move {
            while let Some(data) = proto_rx.recv().await {
                let _ = transport_clone.send(data);
            }
        });

        let mut new_adapter =
            ProtocolAdapter::new(proto_tx, self.opts.emitter.clone(), new_browser, adapter_opts);
        new_adapter.init().await?;

        ctx.adapter = new_adapter;
        (ctx.on_adapter_changed)(&ctx.adapter);

        if let Some(ref url) = ctx.current_url {
            ctx.adapter.navigate(url).await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }

        Ok(())
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// Stealth progression: from current level up to max.
    ///
    /// e.g. start=0, max=3 -> `[0, 1, 2, 3]`
    fn get_stealth_progression(&self) -> Vec<u32> {
        let start = self.current_stealth_level.load(Ordering::Relaxed);
        let mut levels = vec![start];
        let mut next = if start < 1 { 1 } else { start + 1 };
        while next <= self.max_stealth_level {
            levels.push(next);
            next += 1;
        }
        levels
    }

    /// Order PRIMARY browsers starting from `start`, then the rest.
    fn ordered_primary_browsers(start: &str) -> Vec<&'static str> {
        let idx = PRIMARY_ROTATION.iter().position(|&b| b == start);
        match idx {
            Some(i) if i > 0 => {
                let mut v = PRIMARY_ROTATION[i..].to_vec();
                v.extend_from_slice(&PRIMARY_ROTATION[..i]);
                v
            }
            _ => PRIMARY_ROTATION.to_vec(),
        }
    }

    /// Pick a non-Chrome engine for disconnect recovery.
    fn pick_alternate_engine(&self, current: &str) -> Option<String> {
        for &browser in EXTENDED_ROTATION {
            if browser != current && !self.down_backends.contains(browser) {
                return Some(browser.to_string());
            }
        }
        for &browser in PRIMARY_ROTATION {
            if browser != current && !self.down_backends.contains(browser) {
                return Some(browser.to_string());
            }
        }
        None
    }

    /// Extract the hostname from a URL string.
    fn extract_domain(url: Option<&str>) -> Option<String> {
        url.and_then(|u| Url::parse(u).ok())
            .and_then(|u| u.host_str().map(|h| h.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_classifier_blocked() {
        let c = build_error_classifier();
        assert_eq!(c.classify("Error 403 Forbidden"), Some(&ErrorClass::Blocked));
        assert_eq!(c.classify("CAPTCHA detected"), Some(&ErrorClass::Blocked));
        assert_eq!(c.classify("bot detection active"), Some(&ErrorClass::Blocked));
        assert_eq!(c.classify("Access Denied"), Some(&ErrorClass::Blocked));
    }

    #[test]
    fn error_classifier_auth() {
        let c = build_error_classifier();
        assert_eq!(c.classify("HTTP 401 Unauthorized"), Some(&ErrorClass::Auth));
    }

    #[test]
    fn error_classifier_backend_down() {
        let c = build_error_classifier();
        assert_eq!(
            c.classify("503 Service Unavailable"),
            Some(&ErrorClass::BackendDown)
        );
        assert_eq!(
            c.classify("backend unavailable for chrome"),
            Some(&ErrorClass::BackendDown)
        );
    }

    #[test]
    fn error_classifier_transient() {
        let c = build_error_classifier();
        assert_eq!(
            c.classify("net::ERR_CONNECTION_RESET"),
            Some(&ErrorClass::Transient)
        );
        assert_eq!(
            c.classify("WebSocket closed unexpectedly"),
            Some(&ErrorClass::Transient)
        );
    }

    #[test]
    fn error_classifier_no_match() {
        let c = build_error_classifier();
        assert_eq!(c.classify("page loaded fine"), None);
    }

    #[test]
    fn disconnection_classifier_true() {
        let c = build_disconnection_classifier();
        assert_eq!(c.classify("websocket is not connected"), Some(&true));
        assert_eq!(c.classify("socket hang up"), Some(&true));
        assert_eq!(c.classify("err_aborted during navigation"), Some(&true));
    }

    #[test]
    fn disconnection_classifier_false_for_page_level() {
        let c = build_disconnection_classifier();
        assert_eq!(
            c.classify("net::ERR_BLOCKED_BY_CLIENT"),
            Some(&false)
        );
    }

    #[test]
    fn stealth_progression() {
        // Simulating get_stealth_progression logic
        let cases: Vec<(u32, u32, Vec<u32>)> = vec![
            (0, 3, vec![0, 1, 2, 3]),
            (2, 3, vec![2, 3]),
            (3, 3, vec![3]),
            (0, 1, vec![0, 1]),
        ];
        for (start, max, expected) in cases {
            let mut levels = vec![start];
            let mut next = if start < 1 { 1 } else { start + 1 };
            while next <= max {
                levels.push(next);
                next += 1;
            }
            assert_eq!(levels, expected, "start={start}, max={max}");
        }
    }

    #[test]
    fn ordered_primary_browsers_from_start() {
        assert_eq!(
            RetryEngine::ordered_primary_browsers("chrome-h"),
            vec!["chrome-h", "chrome-new"]
        );
        assert_eq!(
            RetryEngine::ordered_primary_browsers("chrome-new"),
            vec!["chrome-new", "chrome-h"]
        );
        // Unknown browser -> default order
        assert_eq!(
            RetryEngine::ordered_primary_browsers("firefox"),
            vec!["chrome-h", "chrome-new"]
        );
    }

    #[test]
    fn extract_domain_works() {
        assert_eq!(
            RetryEngine::extract_domain(Some("https://example.com/path")),
            Some("example.com".to_string())
        );
        assert_eq!(RetryEngine::extract_domain(None), None);
        assert_eq!(RetryEngine::extract_domain(Some("not-a-url")), None);
    }
}
