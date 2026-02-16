# Rust SDK

Edition 2021. Async with tokio. Optional `ai` feature (enabled by default) adds reqwest for LLM calls.

## Commands

```bash
cargo build              # compile
cargo test               # run tests
cargo check              # typecheck only
cargo build --no-default-features   # build without AI feature
```

## Architecture

Crate root: `src/lib.rs`

- `spider_browser.rs` — `SpiderBrowser` struct: init, close, AI method facades
- `page.rs` — `SpiderPage`: goto, click, fill, screenshot, evaluate, wait_for_*
- `protocol/transport.rs` — WebSocket via tokio-tungstenite
- `protocol/cdp_session.rs` / `bidi_session.rs` — CDP and BiDi adapters
- `protocol/protocol_adapter.rs` — unified protocol trait
- `protocol/types.rs` — protocol types
- `retry/retry_engine.rs` — retry orchestration
- `retry/failure_tracker.rs` — per-domain failure tracking (DashMap for concurrency)
- `retry/browser_selector.rs` — browser selection logic
- `retry/keyword_classifier.rs` — error classification for retry strategy
- `ai/llm_provider.rs` — provider trait + factory (behind `ai` feature)
- `ai/providers/openai.rs` / `anthropic.rs` — LLM implementations
- `ai/act.rs` / `observe.rs` / `extract.rs` — single-step AI actions
- `ai/agent.rs` — autonomous agent loop
- `ai/prompts.rs` — system prompts
- `events.rs` — event types and emitter
- `errors.rs` — error types (thiserror)

## Conventions

- Filenames: snake_case
- `async-trait` for async trait methods
- `DashMap` + `ArcSwap` for concurrent shared state
- `tracing` for logging (not `log`)
- `thiserror` for error types
- `serde` + `serde_json` for serialization
- Feature-gated: `ai` feature controls LLM-related code (requires `reqwest`)
