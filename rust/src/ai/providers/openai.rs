//! OpenAI-compatible LLM provider.
//!
//! Works with OpenAI, OpenRouter, Qwen/vLLM, or any `/v1/chat/completions` endpoint.
//!
//! Ported from TypeScript `ai/providers/openai.ts`.

use crate::ai::llm_provider::{
    ChatOptions, LLMConfig, LLMContent, LLMContentPart, LLMMessage, LLMProvider, LLMProviderKind,
    LLMRole,
};
use crate::errors::{Result, SpiderError};
use reqwest::Client;
use serde_json::{json, Value};

/// OpenAI-compatible LLM provider.
pub struct OpenAICompatibleProvider {
    url: String,
    api_key: String,
    model: String,
    max_tokens: u32,
    temperature: f64,
    client: Client,
}

impl OpenAICompatibleProvider {
    pub fn new(config: LLMConfig) -> Self {
        let default_url = match config.provider {
            LLMProviderKind::OpenRouter => "https://openrouter.ai/api/v1/chat/completions",
            _ => "https://api.openai.com/v1/chat/completions",
        };
        Self {
            url: config.base_url.unwrap_or_else(|| default_url.to_string()),
            api_key: config.api_key,
            model: config.model,
            max_tokens: config.max_tokens.unwrap_or(4096),
            temperature: config.temperature.unwrap_or(0.1),
            client: Client::new(),
        }
    }

    /// Convert our LLMMessage to the OpenAI JSON format.
    fn format_messages(messages: &[LLMMessage]) -> Vec<Value> {
        messages
            .iter()
            .map(|msg| {
                let role = match msg.role {
                    LLMRole::System => "system",
                    LLMRole::User => "user",
                    LLMRole::Assistant => "assistant",
                };
                match &msg.content {
                    LLMContent::Text(text) => json!({
                        "role": role,
                        "content": text,
                    }),
                    LLMContent::Parts(parts) => {
                        let content_parts: Vec<Value> = parts
                            .iter()
                            .map(|part| match part {
                                LLMContentPart::Text { text } => json!({
                                    "type": "text",
                                    "text": text,
                                }),
                                LLMContentPart::ImageUrl { image_url } => json!({
                                    "type": "image_url",
                                    "image_url": { "url": image_url.url },
                                }),
                            })
                            .collect();
                        json!({
                            "role": role,
                            "content": content_parts,
                        })
                    }
                }
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl LLMProvider for OpenAICompatibleProvider {
    async fn chat(&self, messages: &[LLMMessage], options: Option<ChatOptions>) -> Result<String> {
        let mut body = json!({
            "model": self.model,
            "messages": Self::format_messages(messages),
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        });

        if let Some(opts) = &options {
            if opts.json_mode {
                body.as_object_mut().unwrap().insert(
                    "response_format".to_string(),
                    json!({ "type": "json_object" }),
                );
            }
        }

        let resp = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| SpiderError::Llm(format!("OpenAI request failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SpiderError::Llm(format!(
                "OpenAI API error {status}: {text}"
            )));
        }

        let json: Value = resp
            .json()
            .await
            .map_err(|e| SpiderError::Llm(format!("OpenAI response parse error: {e}")))?;

        let content = json
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                SpiderError::Llm("OpenAI response missing choices[0].message.content".into())
            })?;

        Ok(content.to_string())
    }
}
