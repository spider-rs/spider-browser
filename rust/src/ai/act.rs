//! Single-shot action execution from natural language.
//!
//! Ported from TypeScript `ai/act.ts`.

use crate::ai::agent::{execute_action, AgentPlan};
use crate::ai::llm_provider::{LLMContent, LLMMessage, LLMProvider};
use crate::ai::prompts::{build_user_message, SYSTEM_PROMPT};
use crate::errors::Result;
use crate::protocol::protocol_adapter::ProtocolAdapter;
use tokio::time::{sleep, Duration};

/// Execute a single action from natural language.
///
/// Takes a screenshot + HTML, sends to LLM with the instruction,
/// then executes the returned action steps.
///
/// # Example
/// ```ignore
/// act(&adapter, &*llm, "Click the login button").await?;
/// ```
pub async fn act(
    adapter: &ProtocolAdapter,
    llm: &dyn LLMProvider,
    instruction: &str,
) -> Result<()> {
    // Capture current page state
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

    let context = format!("Task: {instruction}\nPAGE TITLE: {title}");

    // Call LLM
    let messages = vec![
        LLMMessage::system(SYSTEM_PROMPT),
        LLMMessage {
            role: crate::ai::llm_provider::LLMRole::User,
            content: LLMContent::Parts(build_user_message(&url, &html, &screenshot, Some(&context))),
        },
    ];

    let plan: AgentPlan = crate::ai::llm_provider::chat_json(llm, &messages).await?;

    // Execute steps
    if let Some(steps) = &plan.steps {
        for step in steps {
            execute_action(adapter, step).await?;
            sleep(Duration::from_millis(200)).await;
        }
    }

    Ok(())
}
