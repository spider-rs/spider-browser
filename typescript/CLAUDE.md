# TypeScript SDK

Primary implementation. Node >= 18, ESM-first with CJS dual output.

## Commands

```bash
npm install          # install deps
npm run build        # tsup → dist/ (ESM + CJS + .d.ts)
npm run typecheck    # tsc --noEmit
npm test             # vitest run (unit tests)
npm run test:watch   # vitest (watch mode)
npm run test:e2e     # tsx __tests__/e2e.ts (requires SPIDER_API_KEY)
```

## Architecture

Entry point: `index.ts` → re-exports everything.

- `spider-browser.ts` — `SpiderBrowser` class: init, close, act/observe/extract/agent facades
- `page.ts` — `SpiderPage`: goto, click, fill, screenshot, evaluate, waitFor*, content
- `protocol/transport.ts` — WebSocket connection to Spider cloud
- `protocol/cdp-session.ts` / `bidi-session.ts` — CDP and BiDi protocol adapters
- `protocol/protocol-adapter.ts` — unified interface over CDP/BiDi
- `retry/retry-engine.ts` — orchestrates retries with browser switching + stealth escalation
- `retry/failure-tracker.ts` — tracks failure patterns per domain
- `retry/browser-selector.ts` — picks next browser based on failure history
- `retry/keyword-classifier.ts` — classifies error messages to choose retry strategy
- `ai/llm-provider.ts` — provider factory (`createProvider`) + `LLMProvider` interface
- `ai/providers/openai.ts` / `anthropic.ts` — provider implementations
- `ai/act.ts` / `observe.ts` / `extract.ts` — single-step AI actions
- `ai/agent.ts` — multi-step autonomous agent loop
- `ai/prompts.ts` — system prompts for AI features
- `events/emitter.ts` — typed event emitter
- `utils/` — logger, HTML truncation, DOM snapshot helpers, error classes

## Conventions

- Filenames: kebab-case (e.g., `retry-engine.ts`)
- Imports use `.js` extension (ESM resolution)
- Zod for runtime schema validation (extract feature)
- `ws` package for WebSocket (not browser WebSocket)
- Tests in `__tests__/*.test.ts`, run with vitest
- E2E scripts in `__tests__/*.ts` (non-.test files), run with tsx
