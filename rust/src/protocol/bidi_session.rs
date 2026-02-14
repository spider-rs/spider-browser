//! Lock-free WebDriver BiDi session over the Spider WebSocket transport.

use crate::errors::{Result, SpiderError};
use arc_swap::ArcSwap;
use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

/// Lock-free BiDi session using DashMap for pending/events, ArcSwap for context.
pub struct BiDiSession {
    next_id: AtomicU64,
    pending: Arc<DashMap<u64, oneshot::Sender<Value>>>,
    event_handlers: Arc<DashMap<String, Vec<Arc<dyn Fn(Value) + Send + Sync>>>>,
    browsing_context: ArcSwap<Option<String>>,
    timeout_ms: u64,
    send_tx: mpsc::UnboundedSender<String>,
}

impl BiDiSession {
    pub fn new(send_tx: mpsc::UnboundedSender<String>, timeout_ms: u64) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Arc::new(DashMap::new()),
            event_handlers: Arc::new(DashMap::new()),
            browsing_context: ArcSwap::from_pointee(None),
            timeout_ms,
            send_tx,
        }
    }

    pub fn context(&self) -> Option<String> {
        self.browsing_context.load().as_ref().clone()
    }

    /// Process a raw message from the transport. Returns true if handled.
    pub fn handle_message(&self, data: &str) -> bool {
        let Ok(msg) = serde_json::from_str::<Value>(data) else {
            return false;
        };

        // Response (has "id" and "type")
        if msg.get("id").and_then(|v| v.as_u64()).is_some()
            && msg.get("type").and_then(|v| v.as_str()).is_some()
        {
            let id = msg["id"].as_u64().unwrap();
            if let Some((_, tx)) = self.pending.remove(&id) {
                let _ = tx.send(msg);
                return true;
            }
            return false;
        }

        // Event (has "type": "event" and "method")
        if msg.get("type").and_then(|v| v.as_str()) == Some("event") {
            if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                let params = msg.get("params").cloned().unwrap_or(json!({}));
                if let Some(list) = self.event_handlers.get(method) {
                    let handlers = list.clone();
                    drop(list);
                    for h in &handlers {
                        h(params.clone());
                    }
                }
                return true;
            }
        }

        false
    }

    /// Send a BiDi command and wait for the response.
    pub async fn send(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cmd = json!({"id": id, "method": method, "params": params});

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
            SpiderError::Timeout(format!("BiDi command timeout: {method} ({}ms)", self.timeout_ms))
        })?
        .map_err(|_| SpiderError::connection("BiDi response channel closed"))?;

        if resp.get("type").and_then(|v| v.as_str()) == Some("error") {
            let msg = resp.get("message").or(resp.get("error"))
                .and_then(|v| v.as_str()).unwrap_or("unknown");
            return Err(SpiderError::Protocol(format!("BiDi error: {msg}")));
        }

        Ok(resp)
    }

    pub fn on(&self, method: &str, handler: Arc<dyn Fn(Value) + Send + Sync>) {
        self.event_handlers
            .entry(method.to_string())
            .or_default()
            .push(handler);
    }

    /// Get or create a browsing context.
    pub async fn get_or_create_context(&self) -> Result<String> {
        if let Some(ctx) = self.context() {
            return Ok(ctx);
        }

        // Strategy 1: browsingContext.getTree
        if let Ok(resp) = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            self.send("browsingContext.getTree", json!({})),
        ).await {
            if let Ok(resp) = resp {
                if let Some(contexts) = resp.get("result")
                    .and_then(|r| r.get("contexts"))
                    .and_then(|v| v.as_array())
                {
                    if let Some(first) = contexts.first() {
                        if let Some(ctx) = first.get("context").and_then(|v| v.as_str()) {
                            self.browsing_context.store(Arc::new(Some(ctx.to_string())));
                            return Ok(ctx.to_string());
                        }
                    }
                }
            }
        }

        // Strategy 2: browsingContext.create
        if let Ok(resp) = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            self.send("browsingContext.create", json!({"type": "tab"})),
        ).await {
            if let Ok(resp) = resp {
                if let Some(ctx) = resp.get("result")
                    .and_then(|r| r.get("context"))
                    .and_then(|v| v.as_str())
                {
                    self.browsing_context.store(Arc::new(Some(ctx.to_string())));
                    return Ok(ctx.to_string());
                }
            }
        }

        // Strategy 3: placeholder
        let placeholder = "__default__".to_string();
        self.browsing_context.store(Arc::new(Some(placeholder.clone())));
        Ok(placeholder)
    }

    pub fn set_context(&self, context_id: &str) {
        self.browsing_context.store(Arc::new(Some(context_id.to_string())));
    }

    pub async fn navigate(&self, url: &str) -> Result<()> {
        let ctx = self.get_or_create_context().await?;
        let resp = self.send("browsingContext.navigate", json!({
            "context": ctx, "url": url, "wait": "complete",
        })).await?;
        // Extract real context from response if placeholder
        if ctx == "__default__" {
            if let Some(real_ctx) = resp.get("params")
                .and_then(|p| p.get("context"))
                .and_then(|v| v.as_str())
            {
                self.set_context(real_ctx);
            }
        }
        Ok(())
    }

    pub async fn capture_screenshot(&self) -> Result<String> {
        let ctx = self.get_or_create_context().await?;
        let resp = self.send("browsingContext.captureScreenshot", json!({"context": ctx})).await?;
        resp.get("result")
            .and_then(|r| r.get("data"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| SpiderError::Protocol("captureScreenshot: missing result.data".into()))
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        let ctx = self.get_or_create_context().await?;
        let resp = self.send("script.evaluate", json!({
            "expression": expression,
            "target": {"context": ctx},
            "awaitPromise": false,
            "resultOwnership": "none",
        })).await?;

        let result_obj = resp.get("result")
            .and_then(|r| r.get("result"))
            .or_else(|| resp.get("result"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(extract_bidi_value(&result_obj))
    }

    pub async fn get_html(&self) -> Result<String> {
        let val = self.evaluate("document.documentElement.outerHTML").await?;
        Ok(val.as_str().unwrap_or("").to_string())
    }

    pub async fn perform_actions(&self, actions: Value) -> Result<()> {
        let ctx = self.get_or_create_context().await?;
        self.send("input.performActions", json!({
            "context": ctx, "actions": actions,
        })).await?;
        Ok(())
    }

    pub async fn click_point(&self, x: f64, y: f64) -> Result<()> {
        self.perform_actions(json!([{
            "type": "pointer", "id": "mouse",
            "actions": [
                {"type": "pointerMove", "x": x.round() as i64, "y": y.round() as i64},
                {"type": "pointerDown", "button": 0},
                {"type": "pointerUp", "button": 0},
            ]
        }])).await
    }

    pub async fn insert_text(&self, text: &str) -> Result<()> {
        let actions: Vec<Value> = text.chars().flat_map(|ch| {
            let s = ch.to_string();
            vec![
                json!({"type": "keyDown", "value": s}),
                json!({"type": "keyUp", "value": s}),
            ]
        }).collect();
        self.perform_actions(json!([{"type": "key", "id": "keyboard", "actions": actions}])).await
    }

    pub fn destroy(&self) {
        self.pending.clear();
        self.event_handlers.clear();
        self.browsing_context.store(Arc::new(None));
    }
}

fn extract_bidi_value(remote: &Value) -> Value {
    match remote.get("type").and_then(|v| v.as_str()) {
        Some("undefined") | Some("null") => Value::Null,
        Some("string") | Some("number") | Some("boolean") | Some("bigint") => {
            remote.get("value").cloned().unwrap_or(Value::Null)
        }
        Some("array") => {
            if let Some(arr) = remote.get("value").and_then(|v| v.as_array()) {
                Value::Array(arr.iter().map(extract_bidi_value).collect())
            } else {
                remote.get("value").cloned().unwrap_or(Value::Null)
            }
        }
        Some("object") => {
            if let Some(pairs) = remote.get("value").and_then(|v| v.as_array()) {
                let mut map = serde_json::Map::new();
                for entry in pairs {
                    if let Some(pair) = entry.as_array() {
                        if pair.len() == 2 {
                            let key = pair[0].as_str()
                                .map(|s| s.to_string())
                                .or_else(|| pair[0].get("value").and_then(|v| v.as_str()).map(|s| s.to_string()))
                                .unwrap_or_default();
                            map.insert(key, extract_bidi_value(&pair[1]));
                        }
                    }
                }
                Value::Object(map)
            } else {
                remote.get("value").cloned().unwrap_or(Value::Null)
            }
        }
        _ => remote.get("value").cloned().unwrap_or(remote.clone()),
    }
}
