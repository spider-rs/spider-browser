//! Observe interactive elements on the page.
//!
//! Ported from TypeScript `ai/observe.ts`.

use crate::ai::llm_provider::{LLMMessage, LLMProvider};
use crate::errors::Result;
use crate::protocol::protocol_adapter::ProtocolAdapter;
use serde::{Deserialize, Serialize};

/// An observed interactive element on the page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserveResult {
    /// CSS selector that can target this element.
    pub selector: String,
    /// HTML tag name.
    pub tag: String,
    /// Input type (for input elements).
    #[serde(rename = "type", default)]
    pub type_: String,
    /// Visible text content (truncated).
    #[serde(default)]
    pub text: String,
    /// aria-label attribute.
    #[serde(rename = "ariaLabel", default)]
    pub aria_label: String,
    /// Placeholder text.
    #[serde(default)]
    pub placeholder: String,
    /// href attribute (for links).
    #[serde(default)]
    pub href: String,
    /// Current input value (for inputs/textareas).
    #[serde(default)]
    pub value: String,
    /// Bounding rectangle in viewport coordinates.
    pub rect: ElementRect,
    /// Relevance score (0-1) when LLM ranking is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

/// Bounding rectangle for an element.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// JavaScript snippet that collects all interactive elements on the page
/// with selectors, text, and bounding rects.
///
/// Ported from TypeScript `utils/dom.ts` GET_INTERACTIVE_ELEMENTS.
pub const GET_INTERACTIVE_ELEMENTS: &str = r#"
(function() {
  var interactiveSelectors = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[onclick]',
    '[tabindex]',
    'summary',
    'details',
    'label'
  ];
  var seen = new Set();
  var results = [];
  for (var s = 0; s < interactiveSelectors.length; s++) {
    var sel = interactiveSelectors[s];
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (seen.has(el)) continue;
      seen.add(el);
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < 0 || r.right < 0) continue;

      var tag = el.tagName.toLowerCase();
      var type = el.getAttribute('type') || '';
      var text = (el.textContent || '').trim().slice(0, 100);
      var ariaLabel = el.getAttribute('aria-label') || '';
      var placeholder = el.getAttribute('placeholder') || '';
      var href = el.getAttribute('href') || '';
      var value = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? el.value.slice(0, 50) : '';

      var cssSelector = tag;
      var id = el.getAttribute('id');
      if (id) {
        cssSelector = '#' + CSS.escape(id);
      } else {
        var cls = el.getAttribute('class');
        if (cls) {
          var classes = cls.trim().split(/\s+/).slice(0, 2);
          cssSelector = tag + classes.map(function(c) { return '.' + CSS.escape(c); }).join('');
        }
        var name = el.getAttribute('name');
        if (name) {
          cssSelector = tag + '[name="' + CSS.escape(name) + '"]';
        }
      }

      results.push({
        selector: cssSelector,
        tag: tag,
        type: type,
        text: text,
        ariaLabel: ariaLabel,
        placeholder: placeholder,
        href: href,
        value: value,
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      });
    }
  }
  return results;
})()
"#;

/// Discover interactive elements on the page.
///
/// Works WITHOUT an LLM -- injects a DOM traversal script to collect
/// interactive elements (buttons, links, inputs) with selectors, text,
/// and bounding rects.
///
/// When `instruction` is provided + LLM is available, adds ranking/filtering.
pub async fn observe(
    adapter: &ProtocolAdapter,
    instruction: Option<&str>,
    llm: Option<&dyn LLMProvider>,
) -> Result<Vec<ObserveResult>> {
    // Collect all interactive elements via DOM traversal
    let raw = adapter.evaluate(GET_INTERACTIVE_ELEMENTS).await?;
    let elements: Vec<ObserveResult> = serde_json::from_value(raw).unwrap_or_default();

    if elements.is_empty() {
        return Ok(vec![]);
    }

    // If no instruction or no LLM, return all elements
    let (instruction, llm) = match (instruction, llm) {
        (Some(inst), Some(provider)) => (inst, provider),
        _ => return Ok(elements),
    };

    // Use LLM to rank/filter elements by relevance to the instruction
    let element_summary: String = elements
        .iter()
        .enumerate()
        .map(|(i, el)| {
            let mut parts = vec![format!("[{i}] <{}>", el.tag)];
            if !el.text.is_empty() {
                parts.push(format!("text=\"{}\"", el.text));
            }
            if !el.aria_label.is_empty() {
                parts.push(format!("aria=\"{}\"", el.aria_label));
            }
            if !el.placeholder.is_empty() {
                parts.push(format!("placeholder=\"{}\"", el.placeholder));
            }
            if !el.href.is_empty() {
                parts.push(format!("href=\"{}\"", el.href));
            }
            if !el.type_.is_empty() {
                parts.push(format!("type=\"{}\"", el.type_));
            }
            parts.join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n");

    #[derive(Deserialize)]
    struct RankResponse {
        #[serde(default)]
        indices: Vec<usize>,
    }

    let messages = vec![
        LLMMessage::system(
            "You are an element selector. Given a list of page elements and an instruction, \
             return a JSON object with an \"indices\" array of element indices that match the \
             instruction. Order by relevance (most relevant first). Return {\"indices\": []} \
             if none match.",
        ),
        LLMMessage::user(format!(
            "Instruction: {instruction}\n\nElements:\n{element_summary}"
        )),
    ];

    let response: RankResponse = crate::ai::llm_provider::chat_json(llm, &messages).await?;

    let valid_indices: Vec<usize> = response
        .indices
        .into_iter()
        .filter(|&i| i < elements.len())
        .collect();

    let total = valid_indices.len().max(1) as f64;
    let results = valid_indices
        .into_iter()
        .enumerate()
        .map(|(rank, idx)| {
            let mut el = elements[idx].clone();
            el.score = Some(1.0 - rank as f64 / total);
            el
        })
        .collect();

    Ok(results)
}
