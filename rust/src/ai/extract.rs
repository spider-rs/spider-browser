//! Extract structured data from the page using an LLM.
//!
//! Ported from TypeScript `ai/extract.ts`.

use crate::ai::llm_provider::{ImageUrlValue, LLMContent, LLMContentPart, LLMMessage, LLMProvider};
use crate::ai::prompts::truncate_html;
use crate::errors::Result;
use crate::protocol::protocol_adapter::ProtocolAdapter;
use serde::de::DeserializeOwned;

/// Extract structured data from the page.
///
/// Takes a screenshot + HTML, sends to LLM with the instruction and optional
/// schema hint string, returns parsed data of type `T`.
///
/// # Arguments
/// * `adapter` - Protocol adapter for page interaction
/// * `llm` - LLM provider for data extraction
/// * `instruction` - What data to extract
/// * `schema_hint` - Optional JSON schema description to guide the LLM
///
/// # Example
/// ```ignore
/// #[derive(Deserialize)]
/// struct Price { amount: f64, currency: String }
///
/// let price: Price = extract(&adapter, &*llm, "Extract the product price", None).await?;
/// ```
pub async fn extract<T: DeserializeOwned + Send>(
    adapter: &ProtocolAdapter,
    llm: &dyn LLMProvider,
    instruction: &str,
    schema_hint: Option<&str>,
) -> Result<T> {
    // Capture page state
    let (screenshot, html, url, title) = tokio::try_join!(
        adapter.capture_screenshot(),
        adapter.get_html(),
        async {
            adapter
                .evaluate("window.location.href")
                .await
                .map(|v| v.as_str().unwrap_or("unknown").to_string())
        },
        async {
            adapter
                .evaluate("document.title")
                .await
                .map(|v| v.as_str().unwrap_or("").to_string())
        },
    )?;

    let truncated_html = truncate_html(&html, 12_000);

    // Build schema description if provided
    let schema_desc = match schema_hint {
        Some(hint) => format!("\n\nReturn data matching this JSON schema:\n{hint}"),
        None => String::new(),
    };

    let system_prompt = format!(
        "You are a data extraction agent. Given a webpage screenshot and HTML, \
         extract the requested information as JSON.{schema_desc}\n\n\
         Return ONLY a valid JSON object. No prose, no markdown."
    );

    let user_text = format!(
        "URL: {url}\nTitle: {title}\nInstruction: {instruction}\n\nHTML (truncated):\n{truncated_html}"
    );

    let messages = vec![
        LLMMessage::system(system_prompt),
        LLMMessage {
            role: crate::ai::llm_provider::LLMRole::User,
            content: LLMContent::Parts(vec![
                LLMContentPart::Text { text: user_text },
                LLMContentPart::ImageUrl {
                    image_url: ImageUrlValue {
                        url: format!("data:image/png;base64,{screenshot}"),
                    },
                },
            ]),
        },
    ];

    crate::ai::llm_provider::chat_json(llm, &messages).await
}
