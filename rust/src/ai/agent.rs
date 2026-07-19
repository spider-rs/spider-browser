//! Autonomous multi-step agent and action executor.
//!
//! Ported from TypeScript `ai/agent.ts`.
//!
//! Loop: screenshot -> HTML -> LLM -> parse plan -> execute actions -> repeat.

use crate::ai::llm_provider::{LLMConfig, LLMContent, LLMMessage, LLMProvider, LLMRole};
use crate::ai::prompts::{build_system_prompt, build_user_message};
use crate::errors::{Result, SpiderError};
use crate::events::SpiderEventEmitter;
use crate::protocol::protocol_adapter::ProtocolAdapter;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};
use tracing::{info, warn};

/// Scope of an agent run.
///
/// - [`AgentScope::Browser`] — full browser control (default; identical to
///   prior behavior).
/// - [`AgentScope::Page`] — restricted to the current page/tab: the system
///   prompt gains a page-scope addendum and a best-effort guardrail script
///   blocks `window.open` / `target="_blank"` popups.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AgentScope {
    #[default]
    Browser,
    Page,
}

/// Best-effort in-page guardrail for page-scoped agents.
///
/// Idempotent: safe to evaluate repeatedly and to install as a preload
/// script. Overrides `window.open` to navigate the current tab instead of
/// opening a new one, rewrites `a[target="_blank"]` to `target="_self"`, and
/// keeps re-applying the rewrite to dynamically added links via a
/// `MutationObserver`.
///
/// NOTE: This is a best-effort guardrail, NOT a security boundary -- pages
/// can still escape it (e.g. via iframes or captured native references). It
/// only steers the agent away from multi-tab flows.
///
/// NOTE: This script is canonical across all language ports (TypeScript,
/// Rust, Python, Go) -- do not change it in one port without updating the
/// others.
pub const GUARDRAIL_JS: &str = r#"(function () {
  if (window.__spiderPageScopeGuard) return;
  window.__spiderPageScopeGuard = true;
  try {
    window.open = function (url) {
      if (url) { try { window.location.href = String(url); } catch (e) {} }
      return null;
    };
  } catch (e) {}
  var retarget = function () {
    try {
      var links = document.querySelectorAll('a[target="_blank"]');
      for (var i = 0; i < links.length; i++) { links[i].target = '_self'; }
    } catch (e) {}
  };
  retarget();
  try {
    new MutationObserver(retarget).observe(document, { childList: true, subtree: true });
  } catch (e) {}
})();"#;

// -------------------------------------------------------------------
// Action types (mirrors actions.rs AgentAction enum)
// -------------------------------------------------------------------

/// All possible agent actions.
///
/// Each variant is an externally-tagged enum so the JSON format is
/// `{ "Click": "selector" }` or `{ "ClickPoint": { "x": 100, "y": 200 } }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentAction {
    Click(String),
    ClickAll(String),
    ClickPoint { x: f64, y: f64 },
    ClickHold { selector: String, hold_ms: u64 },
    ClickHoldPoint { x: f64, y: f64, hold_ms: u64 },
    DoubleClick(String),
    DoubleClickPoint { x: f64, y: f64 },
    RightClick(String),
    RightClickPoint { x: f64, y: f64 },
    WaitForAndClick(String),
    ClickDrag {
        from: String,
        to: String,
        #[serde(default)]
        modifier: Option<u32>,
    },
    ClickDragPoint {
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        #[serde(default)]
        modifier: Option<u32>,
    },
    Type { value: String },
    Fill { selector: String, value: String },
    Clear(String),
    Press(String),
    KeyDown(String),
    KeyUp(String),
    Select { selector: String, value: String },
    Focus(String),
    Blur(String),
    Hover(String),
    HoverPoint { x: f64, y: f64 },
    ScrollY(f64),
    ScrollX(f64),
    ScrollTo { selector: String },
    ScrollToPoint { x: f64, y: f64 },
    InfiniteScroll(u32),
    Wait(u64),
    WaitFor(String),
    WaitForWithTimeout { selector: String, timeout: u64 },
    WaitForNavigation,
    WaitForDom {
        #[serde(default)]
        selector: Option<String>,
        timeout: u64,
    },
    Navigate(String),
    GoBack,
    GoForward,
    Reload,
    SetViewport {
        width: u32,
        height: u32,
        #[serde(default)]
        device_scale_factor: Option<f64>,
        #[serde(default)]
        mobile: Option<bool>,
    },
    Evaluate(String),
    Screenshot,
}

/// Parsed LLM response -- mirrors `actions.rs AgentPlan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPlan {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub steps: Option<Vec<AgentAction>>,
    #[serde(default)]
    pub extracted: Option<Value>,
    #[serde(default)]
    pub memory_ops: Option<Vec<Value>>,
}

/// Options for the autonomous agent loop.
#[derive(Debug, Clone)]
pub struct AgentOptions {
    /// Max automation rounds (default: 30).
    pub max_rounds: u32,
    /// Delay in ms after actions for page settle (default: 1500).
    pub step_delay_ms: u64,
    /// Extra context/instruction for each round.
    pub instruction: Option<String>,
    /// Scope of this agent run (default: [`AgentScope::Browser`]).
    pub scope: AgentScope,
    /// Per-run LLM override (used by `SpiderPage::agent()`; ignored by
    /// `SpiderBrowser::agent()`, which is constructed with a provider
    /// already resolved).
    pub llm: Option<LLMConfig>,
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            max_rounds: 30,
            step_delay_ms: 1500,
            instruction: None,
            scope: AgentScope::default(),
            llm: None,
        }
    }
}

/// Result of an agent execution run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResult {
    /// Whether the agent completed the task.
    pub done: bool,
    /// Number of rounds executed.
    pub rounds: u32,
    /// Extracted data (accumulated across rounds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extracted: Option<Value>,
    /// Final label from the agent.
    #[serde(default)]
    pub label: String,
}

/// Autonomous multi-step agent.
pub struct Agent<'a> {
    adapter: &'a ProtocolAdapter,
    llm: &'a dyn LLMProvider,
    emitter: &'a SpiderEventEmitter,
    max_rounds: u32,
    step_delay_ms: u64,
    scope: AgentScope,
}

impl<'a> Agent<'a> {
    pub fn new(
        adapter: &'a ProtocolAdapter,
        llm: &'a dyn LLMProvider,
        emitter: &'a SpiderEventEmitter,
        options: Option<AgentOptions>,
    ) -> Self {
        let opts = options.unwrap_or_default();
        Self {
            adapter,
            llm,
            emitter,
            max_rounds: opts.max_rounds,
            step_delay_ms: opts.step_delay_ms,
            scope: opts.scope,
        }
    }

    /// Execute the agent loop until the task is done or max rounds reached.
    pub async fn execute(&self, instruction: &str) -> AgentResult {
        let mut extracted: Option<Value> = None;
        let mut last_label = String::new();

        // Small initial delay for page to render
        sleep(Duration::from_millis(500)).await;

        let system_prompt = build_system_prompt(self.scope);

        // Page-scope guardrail: best-effort only, NOT a security boundary.
        // Apply once to the current document, then try to install it as a
        // persistent preload script (CDP Page.addScriptToEvaluateOnNewDocument)
        // so it survives same-tab navigations. If persistent install fails
        // (e.g. BiDi, which doesn't support it through our adapter), fall
        // back to re-evaluating the idempotent snippet at the start of every
        // round.
        let mut guardrail_persistent = false;
        if self.scope == AgentScope::Page {
            let _ = self.adapter.evaluate(GUARDRAIL_JS).await;
            guardrail_persistent = self
                .adapter
                .send_command(
                    "Page.addScriptToEvaluateOnNewDocument",
                    json!({ "source": GUARDRAIL_JS }),
                )
                .await
                .is_ok();
        }

        for round in 0..self.max_rounds {
            // Re-apply page-scope guardrail each round when no persistent
            // preload script could be installed (idempotent, best-effort).
            if self.scope == AgentScope::Page && !guardrail_persistent {
                let _ = self.adapter.evaluate(GUARDRAIL_JS).await;
            }
            // 1. Capture screenshot
            let screenshot = match self.adapter.capture_screenshot().await {
                Ok(s) => s,
                Err(err) => {
                    warn!(round, error = %err, "agent: screenshot failed");
                    break;
                }
            };

            // 2. Get page HTML
            let html = match self.adapter.get_html().await {
                Ok(h) => h,
                Err(err) => {
                    warn!(round, error = %err, "agent: get HTML failed");
                    break;
                }
            };

            // 3. Get URL and title
            let url = self
                .adapter
                .evaluate("window.location.href")
                .await
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "unknown".to_string());

            let title = self
                .adapter
                .evaluate("document.title")
                .await
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();

            // 4. Call LLM
            let context = format!(
                "Round {}/{}. Task: {instruction}\nPAGE TITLE: {title}",
                round + 1,
                self.max_rounds
            );

            let messages = vec![
                LLMMessage::system(system_prompt.as_ref()),
                LLMMessage {
                    role: LLMRole::User,
                    content: LLMContent::Parts(build_user_message(
                        &url,
                        &html,
                        &screenshot,
                        Some(&context),
                    )),
                },
            ];

            let plan: AgentPlan = match crate::ai::llm_provider::chat_json(self.llm, &messages).await {
                Ok(p) => p,
                Err(err) => {
                    warn!(round, error = %err, "agent: LLM call failed");
                    sleep(Duration::from_millis(2000)).await;
                    continue;
                }
            };

            last_label = plan.label.clone();
            if plan.extracted.is_some() {
                extracted = plan.extracted.clone();
            }

            let steps_count = plan.steps.as_ref().map(|s| s.len()).unwrap_or(0);

            info!(
                round = round + 1,
                label = %plan.label,
                done = plan.done,
                steps = steps_count,
                "agent: round"
            );

            self.emitter.emit(
                "agent.step",
                json!({
                    "round": round + 1,
                    "label": plan.label,
                    "stepsCount": steps_count,
                }),
            );

            // 5. Check if done
            if plan.done {
                self.emitter.emit(
                    "agent.done",
                    json!({
                        "rounds": round + 1,
                        "result": extracted,
                    }),
                );
                return AgentResult {
                    done: true,
                    rounds: round + 1,
                    extracted,
                    label: last_label,
                };
            }

            if steps_count == 0 {
                info!("agent: no steps, retrying");
                sleep(Duration::from_millis(self.step_delay_ms)).await;
                continue;
            }

            // 6. Execute each step
            if let Some(ref steps) = plan.steps {
                for (i, action) in steps.iter().enumerate() {
                    if let Err(err) = execute_action(self.adapter, action).await {
                        warn!(
                            round,
                            step = i,
                            error = %err,
                            "agent: action failed"
                        );
                        break;
                    }
                    sleep(Duration::from_millis(200)).await;
                }
            }

            // 7. Wait for page to settle
            sleep(Duration::from_millis(self.step_delay_ms)).await;
        }

        // Max rounds exceeded
        warn!("agent: max rounds exceeded");
        self.emitter.emit(
            "agent.error",
            json!({
                "error": "max rounds exceeded",
                "round": self.max_rounds,
            }),
        );

        AgentResult {
            done: false,
            rounds: self.max_rounds,
            extracted,
            label: last_label,
        }
    }
}

// -------------------------------------------------------------------
// Action executor -- mirrors agent.rs execute_action()
// -------------------------------------------------------------------

/// Execute a single agent action via the protocol adapter.
///
/// Handles all action types from the [`AgentAction`] enum.
pub async fn execute_action(adapter: &ProtocolAdapter, action: &AgentAction) -> Result<()> {
    match action {
        // ----- Click actions -----
        AgentAction::Click(selector) => {
            let (x, y) = get_element_center(adapter, selector).await?;
            adapter.click_point(x, y).await
        }
        AgentAction::ClickAll(selector) => {
            let js = format!(
                r#"(function() {{
                    var els = document.querySelectorAll({sel});
                    return Array.from(els).map(function(el) {{
                        var r = el.getBoundingClientRect();
                        return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
                    }});
                }})()"#,
                sel = serde_json::to_string(selector).unwrap_or_default()
            );
            let val = adapter.evaluate(&js).await?;
            if let Some(points) = val.as_array() {
                for pt in points {
                    let x = pt.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let y = pt.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    adapter.click_point(x, y).await?;
                    sleep(Duration::from_millis(100)).await;
                }
            }
            Ok(())
        }
        AgentAction::ClickPoint { x, y } => adapter.click_point(*x, *y).await,
        AgentAction::ClickHold { selector, hold_ms } => {
            let (x, y) = get_element_center(adapter, selector).await?;
            adapter.click_hold_point(x, y, *hold_ms).await
        }
        AgentAction::ClickHoldPoint { x, y, hold_ms } => {
            adapter.click_hold_point(*x, *y, *hold_ms).await
        }
        AgentAction::DoubleClick(selector) => {
            let (x, y) = get_element_center(adapter, selector).await?;
            adapter.double_click_point(x, y).await
        }
        AgentAction::DoubleClickPoint { x, y } => adapter.double_click_point(*x, *y).await,
        AgentAction::RightClick(selector) => {
            let (x, y) = get_element_center(adapter, selector).await?;
            adapter.right_click_point(x, y).await
        }
        AgentAction::RightClickPoint { x, y } => adapter.right_click_point(*x, *y).await,
        AgentAction::WaitForAndClick(selector) => {
            wait_for_element(adapter, selector, 5000).await?;
            let (x, y) = get_element_center(adapter, selector).await?;
            adapter.click_point(x, y).await
        }

        // ----- Drag actions -----
        AgentAction::ClickDrag { from, to, .. } => {
            let (fx, fy) = get_element_center(adapter, from).await?;
            let (tx, ty) = get_element_center(adapter, to).await?;
            adapter.drag_point(fx, fy, tx, ty).await
        }
        AgentAction::ClickDragPoint {
            from_x,
            from_y,
            to_x,
            to_y,
            ..
        } => adapter.drag_point(*from_x, *from_y, *to_x, *to_y).await,

        // ----- Input actions -----
        AgentAction::Type { value } => adapter.insert_text(value).await,
        AgentAction::Fill { selector, value } => {
            // Clear via JS
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            let clear_js = format!(
                r#"(function() {{
                    var el = document.querySelector({sel_json});
                    if (el) {{ el.focus(); el.value = ''; }}
                }})()"#
            );
            adapter.evaluate(&clear_js).await?;

            // Click for real focus
            if let Ok((x, y)) = get_element_center(adapter, selector).await {
                let _ = adapter.click_point(x, y).await;
            }

            // Insert text
            adapter.insert_text(value).await?;

            // Dispatch events
            let event_js = format!(
                r#"(function() {{
                    var el = document.querySelector({sel_json});
                    if (el) {{
                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}
                }})()"#
            );
            adapter.evaluate(&event_js).await?;
            Ok(())
        }
        AgentAction::Clear(selector) => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            let js = format!("document.querySelector({sel_json}).value = ''");
            adapter.evaluate(&js).await?;
            Ok(())
        }
        AgentAction::Press(key) => adapter.press_key(key).await,
        AgentAction::KeyDown(key) => adapter.key_down(key).await,
        AgentAction::KeyUp(key) => adapter.key_up(key).await,

        // ----- Select & Focus -----
        AgentAction::Select { selector, value } => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            let val_json = serde_json::to_string(value).unwrap_or_default();
            let js = format!(
                r#"(function() {{
                    var el = document.querySelector({sel_json});
                    if (el) {{
                        el.value = {val_json};
                        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}
                }})()"#
            );
            adapter.evaluate(&js).await?;
            Ok(())
        }
        AgentAction::Focus(selector) => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            adapter
                .evaluate(&format!(
                    "document.querySelector({sel_json})?.focus()"
                ))
                .await?;
            Ok(())
        }
        AgentAction::Blur(selector) => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            adapter
                .evaluate(&format!(
                    "document.querySelector({sel_json})?.blur()"
                ))
                .await?;
            Ok(())
        }
        AgentAction::Hover(selector) => {
            let (x, y) = get_element_center(adapter, selector).await?;
            adapter.hover_point(x, y).await
        }
        AgentAction::HoverPoint { x, y } => adapter.hover_point(*x, *y).await,

        // ----- Scroll actions -----
        AgentAction::ScrollY(delta) => {
            adapter
                .evaluate(&format!("window.scrollBy(0, {delta})"))
                .await?;
            Ok(())
        }
        AgentAction::ScrollX(delta) => {
            adapter
                .evaluate(&format!("window.scrollBy({delta}, 0)"))
                .await?;
            Ok(())
        }
        AgentAction::ScrollTo { selector } => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            adapter
                .evaluate(&format!(
                    "document.querySelector({sel_json})?.scrollIntoView({{ behavior: 'smooth', block: 'center' }})"
                ))
                .await?;
            Ok(())
        }
        AgentAction::ScrollToPoint { x, y } => {
            adapter
                .evaluate(&format!("window.scrollTo({x}, {y})"))
                .await?;
            Ok(())
        }
        AgentAction::InfiniteScroll(max) => {
            for _ in 0..*max {
                adapter
                    .evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    .await?;
                sleep(Duration::from_millis(500)).await;
            }
            Ok(())
        }

        // ----- Wait actions -----
        AgentAction::Wait(ms) => {
            sleep(Duration::from_millis(*ms)).await;
            Ok(())
        }
        AgentAction::WaitFor(selector) => wait_for_element(adapter, selector, 5000).await,
        AgentAction::WaitForWithTimeout { selector, timeout } => {
            wait_for_element(adapter, selector, *timeout).await
        }
        AgentAction::WaitForNavigation => {
            sleep(Duration::from_millis(1000)).await;
            Ok(())
        }
        AgentAction::WaitForDom { timeout, .. } => {
            sleep(Duration::from_millis(*timeout)).await;
            Ok(())
        }

        // ----- Navigation actions -----
        AgentAction::Navigate(url) => adapter.navigate(url).await,
        AgentAction::GoBack => {
            adapter.evaluate("window.history.back()").await?;
            Ok(())
        }
        AgentAction::GoForward => {
            adapter.evaluate("window.history.forward()").await?;
            Ok(())
        }
        AgentAction::Reload => {
            adapter.evaluate("window.location.reload()").await?;
            Ok(())
        }

        // ----- Viewport -----
        AgentAction::SetViewport {
            width,
            height,
            device_scale_factor,
            mobile,
        } => {
            adapter
                .set_viewport(
                    *width,
                    *height,
                    device_scale_factor.unwrap_or(2.0),
                    mobile.unwrap_or(false),
                )
                .await
        }

        // ----- JavaScript -----
        AgentAction::Evaluate(code) => {
            adapter.evaluate(code).await?;
            Ok(())
        }

        // ----- Screenshot (no-op in client -- handled by agent loop) -----
        AgentAction::Screenshot => Ok(()),
    }
}

// -------------------------------------------------------------------
// Helpers (mirrors agent.rs get_element_center / wait_for_element)
// -------------------------------------------------------------------

/// Get the center point of a DOM element, scrolling it into view first.
async fn get_element_center(adapter: &ProtocolAdapter, selector: &str) -> Result<(f64, f64)> {
    let sel_json = serde_json::to_string(selector).unwrap_or_default();
    let js = format!(
        r#"(function() {{
            var el = document.querySelector({sel_json});
            if (!el) return null;
            el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
            var r = el.getBoundingClientRect();
            return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
        }})()"#
    );

    let result = adapter.evaluate(&js).await?;
    if result.is_null() {
        return Err(SpiderError::Other(format!(
            "Element not found: {selector}"
        )));
    }

    let x = result
        .get("x")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| SpiderError::Other(format!("Missing x for element: {selector}")))?;
    let y = result
        .get("y")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| SpiderError::Other(format!("Missing y for element: {selector}")))?;

    Ok((x, y))
}

/// Poll for a DOM element until it appears or timeout expires.
async fn wait_for_element(adapter: &ProtocolAdapter, selector: &str, timeout_ms: u64) -> Result<()> {
    let interval = 100u64;
    let max_iter = (timeout_ms + interval - 1) / interval;
    let sel_json = serde_json::to_string(selector).unwrap_or_default();
    let check_js = format!("!!document.querySelector({sel_json})");

    for _ in 0..max_iter {
        let found = adapter.evaluate(&check_js).await?;
        if found.as_bool().unwrap_or(false) {
            return Ok(());
        }
        sleep(Duration::from_millis(interval)).await;
    }

    Err(SpiderError::Timeout(format!(
        "Timeout waiting for element: {selector}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_scope_default_is_browser() {
        assert_eq!(AgentScope::default(), AgentScope::Browser);
    }

    #[test]
    fn agent_options_default_scope_is_browser() {
        assert_eq!(AgentOptions::default().scope, AgentScope::Browser);
    }

    #[test]
    fn guardrail_js_is_idempotent_guarded() {
        assert!(GUARDRAIL_JS.contains("__spiderPageScopeGuard"));
        assert!(GUARDRAIL_JS.contains("window.open"));
        assert!(GUARDRAIL_JS.contains("target=\"_blank\""));
    }
}
