//! LLM provider abstraction for AI methods.
//!
//! Ported from TypeScript `ai/llm-provider.ts`.

use crate::errors::{Result, SpiderError};
use serde::{Deserialize, Serialize};

/// Supported LLM provider backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LLMProviderKind {
    OpenAI,
    Anthropic,
    OpenRouter,
}

/// LLM configuration for AI methods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMConfig {
    /// Provider: OpenAI, Anthropic, or OpenRouter.
    pub provider: LLMProviderKind,
    /// Model name (e.g. "gpt-4o", "claude-sonnet-4-5-20250929").
    pub model: String,
    /// API key for the provider.
    pub api_key: String,
    /// Base URL override (e.g. for OpenRouter or local vLLM).
    #[serde(default)]
    pub base_url: Option<String>,
    /// Max tokens (default: 4096).
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Temperature (default: 0.1).
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// Role in a conversation message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LLMRole {
    System,
    User,
    Assistant,
}

/// A content part within a message (text or image).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LLMContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlValue },
}

/// URL value for an image content part.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrlValue {
    pub url: String,
}

/// Message content: either a plain string or structured parts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LLMContent {
    Text(String),
    Parts(Vec<LLMContentPart>),
}

/// Message format for LLM calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMMessage {
    pub role: LLMRole,
    pub content: LLMContent,
}

impl LLMMessage {
    /// Create a system message with plain text content.
    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: LLMRole::System,
            content: LLMContent::Text(text.into()),
        }
    }

    /// Create a user message with plain text content.
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: LLMRole::User,
            content: LLMContent::Text(text.into()),
        }
    }

    /// Create a user message with structured content parts.
    pub fn user_parts(parts: Vec<LLMContentPart>) -> Self {
        Self {
            role: LLMRole::User,
            content: LLMContent::Parts(parts),
        }
    }

    /// Create an assistant message with plain text content.
    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: LLMRole::Assistant,
            content: LLMContent::Text(text.into()),
        }
    }
}

/// Options for chat calls.
#[derive(Debug, Clone, Default)]
pub struct ChatOptions {
    /// When true, request JSON-formatted output from the model.
    pub json_mode: bool,
}

/// Pluggable LLM provider interface.
///
/// All methods are async and return `Result<_>` via [`SpiderError::Llm`].
#[async_trait::async_trait]
pub trait LLMProvider: Send + Sync {
    /// Call the LLM with messages and get a text response.
    async fn chat(&self, messages: &[LLMMessage], options: Option<ChatOptions>) -> Result<String>;
}

/// Call the LLM with messages and get a parsed JSON response.
///
/// This is a standalone function (not a trait method) so that `LLMProvider`
/// remains dyn-compatible (no generic methods on the trait).
pub async fn chat_json<T: serde::de::DeserializeOwned>(
    llm: &dyn LLMProvider,
    messages: &[LLMMessage],
) -> Result<T> {
    let text = llm
        .chat(messages, Some(ChatOptions { json_mode: true }))
        .await?;
    parse_json_response(&text)
}

/// Parse a JSON response, handling markdown code fences.
pub fn parse_json_response<T: serde::de::DeserializeOwned>(text: &str) -> Result<T> {
    // Try direct parse first
    if let Ok(val) = serde_json::from_str::<T>(text) {
        return Ok(val);
    }
    // Try extracting JSON from markdown code blocks
    if let Some(start) = text.find("```") {
        let after_fence = &text[start + 3..];
        // Skip optional language tag (e.g. "json")
        let json_start = after_fence
            .find('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        if let Some(end) = after_fence[json_start..].find("```") {
            let json_str = &after_fence[json_start..json_start + end];
            if let Ok(val) = serde_json::from_str::<T>(json_str.trim()) {
                return Ok(val);
            }
        }
    }
    Err(SpiderError::Llm(format!(
        "LLM response is not valid JSON: {}",
        &text[..text.len().min(200)]
    )))
}

/// Create an LLM provider from config.
pub fn create_provider(config: LLMConfig) -> Box<dyn LLMProvider> {
    match config.provider {
        LLMProviderKind::OpenAI | LLMProviderKind::OpenRouter => {
            Box::new(crate::ai::providers::openai::OpenAICompatibleProvider::new(config))
        }
        LLMProviderKind::Anthropic => {
            Box::new(crate::ai::providers::anthropic::AnthropicProvider::new(config))
        }
    }
}
