//! Lock-free event emitter for SpiderBrowser events.

use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;

/// Callback type for event handlers.
pub type EventHandler = Arc<dyn Fn(Value) + Send + Sync>;

/// Browser type identifier.
pub type BrowserType = String;

/// Common browser type constants.
pub mod browsers {
    pub const AUTO: &str = "auto";
    pub const CHROME: &str = "chrome";
    pub const CHROME_NEW: &str = "chrome-new";
    pub const CHROME_H: &str = "chrome-h";
    pub const FIREFOX: &str = "firefox";
    pub const SERVO: &str = "servo";
    pub const LIGHTPANDA: &str = "lightpanda";
    /// Spider's custom Rust-based browser, optimized for fast scraping.
    pub const NAVI: &str = "navi";
}

/// Lock-free event emitter using DashMap for concurrent handler access.
#[derive(Clone, Default)]
pub struct SpiderEventEmitter {
    handlers: Arc<DashMap<String, Vec<EventHandler>>>,
}

impl SpiderEventEmitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on(&self, event: &str, handler: EventHandler) {
        self.handlers
            .entry(event.to_string())
            .or_default()
            .push(handler);
    }

    pub fn off(&self, event: &str) {
        self.handlers.remove(event);
    }

    pub fn emit(&self, event: &str, data: Value) {
        if let Some(list) = self.handlers.get(event) {
            // Clone the vec to release the DashMap shard lock before invoking callbacks.
            let handlers = list.clone();
            drop(list);
            for handler in &handlers {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handler(data.clone());
                }));
            }
        }
    }

    pub fn remove_all_listeners(&self) {
        self.handlers.clear();
    }
}
