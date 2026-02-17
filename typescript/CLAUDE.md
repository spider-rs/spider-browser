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

## Writing Spider-Browser Code

**Always prefer automation events over `page.evaluate()`.** The SpiderPage API provides
deterministic, cross-browser methods that dispatch real browser events. Use `evaluate()`
only as a last resort when no built-in method exists.

### Prefer: Automation Events

```ts
// Clicking
await page.click("button.submit");          // CSS selector
await page.clickAt(100, 200);               // coordinates
await page.dblclick("tr.row");
await page.rightClick(".context-menu");
await page.clickAndHold(".drag-handle");
await page.clickAll(".checkbox");

// Input
await page.fill("input[name='email']", "test@example.com");  // focus + clear + type
await page.type("search query");            // type into focused element
await page.press("Enter");                  // named key
await page.clear("input.search");
await page.select("select#country", "US");

// Navigation
await page.goto("https://example.com");
await page.gotoFast(url);                   // don't wait for full load
await page.gotoDom(url);                    // wait for DOMContentLoaded only
await page.goBack();
await page.goForward();

// Hover, Focus, Drag
await page.hover(".dropdown-trigger");
await page.focus("input.search");
await page.drag(".source", ".target");

// Scroll
await page.scrollY(500);                    // scroll down 500px
await page.scrollTo(".footer");             // scroll element into view

// Wait
await page.waitForSelector(".results", 10000);
await page.waitForReady();
await page.waitForContent(1000);
await page.waitForNetworkIdle();

// DOM Queries
const html = await page.querySelector(".product-card");
const items = await page.querySelectorAll(".list-item");
const text = await page.textContent("h1.title");

// Content (full page HTML with smart readiness detection)
const html = await page.content();           // wait + quality check
const raw = await page.rawContent();         // no waiting
const spa = await page.contentWithNetworkIdle();
```

### Avoid: page.evaluate() for things the API already does

```ts
// BAD — use page.click("button") instead
await page.evaluate('document.querySelector("button").click()');

// BAD — use page.textContent("h1") instead
await page.evaluate('document.querySelector("h1").textContent');

// BAD — use page.fill("input", "hello") instead
await page.evaluate('document.querySelector("input").value = "hello"');

// BAD — use page.scrollTo(".footer") instead
await page.evaluate('document.querySelector(".footer").scrollIntoView()');
```

### OK: page.evaluate() for complex extraction

`evaluate()` is the right tool when you need to run complex multi-element logic
that returns structured data — things the built-in methods don't cover:

```ts
// OK — complex multi-element extraction into structured JSON
const data = await page.evaluate(`(() => {
  const items = [];
  document.querySelectorAll(".product").forEach(el => {
    const name = el.querySelector(".name")?.textContent?.trim();
    const price = el.querySelector(".price")?.textContent;
    if (name) items.push({ name, price });
  });
  return JSON.stringify({ total: items.length, items });
})()`);
```

## Conventions

- Filenames: kebab-case (e.g., `retry-engine.ts`)
- Imports use `.js` extension (ESM resolution)
- Zod for runtime schema validation (extract feature)
- `ws` package for WebSocket (not browser WebSocket)
- Tests in `__tests__/*.test.ts`, run with vitest
- E2E scripts in `__tests__/*.ts` (non-.test files), run with tsx
