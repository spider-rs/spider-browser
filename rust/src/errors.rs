//! Error hierarchy for spider-browser.

use thiserror::Error;

/// Base error for all spider-browser errors.
#[derive(Error, Debug)]
pub enum SpiderError {
    #[error("Connection error: {message}")]
    Connection {
        message: String,
        ws_code: Option<u16>,
    },

    #[error("Authentication failed: {0}")]
    Auth(String),

    #[error("Rate limited: {message}")]
    RateLimit {
        message: String,
        retry_after_ms: Option<u64>,
    },

    #[error("Blocked: {0}")]
    Blocked(String),

    #[error("Backend unavailable: {0}")]
    BackendUnavailable(String),

    #[error("Navigation failed: {0}")]
    Navigation(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("Protocol error: {0}")]
    Protocol(String),

    #[error("LLM error: {0}")]
    Llm(String),

    #[error("{0}")]
    Other(String),
}

impl SpiderError {
    pub fn is_retryable(&self) -> bool {
        !matches!(self, SpiderError::Auth(_) | SpiderError::Protocol(_))
    }

    pub fn connection(msg: impl Into<String>) -> Self {
        SpiderError::Connection {
            message: msg.into(),
            ws_code: None,
        }
    }

    pub fn connection_with_code(msg: impl Into<String>, code: u16) -> Self {
        SpiderError::Connection {
            message: msg.into(),
            ws_code: Some(code),
        }
    }

    pub fn rate_limit(msg: impl Into<String>) -> Self {
        SpiderError::RateLimit {
            message: msg.into(),
            retry_after_ms: None,
        }
    }

    pub fn rate_limit_with_retry(msg: impl Into<String>, retry_ms: u64) -> Self {
        SpiderError::RateLimit {
            message: msg.into(),
            retry_after_ms: Some(retry_ms),
        }
    }
}

pub type Result<T> = std::result::Result<T, SpiderError>;
