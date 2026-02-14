//! Spider Browser — Rust client for Spider's pre-warmed browser fleet.
//!
//! Connects to Spider's browser fleet via WebSocket. Supports CDP
//! (Chrome/Servo/LightPanda) and BiDi (Firefox) protocols with smart
//! retry, browser rotation, and stealth escalation.

pub mod errors;
pub mod events;
pub mod page;
pub mod protocol;
pub mod retry;
pub mod spider_browser;

#[cfg(feature = "ai")]
pub mod ai;

pub use errors::{Result, SpiderError};
pub use events::SpiderEventEmitter;
pub use page::SpiderPage;
pub use spider_browser::{SpiderBrowser, SpiderBrowserOptions};
