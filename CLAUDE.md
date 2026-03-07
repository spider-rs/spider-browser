# spider-browser

Browser automation SDK for Spider's cloud browser fleet. Four implementations sharing the same architecture: TypeScript (primary), Python, Rust, and Go.

## Repository Structure

```
typescript/   – TypeScript/Node SDK (primary, most complete)
python/       – Python SDK
rust/         – Rust SDK
go/           – Go SDK
```

Each SDK mirrors the same module structure:
- `spider-browser` / `spider_browser` — main client class
- `page` — page interaction API (goto, click, fill, screenshot, etc.)
- `protocol/` — WebSocket transport, CDP and BiDi session adapters
- `retry/` — failure tracking, keyword classification, browser selection, retry engine
- `events/` — typed event emitter
- `ai/` — LLM-powered actions (act, observe, extract, agent), provider adapters (OpenAI, Anthropic)
- `utils/` — logger, HTML truncation, DOM helpers, error types

## Key Conventions

- All SDKs connect to Spider's cloud via WebSocket (`wss://browser.spider.cloud`)
- The protocol layer supports both CDP and BiDi (WebDriver BiDi)
- Smart retry automatically escalates stealth level and switches browsers on failure
- AI features require an LLM config (provider, model, apiKey) passed at construction
- TypeScript uses kebab-case filenames; Python uses snake_case; Rust uses snake_case; Go uses snake_case
- No monorepo tooling — each SDK is independent with its own build/test setup

## Quick Commands

| Task | TypeScript | Python | Rust | Go |
|------|-----------|--------|------|----|
| Install | `cd typescript && npm install` | `cd python && pip install -e ".[dev]"` | `cd rust && cargo build` | `cd go && go mod download` |
| Build | `cd typescript && npm run build` | N/A (pure Python) | `cd rust && cargo build` | `cd go && go build ./...` |
| Test | `cd typescript && npm test` | `cd python && pytest` | `cd rust && cargo test` | `cd go && go test ./...` |
| Typecheck | `cd typescript && npm run typecheck` | N/A | `cd rust && cargo check` | `cd go && go vet ./...` |
| E2E test | `cd typescript && npm run test:e2e` | `cd python && pytest tests/test_e2e.py` | N/A | N/A |

E2E tests require a `SPIDER_API_KEY` environment variable.
