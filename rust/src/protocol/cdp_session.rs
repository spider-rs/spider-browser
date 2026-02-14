//! Lock-free CDP JSON-RPC session over the Spider WebSocket transport.

use crate::errors::{Result, SpiderError};
use arc_swap::ArcSwap;
use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tracing::info;

const RETRYABLE_NAV_ERRORS: &[&str] = &[
    "ERR_ABORTED",
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_CLOSED",
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_TIMED_OUT",
    "ERR_TIMED_OUT",
    "ERR_EMPTY_RESPONSE",
    "ERR_SOCKET_NOT_CONNECTED",
    "ERR_NETWORK_CHANGED",
    "ERR_BLOCKED_BY_CLIENT",
    "ERR_SSL_PROTOCOL_ERROR",
    "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
];

type EventHandler = Box<dyn Fn(Value) + Send + Sync>;

/// Lock-free CDP session using DashMap for pending responses and events,
/// ArcSwap for the session ID, and atomics for the ID counter.
pub struct CDPSession {
    next_id: AtomicU64,
    pending: Arc<DashMap<u64, oneshot::Sender<Value>>>,
    event_handlers: Arc<DashMap<String, Vec<Arc<dyn Fn(Value) + Send + Sync>>>>,
    target_session_id: ArcSwap<Option<String>>,
    timeout_ms: u64,
    send_tx: mpsc::UnboundedSender<String>,
}

impl CDPSession {
    pub fn new(send_tx: mpsc::UnboundedSender<String>, timeout_ms: u64) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Arc::new(DashMap::new()),
            event_handlers: Arc::new(DashMap::new()),
            target_session_id: ArcSwap::from_pointee(None),
            timeout_ms,
            send_tx,
        }
    }

    /// Process an incoming message. Returns true if it was handled.
    pub fn handle_message(&self, data: &str) -> bool {
        let Ok(msg) = serde_json::from_str::<Value>(data) else {
            return false;
        };

        // Response
        if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
            if let Some((_, tx)) = self.pending.remove(&id) {
                let _ = tx.send(msg);
                return true;
            }
            return false;
        }

        // Event
        if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
            let params = msg.get("params").cloned().unwrap_or(json!({}));
            if let Some(list) = self.event_handlers.get(method) {
                // Clone handlers to release DashMap shard before calling.
                let handlers = list.clone();
                drop(list);
                for h in &handlers {
                    h(params.clone());
                }
            }
            return true;
        }

        false
    }

    /// Send a browser-level CDP command.
    pub async fn send(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cmd = json!({"id": id, "method": method, "params": params});

        let (tx, rx) = oneshot::channel();
        self.pending.insert(id, tx);
        self.send_tx
            .send(cmd.to_string())
            .map_err(|_| SpiderError::connection("WebSocket is not connected"))?;

        tokio::time::timeout(
            tokio::time::Duration::from_millis(self.timeout_ms),
            rx,
        )
        .await
        .map_err(|_| {
            self.pending.remove(&id);
            SpiderError::Timeout(format!("CDP command timeout: {method} ({}ms)", self.timeout_ms))
        })?
        .map_err(|_| SpiderError::connection("CDP response channel closed"))
    }

    /// Send a page-scoped CDP command.
    pub async fn send_to_target(&self, method: &str, params: Value) -> Result<Value> {
        let session_id = self.target_session_id.load();
        let session_id = session_id.as_ref().as_ref()
            .ok_or_else(|| SpiderError::Protocol("No target session — call attach_to_page() first".into()))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cmd = json!({
            "id": id,
            "method": method,
            "params": params,
            "sessionId": session_id,
        });

        let (tx, rx) = oneshot::channel();
        self.pending.insert(id, tx);
        self.send_tx
            .send(cmd.to_string())
            .map_err(|_| SpiderError::connection("WebSocket is not connected"))?;

        let resp = tokio::time::timeout(
            tokio::time::Duration::from_millis(self.timeout_ms),
            rx,
        )
        .await
        .map_err(|_| {
            self.pending.remove(&id);
            SpiderError::Timeout(format!("CDP command timeout: {method} ({}ms)", self.timeout_ms))
        })?
        .map_err(|_| SpiderError::connection("CDP response channel closed"))?;

        if let Some(err) = resp.get("error") {
            let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("unknown");
            return Err(SpiderError::Protocol(format!("CDP error: {msg}")));
        }

        Ok(resp)
    }

    pub fn on(&self, method: &str, handler: Arc<dyn Fn(Value) + Send + Sync>) {
        self.event_handlers
            .entry(method.to_string())
            .or_default()
            .push(handler);
    }

    /// Wait for a CDP event to fire, with timeout.
    async fn wait_for_event(&self, method: &str, timeout_ms: u64) -> bool {
        let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fired_clone = fired.clone();
        let notify = Arc::new(tokio::sync::Notify::new());
        let notify_clone = notify.clone();

        self.on(method, Arc::new(move |_params| {
            if !fired_clone.swap(true, Ordering::Relaxed) {
                notify_clone.notify_one();
            }
        }));

        let result = tokio::time::timeout(
            tokio::time::Duration::from_millis(timeout_ms),
            notify.notified(),
        )
        .await;

        // Remove handler (best-effort cleanup)
        self.event_handlers.remove(method);

        result.is_ok()
    }

    /// Discover/create a page target, attach, enable domains.
    pub async fn attach_to_page(&self) -> Result<String> {
        self.send("Target.setDiscoverTargets", json!({"discover": true})).await?;

        // Always create a fresh page target for session isolation.
        let cr = self.send("Target.createTarget", json!({"url": "about:blank"})).await?;
        let target_id = cr.get("result")
            .and_then(|r| r.get("targetId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| SpiderError::Protocol("Failed to create page target".into()))?;

        let attach_resp = self.send("Target.attachToTarget", json!({"targetId": target_id, "flatten": true})).await?;
        let sid = attach_resp.get("result")
            .and_then(|r| r.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let session_id = if let Some(s) = sid {
            s
        } else {
            // Wait for Target.attachedToTarget event
            let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let result = Arc::new(ArcSwap::from_pointee(String::new()));
            let fired_clone = fired.clone();
            let result_clone = result.clone();
            let notify = Arc::new(tokio::sync::Notify::new());
            let notify_clone = notify.clone();

            self.on("Target.attachedToTarget", Arc::new(move |params| {
                if let Some(s) = params.get("sessionId").and_then(|v| v.as_str()) {
                    result_clone.store(Arc::new(s.to_string()));
                    if !fired_clone.swap(true, Ordering::Relaxed) {
                        notify_clone.notify_one();
                    }
                }
            }));

            tokio::time::timeout(
                tokio::time::Duration::from_secs(5),
                notify.notified(),
            )
            .await
            .map_err(|_| SpiderError::Timeout("Timeout waiting for Target.attachedToTarget".into()))?;

            self.event_handlers.remove("Target.attachedToTarget");
            let s = result.load();
            if s.is_empty() {
                return Err(SpiderError::Protocol("No sessionId received".into()));
            }
            s.as_ref().clone()
        };

        self.target_session_id.store(Arc::new(Some(session_id.clone())));
        info!("attached to page target target_id={} session_id={}", target_id, session_id);

        self.send_to_target("Page.enable", json!({})).await?;
        self.send_to_target("Runtime.enable", json!({})).await?;

        Ok(session_id)
    }

    // ------------------------------------------------------------------
    // High-level CDP commands
    // ------------------------------------------------------------------

    pub async fn navigate(&self, url: &str) -> Result<()> {
        // Listen for load events BEFORE sending navigate
        let load_fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let load_notify = Arc::new(tokio::sync::Notify::new());
        let stop_fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_notify = Arc::new(tokio::sync::Notify::new());

        {
            let f = load_fired.clone();
            let n = load_notify.clone();
            self.on("Page.loadEventFired", Arc::new(move |_| {
                if !f.swap(true, Ordering::Relaxed) { n.notify_one(); }
            }));
        }
        {
            let f = stop_fired.clone();
            let n = stop_notify.clone();
            self.on("Page.frameStoppedLoading", Arc::new(move |_| {
                if !f.swap(true, Ordering::Relaxed) { n.notify_one(); }
            }));
        }

        let resp = self.send_to_target("Page.navigate", json!({"url": url})).await?;

        if let Some(error_text) = resp.get("result").and_then(|r| r.get("errorText")).and_then(|v| v.as_str()) {
            self.event_handlers.remove("Page.loadEventFired");
            self.event_handlers.remove("Page.frameStoppedLoading");
            if is_retryable_nav_error(error_text) {
                return Err(SpiderError::Navigation(format!("Navigation failed: {error_text}")));
            }
            return Err(SpiderError::Protocol(format!("Navigation failed: {error_text}")));
        }

        // Wait for load event (8s); if timeout, fall back to frameStoppedLoading (10s)
        let loaded = tokio::time::timeout(
            tokio::time::Duration::from_millis(8_000),
            load_notify.notified(),
        ).await.is_ok();

        if !loaded {
            let _ = tokio::time::timeout(
                tokio::time::Duration::from_millis(10_000),
                stop_notify.notified(),
            ).await;
        }

        self.event_handlers.remove("Page.loadEventFired");
        self.event_handlers.remove("Page.frameStoppedLoading");
        Ok(())
    }

    pub async fn navigate_fast(&self, url: &str) -> Result<()> {
        let load_fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let load_notify = Arc::new(tokio::sync::Notify::new());
        {
            let f = load_fired.clone();
            let n = load_notify.clone();
            self.on("Page.loadEventFired", Arc::new(move |_| {
                if !f.swap(true, Ordering::Relaxed) { n.notify_one(); }
            }));
        }

        let resp = self.send_to_target("Page.navigate", json!({"url": url})).await?;
        if let Some(error_text) = resp.get("result").and_then(|r| r.get("errorText")).and_then(|v| v.as_str()) {
            self.event_handlers.remove("Page.loadEventFired");
            if is_retryable_nav_error(error_text) {
                return Err(SpiderError::Navigation(format!("Navigation failed: {error_text}")));
            }
            return Err(SpiderError::Protocol(format!("Navigation failed: {error_text}")));
        }

        let _ = tokio::time::timeout(
            tokio::time::Duration::from_millis(5_000),
            load_notify.notified(),
        ).await;

        self.event_handlers.remove("Page.loadEventFired");
        Ok(())
    }

    pub async fn navigate_dom(&self, url: &str) -> Result<()> {
        let dom_fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let dom_notify = Arc::new(tokio::sync::Notify::new());
        {
            let f = dom_fired.clone();
            let n = dom_notify.clone();
            self.on("Page.domContentEventFired", Arc::new(move |_| {
                if !f.swap(true, Ordering::Relaxed) { n.notify_one(); }
            }));
        }

        let resp = self.send_to_target("Page.navigate", json!({"url": url})).await?;
        if let Some(error_text) = resp.get("result").and_then(|r| r.get("errorText")).and_then(|v| v.as_str()) {
            self.event_handlers.remove("Page.domContentEventFired");
            if is_retryable_nav_error(error_text) {
                return Err(SpiderError::Navigation(format!("Navigation failed: {error_text}")));
            }
            return Err(SpiderError::Protocol(format!("Navigation failed: {error_text}")));
        }

        let _ = tokio::time::timeout(
            tokio::time::Duration::from_millis(3_000),
            dom_notify.notified(),
        ).await;

        self.event_handlers.remove("Page.domContentEventFired");
        Ok(())
    }

    pub async fn capture_screenshot(&self) -> Result<String> {
        let resp = self.send_to_target("Page.captureScreenshot", json!({"format": "png"})).await?;
        resp.get("result")
            .and_then(|r| r.get("data"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| SpiderError::Protocol("captureScreenshot: missing result.data".into()))
    }

    pub async fn get_html(&self) -> Result<String> {
        let val = self.evaluate("document.documentElement.outerHTML").await?;
        Ok(val.as_str().unwrap_or("").to_string())
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        let resp = self.send_to_target("Runtime.evaluate", json!({
            "expression": expression,
            "returnByValue": true,
        })).await?;
        if let Some(err) = resp.get("result").and_then(|r| r.get("exceptionDetails")) {
            let msg = err.get("text").and_then(|v| v.as_str()).unwrap_or("evaluation error");
            return Err(SpiderError::Protocol(format!("CDP eval error: {msg}")));
        }
        Ok(resp
            .get("result")
            .and_then(|r| r.get("result"))
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn click_point(&self, x: f64, y: f64) -> Result<()> {
        self.dispatch_mouse("mouseMoved", x, y, "none", 0).await?;
        self.dispatch_mouse("mousePressed", x, y, "left", 1).await?;
        self.dispatch_mouse("mouseReleased", x, y, "left", 1).await
    }

    pub async fn right_click_point(&self, x: f64, y: f64) -> Result<()> {
        self.dispatch_mouse("mouseMoved", x, y, "none", 0).await?;
        self.dispatch_mouse("mousePressed", x, y, "right", 1).await?;
        self.dispatch_mouse("mouseReleased", x, y, "right", 1).await
    }

    pub async fn double_click_point(&self, x: f64, y: f64) -> Result<()> {
        self.dispatch_mouse("mouseMoved", x, y, "none", 0).await?;
        self.dispatch_mouse("mousePressed", x, y, "left", 1).await?;
        self.dispatch_mouse("mouseReleased", x, y, "left", 1).await?;
        self.dispatch_mouse("mousePressed", x, y, "left", 2).await?;
        self.dispatch_mouse("mouseReleased", x, y, "left", 2).await
    }

    pub async fn click_hold_point(&self, x: f64, y: f64, hold_ms: u64) -> Result<()> {
        self.dispatch_mouse("mouseMoved", x, y, "none", 0).await?;
        self.dispatch_mouse("mousePressed", x, y, "left", 1).await?;
        tokio::time::sleep(tokio::time::Duration::from_millis(hold_ms)).await;
        self.dispatch_mouse("mouseReleased", x, y, "left", 1).await
    }

    pub async fn hover_point(&self, x: f64, y: f64) -> Result<()> {
        self.dispatch_mouse("mouseMoved", x, y, "none", 0).await
    }

    pub async fn drag_point(&self, fx: f64, fy: f64, tx: f64, ty: f64) -> Result<()> {
        let steps = 10;
        self.dispatch_mouse("mouseMoved", fx, fy, "none", 0).await?;
        self.dispatch_mouse("mousePressed", fx, fy, "left", 1).await?;
        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            self.dispatch_mouse("mouseMoved", fx + (tx - fx) * t, fy + (ty - fy) * t, "left", 0).await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(16)).await;
        }
        self.dispatch_mouse("mouseReleased", tx, ty, "left", 1).await
    }

    pub async fn insert_text(&self, text: &str) -> Result<()> {
        self.send_to_target("Input.insertText", json!({"text": text})).await?;
        Ok(())
    }

    pub async fn press_key(&self, key: &str, code: &str, key_code: u32) -> Result<()> {
        self.send_to_target("Input.dispatchKeyEvent", json!({
            "type": "keyDown", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code, "text": key,
        })).await?;
        self.send_to_target("Input.dispatchKeyEvent", json!({
            "type": "keyUp", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code,
        })).await?;
        Ok(())
    }

    pub async fn key_down(&self, key: &str, code: &str, key_code: u32) -> Result<()> {
        self.send_to_target("Input.dispatchKeyEvent", json!({
            "type": "keyDown", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code, "text": key,
        })).await?;
        Ok(())
    }

    pub async fn key_up(&self, key: &str, code: &str, key_code: u32) -> Result<()> {
        self.send_to_target("Input.dispatchKeyEvent", json!({
            "type": "keyUp", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code,
        })).await?;
        Ok(())
    }

    pub async fn set_viewport(&self, w: u32, h: u32, dpr: f64, mobile: bool) -> Result<()> {
        self.send_to_target("Emulation.setDeviceMetricsOverride", json!({
            "width": w, "height": h, "deviceScaleFactor": dpr, "mobile": mobile,
        })).await?;
        Ok(())
    }

    pub fn destroy(&self) {
        self.pending.clear();
        self.event_handlers.clear();
        self.target_session_id.store(Arc::new(None));
    }

    async fn dispatch_mouse(&self, typ: &str, x: f64, y: f64, button: &str, click_count: u32) -> Result<()> {
        self.send_to_target("Input.dispatchMouseEvent", json!({
            "type": typ, "x": x, "y": y, "button": button, "clickCount": click_count,
        })).await?;
        Ok(())
    }
}

fn is_retryable_nav_error(error_text: &str) -> bool {
    RETRYABLE_NAV_ERRORS.iter().any(|e| error_text.contains(e))
}
