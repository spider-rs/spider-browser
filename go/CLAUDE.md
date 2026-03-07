# Go SDK

Go >= 1.21. Single package `spiderbrowser` with gorilla/websocket for WebSocket.

## Commands

```bash
go build ./...    # compile
go test ./...     # run tests
go vet ./...      # static analysis
```

## Architecture

Single package: `spiderbrowser`

- `spider_browser.go` — `SpiderBrowser` struct: Init, Close, AI method facades
- `page.go` — `SpiderPage`: Goto, Click, Fill, Screenshot, Evaluate, WaitFor*
- `transport.go` — WebSocket connection via gorilla/websocket
- `cdp_session.go` — CDP JSON-RPC session
- `bidi_session.go` — WebDriver BiDi session (Firefox)
- `protocol_adapter.go` — unified interface over CDP/BiDi
- `protocol_types.go` — protocol type definitions, key map
- `retry_engine.go` — retry orchestration with browser switching + stealth escalation
- `llm_provider.go` — provider interface + factory
- `openai_provider.go` — OpenAI/OpenRouter provider
- `anthropic_provider.go` — Anthropic provider
- `act.go` / `observe.go` / `extract.go` — single-step AI actions
- `agent.go` — autonomous agent loop
- `prompts.go` — system prompts
- `events.go` — event emitter
- `errors.go` — error types
- `html.go` — HTML truncation
- `dom.go` — DOM traversal scripts
- `logger.go` — structured logger

## Conventions

- Single package for simple imports: `import "github.com/spider-rs/spider-browser/go"`
- Exported types use CamelCase (SpiderBrowser, SpiderPage, etc.)
- Error returns (no panics except for programming errors like missing Init)
- `sync.Map` and `sync.Mutex` for concurrent state
- gorilla/websocket for WebSocket
- Standard `net/http` for LLM provider calls
- No external dependencies beyond gorilla/websocket
