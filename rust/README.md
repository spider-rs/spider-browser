# spider-browser

Rust client for [Spider's](https://spider.cloud) Rust-powered browser cloud. Pre-warmed browsers, automatic stealth, smart retry, and AI automation.

## Install

```toml
[dependencies]
spider-browser = "0.1"
```

The AI module (act, observe, extract, agent) is enabled by default via the `ai` feature. Disable it with `default-features = false` if you only need browser automation.

## Quick Start

```rust
use spider_browser::{SpiderBrowser, SpiderBrowserOptions};

let browser = SpiderBrowser::new(SpiderBrowserOptions {
    api_key: "sk-xxx".into(),
    ..Default::default()
});
browser.init().await?;

browser.page().goto("https://example.com").await?;
let html = browser.page().content().await?;
let screenshot = browser.page().screenshot().await?;

browser.close().await?;
```

## Page API

```rust
// Navigation
browser.page().goto("https://example.com").await?;
browser.page().goto_fast("https://example.com").await?;  // 5s max wait
browser.page().goto_dom("https://example.com").await?;    // DOMContentLoaded
browser.page().go_back().await?;
browser.page().reload().await?;

// Content
let html = browser.page().content().await?;          // smart waiting
let raw = browser.page().raw_content().await?;       // immediate
let title = browser.page().title().await?;
let url = browser.page().url().await?;
let png_b64 = browser.page().screenshot().await?;
let result = browser.page().evaluate("document.title").await?;

// Interaction
browser.page().click("button.submit").await?;
browser.page().click_at(100.0, 200.0).await?;
browser.page().fill("input[name=q]", "query").await?;
browser.page().type_text("hello").await?;
browser.page().press("Enter").await?;
browser.page().select("select#country", "US").await?;
browser.page().hover("a.link").await?;
browser.page().drag("div.source", "div.target").await?;

// Scroll
browser.page().scroll_y(500).await?;
browser.page().scroll_to("footer").await?;

// Wait
browser.page().wait_for_selector("div.loaded", None).await?;
browser.page().wait_for_network_idle(None).await?;

// Viewport
browser.page().set_viewport(1920, 1080, None, None).await?;
```

## AI Automation

Control the browser with natural language. Supports OpenAI, Anthropic, OpenRouter, and any OpenAI-compatible endpoint.

```rust
use spider_browser::ai::llm_provider::LLMConfig;

let browser = SpiderBrowser::new(SpiderBrowserOptions {
    api_key: "sk-xxx".into(),
    llm: Some(LLMConfig {
        provider: LLMProviderKind::OpenAI,
        model: "gpt-4o".into(),
        api_key: "sk-openai-xxx".into(),
        ..Default::default()
    }),
    ..Default::default()
});
browser.init().await?;

// Single action
browser.act("Click the Sign Up button").await?;

// Structured data extraction
let data: serde_json::Value = browser.extract("Get all product names and prices", None).await?;

// Element discovery (no LLM required)
let elements = browser.observe(None).await?;

// Autonomous agent
let result = browser.agent(None).execute("Find the cheapest flight to Tokyo").await?;
```

## Smart Retry

Failures are classified automatically. Blocked pages trigger proxy escalation and browser rotation.

```
request -> blocked -> escalate proxy -> rotate browser -> retry -> success
```

Four stealth tiers (0 = auto-escalate, 1-3 = explicit proxy quality). Browsers rotate automatically across the full fleet.

## Events

```rust
browser.on("captcha.detected", |data| { /* types, url */ });
browser.on("captcha.solved", |data| { /* url */ });
browser.on("retry.attempt", |data| { /* attempt, maxRetries, error */ });
browser.on("stealth.escalated", |data| { /* from, to, reason */ });
browser.on("browser.switching", |data| { /* from, to, reason */ });
browser.on("metering", |data| { /* credits, rate */ });
browser.on("agent.step", |data| { /* round, label */ });
browser.on("agent.done", |data| { /* rounds, result */ });
```

## Concurrency

Zero Mutex. The entire crate is lock-free — DashMap, ArcSwap, atomics, and channels throughout.

## License

MIT
