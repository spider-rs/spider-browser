//! Anthropic native API provider.
//!
//! Converts OpenAI-style messages to Anthropic's format.
//!
//! Ported from TypeScript `ai/providers/anthropic.ts`.

use crate::ai::llm_provider::{
    ChatOptions, LLMConfig, LLMContent, LLMContentPart, LLMMessage, LLMProvider, LLMRole,
};
use crate::errors::{Result, SpiderError};
use reqwest::Client;
use serde_json::{json, Value};

/// Anthropic native API provider.
pub struct AnthropicProvider {
    url: String,
    api_key: String,
    model: String,
    max_tokens: u32,
    temperature: f64,
    client: Client,
}

impl AnthropicProvider {
    pub fn new(config: LLMConfig) -> Self {
        Self {
            url: config
                .base_url
                .unwrap_or_else(|| "https://api.anthropic.com/v1/messages".to_string()),
            api_key: config.api_key,
            model: config.model,
            max_tokens: config.max_tokens.unwrap_or(4096),
            temperature: config.temperature.unwrap_or(0.1),
            client: Client::new(),
        }
    }

    /// Convert content parts to Anthropic format.
    fn convert_parts(parts: &[LLMContentPart]) -> Vec<Value> {
        parts
            .iter()
            .map(|part| match part {
                LLMContentPart::Text { text } => json!({
                    "type": "text",
                    "text": text,
                }),
                LLMContentPart::ImageUrl { image_url } => {
                    let data_url = &image_url.url;
                    // Try to parse data URI: data:<media_type>;base64,<data>
                    if let Some(rest) = data_url.strip_prefix("data:") {
                        if let Some(semi_pos) = rest.find(';') {
                            let media_type = &rest[..semi_pos];
                            if let Some(data) = rest[semi_pos..].strip_prefix(";base64,") {
                                return json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": data,
                                    }
                                });
                            }
                        }
                    }
                    // URL-based image fallback
                    json!({
                        "type": "image",
                        "source": {
                            "type": "url",
                            "url": data_url,
                        }
                    })
                }
            })
            .collect()
    }

    /// Extract system message text from the message list.
    fn extract_system(messages: &[LLMMessage]) -> Option<String> {
        messages.iter().find_map(|m| {
            if m.role != LLMRole::System {
                return None;
            }
            Some(match &m.content {
                LLMContent::Text(text) => text.clone(),
                LLMContent::Parts(parts) => parts
                    .iter()
                    .filter_map(|p| match p {
                        LLMContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            })
        })
    }

    /// Convert non-system messages to Anthropic format.
    fn format_messages(messages: &[LLMMessage]) -> Vec<Value> {
        messages
            .iter()
            .filter(|m| m.role != LLMRole::System)
            .map(|msg| {
                let role = match msg.role {
                    LLMRole::User => "user",
                    LLMRole::Assistant => "assistant",
                    LLMRole::System => unreachable!(),
                };
                match &msg.content {
                    LLMContent::Text(text) => json!({
                        "role": role,
                        "content": text,
                    }),
                    LLMContent::Parts(parts) => json!({
                        "role": role,
                        "content": Self::convert_parts(parts),
                    }),
                }
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl LLMProvider for AnthropicProvider {
    async fn chat(&self, messages: &[LLMMessage], _options: Option<ChatOptions>) -> Result<String> {
        let mut body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "messages": Self::format_messages(messages),
        });

        if let Some(system) = Self::extract_system(messages) {
            body.as_object_mut()
                .unwrap()
                .insert("system".to_string(), json!(system));
        }

        let resp = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| SpiderError::Llm(format!("Anthropic request failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SpiderError::Llm(format!(
                "Anthropic API error {status}: {text}"
            )));
        }

        let json: Value = resp
            .json()
            .await
            .map_err(|e| SpiderError::Llm(format!("Anthropic response parse error: {e}")))?;

        let content = json
            .pointer("/content/0/text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                SpiderError::Llm("Anthropic response missing content[0].text".into())
            })?;

        Ok(content.to_string())
    }
}
