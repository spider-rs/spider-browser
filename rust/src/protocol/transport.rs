//! Lock-free WebSocket transport to Spider's browser fleet.

use crate::errors::{Result, SpiderError};
use crate::events::SpiderEventEmitter;
use arc_swap::ArcSwap;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

/// Sentinel for "no f64 value stored".
const NO_F64: u64 = u64::MAX;

/// Transport configuration options.
#[derive(Clone, Debug)]
pub struct TransportOptions {
    pub api_key: String,
    pub server_url: String,
    pub browser: String,
    pub url: Option<String>,
    pub captcha: Option<String>,
    pub stealth_level: u32,
    pub connect_timeout_ms: u64,
    pub command_timeout_ms: u64,
    pub hedge: bool,
    pub record: bool,
    pub mode: Option<String>,
    pub country: Option<String>,
    pub proxy_url: Option<String>,
}

impl Default for TransportOptions {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            server_url: "wss://browser.spider.cloud".into(),
            browser: "auto".into(),
            url: None,
            captcha: Some("solve".into()),
            stealth_level: 0,
            connect_timeout_ms: 30_000,
            command_timeout_ms: 30_000,
            hedge: false,
            record: false,
            mode: None,
            country: None,
            proxy_url: None,
        }
    }
}

/// Lock-free WebSocket transport.
///
/// All state is stored in atomics or ArcSwap. The WS write half is owned
/// by a dedicated writer task; callers send through a channel.
pub struct Transport {
    opts: TransportOptions,
    current_browser: ArcSwap<String>,
    stealth_level: AtomicU64,
    emitter: SpiderEventEmitter,
    /// Channel for outgoing WS messages — writer task drains this.
    ws_send_tx: mpsc::UnboundedSender<String>,
    ws_send_rx: tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    /// Channel for incoming messages forwarded to CDPSession/BiDiSession.
    message_tx: mpsc::UnboundedSender<String>,
    message_rx: tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    generation: AtomicU64,
    connected: AtomicBool,
    // Metering (stored as f64 bits in AtomicU64)
    upgrade_credits: AtomicU64,
    upgrade_stealth_tier: AtomicU64,
    upgrade_proxy_tier: AtomicU64,
    session_credits_used: AtomicU64,
    /// Handle to abort recv+write tasks on close/reconnect.
    task_handles: ArcSwap<Vec<tokio::task::JoinHandle<()>>>,
}

impl Transport {
    pub fn new(opts: TransportOptions, emitter: SpiderEventEmitter) -> Arc<Self> {
        let browser = if opts.browser == "auto" {
            "chrome-h".to_string()
        } else {
            opts.browser.clone()
        };
        let stealth = opts.stealth_level;
        let (ws_tx, ws_rx) = mpsc::unbounded_channel();
        let (msg_tx, msg_rx) = mpsc::unbounded_channel();

        Arc::new(Self {
            opts,
            current_browser: ArcSwap::from_pointee(browser),
            stealth_level: AtomicU64::new(stealth as u64),
            emitter,
            ws_send_tx: ws_tx,
            ws_send_rx: tokio::sync::Mutex::new(Some(ws_rx)),
            message_tx: msg_tx,
            message_rx: tokio::sync::Mutex::new(Some(msg_rx)),
            generation: AtomicU64::new(0),
            connected: AtomicBool::new(false),
            upgrade_credits: AtomicU64::new(NO_F64),
            upgrade_stealth_tier: AtomicU64::new(NO_F64),
            upgrade_proxy_tier: AtomicU64::new(NO_F64),
            session_credits_used: AtomicU64::new(NO_F64),
            task_handles: ArcSwap::from_pointee(Vec::new()),
        })
    }

    pub fn browser(&self) -> String {
        self.current_browser.load().as_ref().clone()
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn get_stealth_level(&self) -> u32 {
        self.stealth_level.load(Ordering::Relaxed) as u32
    }

    pub fn set_stealth_level(&self, level: u32) {
        self.stealth_level
            .store(level.min(3) as u64, Ordering::Relaxed);
    }

    pub fn upgrade_credits(&self) -> Option<f64> {
        let bits = self.upgrade_credits.load(Ordering::Relaxed);
        if bits == NO_F64 {
            None
        } else {
            Some(f64::from_bits(bits))
        }
    }

    pub fn session_credits_used(&self) -> Option<f64> {
        let bits = self.session_credits_used.load(Ordering::Relaxed);
        if bits == NO_F64 {
            None
        } else {
            Some(f64::from_bits(bits))
        }
    }

    pub fn command_timeout_ms(&self) -> u64 {
        self.opts.command_timeout_ms
    }

    /// Take the message receiver (can only be called once).
    pub async fn take_message_rx(&self) -> Option<mpsc::UnboundedReceiver<String>> {
        self.message_rx.lock().await.take()
    }

    /// Send a raw JSON string through the WebSocket channel.
    pub fn send(&self, data: String) -> Result<()> {
        self.ws_send_tx
            .send(data)
            .map_err(|_| SpiderError::connection("WebSocket is not connected"))
    }

    /// Connect to the Spider WebSocket with retry.
    pub async fn connect(self: &Arc<Self>, max_attempts: u32) -> Result<()> {
        if self.connected.load(Ordering::Relaxed) {
            return Ok(());
        }

        let mut last_error = None;
        for attempt in 1..=max_attempts {
            match self.connect_internal().await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if matches!(e, SpiderError::Auth(_)) {
                        return Err(e);
                    }
                    last_error = Some(e);
                    if attempt < max_attempts {
                        let backoff = 500 * attempt as u64;
                        warn!(
                            "connect attempt {}/{} failed, retrying in {}ms",
                            attempt, max_attempts, backoff
                        );
                        tokio::time::sleep(tokio::time::Duration::from_millis(backoff)).await;
                    }
                }
            }
        }
        Err(last_error.unwrap())
    }

    /// Reconnect with a different browser type.
    pub async fn reconnect(self: &Arc<Self>, browser: &str) -> Result<()> {
        let prev = self.browser();
        self.current_browser
            .store(Arc::new(browser.to_string()));
        self.close();
        info!("switching browser: {} -> {}", prev, browser);
        self.connect_internal().await
    }

    /// Close the WebSocket connection.
    pub fn close(&self) {
        let handles = self.task_handles.swap(Arc::new(Vec::new()));
        for h in handles.iter() {
            h.abort();
        }
        self.connected.store(false, Ordering::Relaxed);
    }

    fn build_url(&self, browser: &str, stealth: u32) -> String {
        let base = self.opts.server_url.trim_end_matches('/');
        let mut params = vec![format!("token={}", self.opts.api_key)];
        if browser != "auto" {
            params.push(format!("browser={browser}"));
        }
        if let Some(ref url) = self.opts.url {
            params.push(format!("url={}", urlencoding::encode(url)));
        }
        if let Some(ref captcha) = self.opts.captcha {
            if captcha != "off" {
                params.push(format!("ai_captcha={captcha}"));
            }
        }
        if stealth > 0 {
            params.push(format!("s={stealth}"));
        }
        if self.opts.hedge {
            params.push("hedge=true".into());
        }
        if self.opts.record {
            params.push("record=true".into());
        }
        if let Some(ref mode) = self.opts.mode {
            params.push(format!("mode={mode}"));
        }
        if let Some(ref country) = self.opts.country {
            params.push(format!("country={country}"));
        }
        if let Some(ref proxy_url) = self.opts.proxy_url {
            params.push(format!("proxy_url={}", urlencoding::encode(proxy_url)));
        }
        format!("{base}/v1/browser?{}", params.join("&"))
    }

    async fn connect_internal(self: &Arc<Self>) -> Result<()> {
        let gen = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let browser = self.browser();
        let stealth = self.get_stealth_level();

        let url_str = self.build_url(&browser, stealth);
        let safe_url = url_str.split("token=").next().unwrap_or(&url_str);
        debug!("connecting to {}token=***", safe_url);

        let timeout = tokio::time::Duration::from_millis(self.opts.connect_timeout_ms);

        let ws_stream = tokio::time::timeout(timeout, async {
            let (stream, _response) = tokio_tungstenite::connect_async(&url_str)
                .await
                .map_err(|e| {
                    let msg = e.to_string();
                    if msg.contains("429") {
                        SpiderError::rate_limit("Server at capacity (429)")
                    } else {
                        SpiderError::connection(format!("WebSocket error: {e}"))
                    }
                })?;
            Ok::<_, SpiderError>(stream)
        })
        .await
        .map_err(|_| {
            SpiderError::Timeout(format!(
                "WebSocket connection timeout ({}ms)",
                self.opts.connect_timeout_ms
            ))
        })??;

        let (mut sink, mut stream) = ws_stream.split();
        self.connected.store(true, Ordering::Relaxed);
        self.emitter.emit("ws.open", json!({}));
        info!("connected (browser={}, stealth={})", browser, stealth);

        // Writer task — owns the sink, drains the ws_send channel.
        // Take the receiver (only on first connect; subsequent connects create new channels).
        let ws_rx = self.ws_send_rx.lock().await.take();
        let write_handle = if let Some(mut rx) = ws_rx {
            tokio::spawn(async move {
                while let Some(data) = rx.recv().await {
                    if sink.send(Message::Text(data.into())).await.is_err() {
                        break;
                    }
                }
                let _ = sink.close().await;
            })
        } else {
            // Fallback: no receiver available (shouldn't happen in normal flow)
            tokio::spawn(async move {
                let _ = sink.close().await;
            })
        };

        // Reader task — forwards messages to message_tx, intercepts Spider.* events.
        let msg_tx = self.message_tx.clone();
        let this = Arc::clone(self);

        let read_handle = tokio::spawn(async move {
            while let Some(msg) = stream.next().await {
                if this.generation.load(Ordering::Relaxed) != gen {
                    return;
                }
                match msg {
                    Ok(Message::Text(text)) => {
                        let text_str = text.to_string();
                        if text_str.contains("\"Spider.") {
                            if handle_spider_transport_event(
                                &text_str,
                                &this,
                            ) {
                                continue;
                            }
                        }
                        let _ = msg_tx.send(text_str);
                    }
                    Ok(Message::Binary(data)) => {
                        if let Ok(text) = String::from_utf8(data.to_vec()) {
                            let _ = msg_tx.send(text);
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        let (code, reason) = frame
                            .map(|f| (f.code.into(), f.reason.to_string()))
                            .unwrap_or((0u16, String::new()));
                        if this.generation.load(Ordering::Relaxed) == gen {
                            this.emitter.emit(
                                "ws.close",
                                json!({"code": code, "reason": reason}),
                            );
                        }
                        break;
                    }
                    Err(e) => {
                        if this.generation.load(Ordering::Relaxed) == gen {
                            this.emitter.emit("ws.error", json!({"error": e.to_string()}));
                        }
                        break;
                    }
                    _ => {}
                }
            }
            this.connected.store(false, Ordering::Relaxed);
        });

        self.task_handles
            .store(Arc::new(vec![write_handle, read_handle]));
        Ok(())
    }
}

fn handle_spider_transport_event(
    data: &str,
    transport: &Transport,
) -> bool {
    let Ok(msg) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));

    match method {
        "Spider.screencastFrame" => {
            transport.emitter.emit("screencast.frame", params);
            true
        }
        "Spider.interactionEvents" => {
            transport.emitter.emit("screencast.interactionEvents", params);
            true
        }
        "Spider.rrwebEvents" => {
            transport.emitter.emit("screencast.rrwebEvents", params);
            true
        }
        "Spider.recordingStarted" => {
            transport.emitter.emit("recording.started", params);
            true
        }
        "Spider.recordingCompleted" => {
            transport.emitter.emit("recording.completed", params);
            true
        }
        "Spider.metering" => {
            if let Some(credits_used) = params.get("credits_used").and_then(|v| v.as_f64()) {
                transport.session_credits_used.store(credits_used.to_bits(), Ordering::Relaxed);
                let uc_bits = transport.upgrade_credits.load(Ordering::Relaxed);
                let uc = if uc_bits == NO_F64 {
                    0.0
                } else {
                    f64::from_bits(uc_bits)
                };
                let us_bits = transport.upgrade_stealth_tier.load(Ordering::Relaxed);
                let us = if us_bits == NO_F64 {
                    0u32
                } else {
                    f64::from_bits(us_bits) as u32
                };
                transport.emitter.emit(
                    "metering",
                    json!({
                        "credits": uc,
                        "rate": us,
                        "session_credits_used": credits_used,
                    }),
                );
                return true;
            }
            false
        }
        _ => false,
    }
}

mod urlencoding {
    pub fn encode(s: &str) -> String {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
    }
}
