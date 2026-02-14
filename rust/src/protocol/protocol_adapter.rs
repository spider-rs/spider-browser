//! Unified protocol adapter — wraps either CDPSession or BiDiSession.

use crate::errors::{Result, SpiderError};
use crate::events::SpiderEventEmitter;
use crate::protocol::bidi_session::BiDiSession;
use crate::protocol::cdp_session::CDPSession;
use crate::protocol::types::get_key_params;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, info};

/// Protocol adapter options.
pub struct ProtocolAdapterOptions {
    pub command_timeout_ms: Option<u64>,
}

/// Determines which protocol to use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProtocolType {
    Cdp,
    Bidi,
    Auto,
}

/// Unified protocol interface wrapping CDPSession or BiDiSession.
pub struct ProtocolAdapter {
    cdp: Option<CDPSession>,
    bidi: Option<BiDiSession>,
    protocol: ProtocolType,
    send_tx: mpsc::UnboundedSender<String>,
    emitter: SpiderEventEmitter,
    command_timeout_ms: u64,
}

impl ProtocolAdapter {
    pub fn new(
        send_tx: mpsc::UnboundedSender<String>,
        emitter: SpiderEventEmitter,
        browser: &str,
        opts: Option<ProtocolAdapterOptions>,
    ) -> Self {
        let timeout = opts.as_ref()
            .and_then(|o| o.command_timeout_ms)
            .unwrap_or(30_000);

        let (cdp, bidi, protocol) = if browser == "auto" {
            (None, None, ProtocolType::Auto)
        } else if browser == "firefox" {
            (None, Some(BiDiSession::new(send_tx.clone(), timeout)), ProtocolType::Bidi)
        } else {
            (Some(CDPSession::new(send_tx.clone(), timeout)), None, ProtocolType::Cdp)
        };

        Self {
            cdp,
            bidi,
            protocol,
            send_tx,
            emitter,
            command_timeout_ms: timeout,
        }
    }

    pub fn protocol_type(&self) -> ProtocolType {
        self.protocol
    }

    /// Route incoming WebSocket messages to the right session.
    pub fn route_message(&self, data: &str) {
        // Check for Spider.* events first
        if let Ok(msg) = serde_json::from_str::<Value>(data) {
            if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                if method.starts_with("Spider.") {
                    self.handle_spider_event(method, msg.get("params").cloned().unwrap_or(json!({})));
                    return;
                }
            }
        }

        if let Some(ref cdp) = self.cdp {
            cdp.handle_message(data);
        } else if let Some(ref bidi) = self.bidi {
            bidi.handle_message(data);
        }
    }

    fn handle_spider_event(&self, method: &str, params: Value) {
        match method {
            "Spider.captchaDetected" => {
                self.emitter.emit("captcha.detected", params);
            }
            "Spider.captchaSolving" => {
                self.emitter.emit("captcha.solving", params);
            }
            "Spider.captchaSolved" => {
                self.emitter.emit("captcha.solved", params);
            }
            "Spider.captchaFailed" => {
                self.emitter.emit("captcha.failed", params);
            }
            _ => {
                debug!("unhandled Spider event: {}", method);
            }
        }
    }

    /// Initialize the protocol session.
    pub async fn init(&mut self) -> Result<()> {
        if self.protocol == ProtocolType::Auto {
            self.auto_detect_and_init().await?;
            return Ok(());
        }

        if let Some(ref cdp) = self.cdp {
            cdp.attach_to_page().await?;
        } else if let Some(ref bidi) = self.bidi {
            bidi.get_or_create_context().await?;
        }
        Ok(())
    }

    async fn auto_detect_and_init(&mut self) -> Result<()> {
        // Try CDP first
        let cdp = CDPSession::new(self.send_tx.clone(), self.command_timeout_ms);
        match cdp.attach_to_page().await {
            Ok(_) => {
                self.cdp = Some(cdp);
                self.protocol = ProtocolType::Cdp;
                info!("auto-detected CDP protocol");
                return Ok(());
            }
            Err(_) => {
                cdp.destroy();
            }
        }

        // Try BiDi
        let bidi = BiDiSession::new(self.send_tx.clone(), self.command_timeout_ms);
        bidi.get_or_create_context().await?;
        self.bidi = Some(bidi);
        self.protocol = ProtocolType::Bidi;
        info!("auto-detected BiDi protocol");
        Ok(())
    }

    // ------------------------------------------------------------------
    // Unified interface
    // ------------------------------------------------------------------

    pub async fn navigate(&self, url: &str) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.navigate(url).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.navigate(url).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn navigate_fast(&self, url: &str) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.navigate_fast(url).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.navigate(url).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn navigate_dom(&self, url: &str) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.navigate_dom(url).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.navigate(url).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn get_html(&self) -> Result<String> {
        if let Some(ref cdp) = self.cdp {
            cdp.get_html().await
        } else if let Some(ref bidi) = self.bidi {
            bidi.get_html().await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        if let Some(ref cdp) = self.cdp {
            cdp.evaluate(expression).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.evaluate(expression).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn capture_screenshot(&self) -> Result<String> {
        if let Some(ref cdp) = self.cdp {
            cdp.capture_screenshot().await
        } else if let Some(ref bidi) = self.bidi {
            bidi.capture_screenshot().await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn click_point(&self, x: f64, y: f64) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.click_point(x, y).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.click_point(x, y).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn right_click_point(&self, x: f64, y: f64) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.right_click_point(x, y).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.perform_actions(json!([{
                "type": "pointer", "id": "mouse",
                "actions": [
                    {"type": "pointerMove", "x": x.round() as i64, "y": y.round() as i64},
                    {"type": "pointerDown", "button": 2},
                    {"type": "pointerUp", "button": 2},
                ]
            }])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn double_click_point(&self, x: f64, y: f64) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.double_click_point(x, y).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.perform_actions(json!([{
                "type": "pointer", "id": "mouse",
                "actions": [
                    {"type": "pointerMove", "x": x.round() as i64, "y": y.round() as i64},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerUp", "button": 0},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerUp", "button": 0},
                ]
            }])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn click_hold_point(&self, x: f64, y: f64, hold_ms: u64) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.click_hold_point(x, y, hold_ms).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.perform_actions(json!([{
                "type": "pointer", "id": "mouse",
                "actions": [
                    {"type": "pointerMove", "x": x.round() as i64, "y": y.round() as i64},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pause", "duration": hold_ms},
                    {"type": "pointerUp", "button": 0},
                ]
            }])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn hover_point(&self, x: f64, y: f64) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.hover_point(x, y).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.perform_actions(json!([{
                "type": "pointer", "id": "mouse",
                "actions": [{"type": "pointerMove", "x": x.round() as i64, "y": y.round() as i64}]
            }])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn drag_point(&self, from_x: f64, from_y: f64, to_x: f64, to_y: f64) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.drag_point(from_x, from_y, to_x, to_y).await
        } else if let Some(ref bidi) = self.bidi {
            let steps = 10;
            let mut actions = vec![
                json!({"type": "pointerMove", "x": from_x.round() as i64, "y": from_y.round() as i64}),
                json!({"type": "pointerDown", "button": 0}),
            ];
            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                actions.push(json!({
                    "type": "pointerMove",
                    "x": (from_x + (to_x - from_x) * t).round() as i64,
                    "y": (from_y + (to_y - from_y) * t).round() as i64,
                    "duration": 16,
                }));
            }
            actions.push(json!({"type": "pointerUp", "button": 0}));
            bidi.perform_actions(json!([{"type": "pointer", "id": "mouse", "actions": actions}])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn insert_text(&self, text: &str) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.insert_text(text).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.insert_text(text).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn press_key(&self, key_name: &str) -> Result<()> {
        let (key, code, key_code) = get_key_params(key_name);
        if let Some(ref cdp) = self.cdp {
            cdp.press_key(key, code, key_code).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.perform_actions(json!([{
                "type": "key", "id": "keyboard",
                "actions": [
                    {"type": "keyDown", "value": key},
                    {"type": "keyUp", "value": key},
                ]
            }])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn key_down(&self, key_name: &str) -> Result<()> {
        let (key, code, key_code) = get_key_params(key_name);
        if let Some(ref cdp) = self.cdp {
            cdp.key_down(key, code, key_code).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.perform_actions(json!([{
                "type": "key", "id": "keyboard",
                "actions": [{"type": "keyDown", "value": key}]
            }])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn key_up(&self, key_name: &str) -> Result<()> {
        let (key, code, key_code) = get_key_params(key_name);
        if let Some(ref cdp) = self.cdp {
            cdp.key_up(key, code, key_code).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.perform_actions(json!([{
                "type": "key", "id": "keyboard",
                "actions": [{"type": "keyUp", "value": key}]
            }])).await
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub async fn set_viewport(&self, width: u32, height: u32, dpr: f64, mobile: bool) -> Result<()> {
        if let Some(ref cdp) = self.cdp {
            cdp.set_viewport(width, height, dpr, mobile).await
        } else if let Some(ref bidi) = self.bidi {
            bidi.evaluate(&format!("window.resizeTo({width}, {height})")).await?;
            Ok(())
        } else {
            Err(SpiderError::Protocol("No protocol session".into()))
        }
    }

    pub fn on_protocol_event(&self, method: &str, handler: Arc<dyn Fn(Value) + Send + Sync>) {
        if let Some(ref cdp) = self.cdp {
            cdp.on(method, handler);
        } else if let Some(ref bidi) = self.bidi {
            bidi.on(method, handler);
        }
    }

    pub fn destroy(&self) {
        if let Some(ref cdp) = self.cdp {
            cdp.destroy();
        }
        if let Some(ref bidi) = self.bidi {
            bidi.destroy();
        }
    }
}
