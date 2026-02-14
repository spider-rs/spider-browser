//! SpiderBrowser — main entry point for spider-browser.

use crate::errors::{Result, SpiderError};
use crate::events::SpiderEventEmitter;
use crate::page::SpiderPage;
use crate::protocol::protocol_adapter::{ProtocolAdapter, ProtocolAdapterOptions};
use crate::protocol::transport::{Transport, TransportOptions};
use arc_swap::ArcSwap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::info;

#[cfg(feature = "ai")]
use crate::ai::llm_provider::{create_provider, LLMConfig, LLMProvider};

/// Options for creating a SpiderBrowser instance.
#[derive(Clone, Debug)]
pub struct SpiderBrowserOptions {
    /// Spider API key (required).
    pub api_key: String,
    /// WebSocket server URL (default: wss://browser.spider.cloud).
    pub server_url: Option<String>,
    /// Browser to use (default: "auto").
    pub browser: Option<String>,
    /// Target URL hint for server browser+proxy selection.
    pub url: Option<String>,
    /// Captcha handling: "off", "detect", or "solve" (default: "solve").
    pub captcha: Option<String>,
    /// Enable smart retry with browser switching (default: true).
    pub smart_retry: Option<bool>,
    /// Max retry attempts across all browsers (default: 12).
    pub max_retries: Option<u32>,
    /// Stealth level (1-3). 0 = auto-escalate on failure.
    pub stealth: Option<u32>,
    /// Maximum stealth level to auto-escalate to (1-3, default: 3).
    pub max_stealth_levels: Option<u32>,
    /// WebSocket connect timeout in ms (default: 30000).
    pub connect_timeout_ms: Option<u64>,
    /// CDP/BiDi command timeout in ms (default: 30000).
    pub command_timeout_ms: Option<u64>,
    /// Timeout for retry attempts (default: 15000).
    pub retry_timeout_ms: Option<u64>,
    /// Mark this session as a hedge (parallel attempt).
    pub hedge: Option<bool>,
    /// Enable screencast recording (default: false).
    pub record: Option<bool>,
    /// Browser mode: "scraping" or "cua".
    pub mode: Option<String>,
    /// LLM configuration for AI methods.
    #[cfg(feature = "ai")]
    pub llm: Option<LLMConfig>,
}

impl SpiderBrowserOptions {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            server_url: None,
            browser: None,
            url: None,
            captcha: None,
            smart_retry: None,
            max_retries: None,
            stealth: None,
            max_stealth_levels: None,
            connect_timeout_ms: None,
            command_timeout_ms: None,
            retry_timeout_ms: None,
            hedge: None,
            record: None,
            mode: None,
            #[cfg(feature = "ai")]
            llm: None,
        }
    }
}

struct ResolvedOptions {
    api_key: String,
    server_url: String,
    browser: String,
    url: Option<String>,
    captcha: String,
    smart_retry: bool,
    max_retries: u32,
    stealth: u32,
    max_stealth_levels: u32,
    connect_timeout_ms: u64,
    command_timeout_ms: u64,
    retry_timeout_ms: u64,
    hedge: Option<bool>,
    record: Option<bool>,
    mode: Option<String>,
}

/// SpiderBrowser — connects to Spider's pre-warmed browser fleet.
///
/// Provides deterministic page control (via SpiderPage) and
/// AI-powered automation (act, observe, extract, agent).
pub struct SpiderBrowser {
    opts: ResolvedOptions,
    transport: Option<Arc<Transport>>,
    adapter: Option<Arc<ProtocolAdapter>>,
    page: Option<Arc<SpiderPage>>,
    emitter: SpiderEventEmitter,
    current_url: ArcSwap<Option<String>>,
    #[cfg(feature = "ai")]
    llm_provider: Option<Box<dyn LLMProvider>>,
    msg_send_tx: Option<mpsc::UnboundedSender<String>>,
}

impl SpiderBrowser {
    pub fn new(options: SpiderBrowserOptions) -> Self {
        let resolved = ResolvedOptions {
            api_key: options.api_key.clone(),
            server_url: options.server_url.unwrap_or_else(|| "wss://browser.spider.cloud".into()),
            browser: options.browser.unwrap_or_else(|| "auto".into()),
            url: options.url.clone(),
            captcha: options.captcha.unwrap_or_else(|| "solve".into()),
            smart_retry: options.smart_retry.unwrap_or(true),
            max_retries: options.max_retries.unwrap_or(12),
            stealth: options.stealth.unwrap_or(0),
            max_stealth_levels: options.max_stealth_levels.unwrap_or(3),
            connect_timeout_ms: options.connect_timeout_ms.unwrap_or(30_000),
            command_timeout_ms: options.command_timeout_ms.unwrap_or(30_000),
            retry_timeout_ms: options.retry_timeout_ms.unwrap_or(15_000),
            hedge: options.hedge,
            record: options.record,
            mode: options.mode.clone(),
        };

        #[cfg(feature = "ai")]
        let llm_provider: Option<Box<dyn LLMProvider>> =
            options.llm.map(|config| create_provider(config));

        Self {
            opts: resolved,
            transport: None,
            adapter: None,
            page: None,
            emitter: SpiderEventEmitter::new(),
            current_url: ArcSwap::from_pointee(options.url),
            #[cfg(feature = "ai")]
            llm_provider,
            msg_send_tx: None,
        }
    }

    /// The active page instance for deterministic browser control.
    pub fn page(&self) -> &SpiderPage {
        self.page
            .as_ref()
            .expect("SpiderBrowser not initialized. Call init() first.")
    }

    /// Current browser type.
    pub fn browser(&self) -> String {
        self.transport
            .as_ref()
            .map(|t| t.browser())
            .unwrap_or_else(|| self.opts.browser.clone())
    }

    /// Whether the WebSocket is connected.
    pub fn connected(&self) -> bool {
        self.transport
            .as_ref()
            .map(|t| t.is_connected())
            .unwrap_or(false)
    }

    /// Active stealth level.
    pub fn stealth_level(&self) -> u32 {
        self.transport
            .as_ref()
            .map(|t| t.get_stealth_level())
            .unwrap_or(self.opts.stealth)
    }

    /// Credits remaining from last upgrade response.
    pub fn credits(&self) -> Option<f64> {
        self.transport.as_ref().and_then(|t| t.upgrade_credits())
    }

    /// Credits consumed during this session.
    pub fn session_credits_used(&self) -> Option<f64> {
        self.transport
            .as_ref()
            .and_then(|t| t.session_credits_used())
    }

    /// Subscribe to events.
    pub fn on(&self, event: &str, handler: crate::events::EventHandler) {
        self.emitter.on(event, handler);
    }

    /// Connect to the browser fleet and initialize the protocol.
    pub async fn init(&mut self) -> Result<()> {
        let transport_opts = TransportOptions {
            api_key: self.opts.api_key.clone(),
            server_url: self.opts.server_url.clone(),
            browser: self.opts.browser.clone(),
            url: self.opts.url.clone(),
            captcha: Some(self.opts.captcha.clone()),
            stealth_level: self.opts.stealth,
            connect_timeout_ms: self.opts.connect_timeout_ms,
            command_timeout_ms: self.opts.command_timeout_ms,
            hedge: self.opts.hedge.unwrap_or(false),
            record: self.opts.record.unwrap_or(false),
            mode: self.opts.mode.clone(),
        };

        let transport = Transport::new(transport_opts, self.emitter.clone());
        transport.connect(3).await?;

        let active_browser = transport.browser();

        // Take the message receiver and set up routing
        let mut msg_rx = transport
            .take_message_rx()
            .await
            .ok_or_else(|| SpiderError::Protocol("Message receiver already taken".into()))?;

        let adapter_opts = if self.opts.command_timeout_ms != 30_000 {
            Some(ProtocolAdapterOptions {
                command_timeout_ms: Some(self.opts.command_timeout_ms),
            })
        } else {
            None
        };

        // Create a relay channel that forwards outgoing messages to the transport's WS
        let (proto_tx, mut proto_rx) = mpsc::unbounded_channel::<String>();
        let transport_for_relay = Arc::clone(&transport);
        tokio::spawn(async move {
            while let Some(data) = proto_rx.recv().await {
                let _ = transport_for_relay.send(data);
            }
        });

        let mut adapter = ProtocolAdapter::new(
            proto_tx.clone(),
            self.emitter.clone(),
            &active_browser,
            adapter_opts,
        );
        adapter.init().await?;

        // Wrap adapter in Arc for sharing between page and AI methods
        let adapter = Arc::new(adapter);
        let page = SpiderPage::from_arc(Arc::clone(&adapter));
        let page = Arc::new(page);

        // Spawn message routing task: transport -> adapter.route_message()
        let page_for_routing = Arc::clone(&page);
        tokio::spawn(async move {
            while let Some(data) = msg_rx.recv().await {
                page_for_routing.route_message(&data);
            }
        });

        self.transport = Some(transport);
        self.adapter = Some(adapter);
        self.page = Some(page);
        self.msg_send_tx = Some(proto_tx);

        info!("SpiderBrowser initialized (browser={})", active_browser);
        Ok(())
    }

    /// Navigate to a URL with smart retry.
    pub async fn goto(&self, url: &str) -> Result<()> {
        self.current_url.store(Arc::new(Some(url.to_string())));
        self.page().goto(url).await
    }

    /// Close the connection and clean up resources.
    pub fn close(&mut self) {
        if let Some(ref page) = self.page {
            page.destroy();
        }
        if let Some(ref transport) = self.transport {
            transport.close();
        }
        self.emitter.remove_all_listeners();
        self.page = None;
        self.adapter = None;
        self.transport = None;
        info!("SpiderBrowser closed");
    }

    // ------------------------------------------------------------------
    // AI Methods (require "ai" feature + LLM config)
    // ------------------------------------------------------------------

    /// Execute a single action from natural language.
    #[cfg(feature = "ai")]
    pub async fn act(&self, instruction: &str) -> Result<()> {
        let llm = self.require_llm()?;
        let adapter = self.require_adapter()?;
        crate::ai::act::act(adapter, llm.as_ref(), instruction).await
    }

    /// Discover interactive elements on the page.
    #[cfg(feature = "ai")]
    pub async fn observe(
        &self,
        instruction: Option<&str>,
    ) -> Result<Vec<crate::ai::observe::ObserveResult>> {
        let adapter = self.require_adapter()?;
        let llm_ref: Option<&dyn LLMProvider> = self.llm_provider.as_ref().map(|b| b.as_ref());
        crate::ai::observe::observe(adapter, instruction, llm_ref).await
    }

    /// Extract structured data from the page.
    #[cfg(feature = "ai")]
    pub async fn extract<T: serde::de::DeserializeOwned + Send>(
        &self,
        instruction: &str,
    ) -> Result<T> {
        let llm = self.require_llm()?;
        let adapter = self.require_adapter()?;
        crate::ai::extract::extract(adapter, llm.as_ref(), instruction, None).await
    }

    /// Create an autonomous agent.
    #[cfg(feature = "ai")]
    pub fn agent(
        &self,
        options: Option<crate::ai::agent::AgentOptions>,
    ) -> crate::ai::agent::Agent<'_> {
        let llm = self
            .llm_provider
            .as_ref()
            .expect("LLM not configured. Pass llm option for AI methods.");
        let adapter = self
            .adapter
            .as_ref()
            .expect("SpiderBrowser not initialized. Call init() first.");
        crate::ai::agent::Agent::new(adapter, llm.as_ref(), &self.emitter, options)
    }

    #[cfg(feature = "ai")]
    fn require_llm(&self) -> Result<&Box<dyn LLMProvider>> {
        self.llm_provider.as_ref().ok_or_else(|| {
            SpiderError::Llm(
                "LLM not configured. Pass llm option to SpiderBrowser for AI methods.".into(),
            )
        })
    }

    fn require_adapter(&self) -> Result<&ProtocolAdapter> {
        self.adapter
            .as_ref()
            .map(|a| a.as_ref())
            .ok_or_else(|| {
                SpiderError::Protocol(
                    "SpiderBrowser not initialized. Call init() first.".into(),
                )
            })
    }
}
