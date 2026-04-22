---
name: spider-browser
description: >
  Browser automation SDK for Spider's cloud browser fleet.
  Use when building web scrapers, browser automation, AI-powered browsing,
  or any task requiring headless browser control with stealth, retry, and CAPTCHA solving.
license: MIT
metadata:
  author: spider-cloud
  version: "0.1.0"
  repository: "https://github.com/spider-rs/spider-browser"
  sdks:
    - typescript
    - python
    - rust
---

# spider-browser

Cloud browser automation with built-in stealth, smart retry, and AI-powered actions.

## When to use

- Scraping sites that block bots (Cloudflare, DataDome, PerimeterX)
- Browser automation that needs CAPTCHA solving
- AI-driven browsing — fill forms, extract structured data, run multi-step agents
- Rendering JavaScript-heavy pages for content extraction
- Testing against bot-protection systems

## When NOT to use

- Simple HTTP fetches where `fetch` / `requests` / `reqwest` suffice
- Static site generation or build tooling
- Local browser testing (use Playwright or Puppeteer directly)
- Tasks that don't need a real browser environment

## Installation

```bash
# TypeScript / Node (>= 18)
npm install spider-browser

# Python (>= 3.10)
pip install spider-browser

# Rust (edition 2021)
cargo add spider-browser
```

## Quick start

```typescript
import { SpiderBrowser } from "spider-browser";

const browser = new SpiderBrowser({ apiKey: process.env.SPIDER_API_KEY });
await browser.init();
await browser.goto("https://example.com");

const html = await browser.page.content();
console.log(html);

await browser.close();
```

```python
from spider_browser import SpiderBrowser

async with SpiderBrowser(api_key="YOUR_API_KEY") as browser:
    await browser.goto("https://example.com")
    html = await browser.page.content()
    print(html)
```

## Core API

### SpiderBrowser

| Method | Description |
|--------|-------------|
| `init()` | Connect to Spider cloud and allocate a browser session |
| `close()` | Disconnect and release the session |
| `goto(url)` | Navigate with smart retry (stealth escalation + browser switching) |
| `page` | Access the `SpiderPage` instance for direct browser control |

### SpiderPage — navigation

| Method | Description |
|--------|-------------|
| `goto(url)` | Navigate and wait for load |
| `gotoFast(url)` | Navigate with 5 s max wait |
| `gotoDom(url)` | Wait for DOMContentLoaded only (3 s max) |
| `goBack()` | Browser back |
| `goForward()` | Browser forward |
| `reload()` | Reload current page |

### SpiderPage — content

| Method | Description |
|--------|-------------|
| `content(waitMs?, minLength?)` | HTML after network idle + DOM stability (default 8 s / 1000 chars) |
| `rawContent()` | Immediate HTML without waiting |
| `contentWithEarlyReturn(maxWaitMs?, minContentLength?, pollIntervalMs?)` | Poll-based early return |
| `contentWithNetworkIdle(maxWaitMs?, minContentLength?, interstitialBudgetMs?)` | PerformanceObserver + MutationObserver approach |
| `title()` | Page title |
| `url()` | Current URL |
| `screenshot()` | Base64 PNG screenshot |
| `evaluate(expression)` | Run arbitrary JS in the page |

### SpiderPage — interaction

| Method | Description |
|--------|-------------|
| `click(selector)` | Click element |
| `clickAt(x, y)` | Click at coordinates |
| `clickAll(selector)` | Click all matching elements |
| `dblclick(selector)` | Double-click |
| `rightClick(selector)` | Right-click |
| `fill(selector, value)` | Focus, clear, then type into input |
| `type(value)` | Type into currently focused element |
| `press(key)` | Press a key ("Enter", "Tab", "Escape", etc.) |
| `clear(selector)` | Clear an input field |
| `select(selector, value)` | Select a dropdown option |
| `hover(selector)` | Hover over element |
| `focus(selector)` | Focus element |
| `blur(selector)` | Blur element |
| `drag(from, to)` | Drag from one selector to another |

### SpiderPage — scroll

| Method | Description |
|--------|-------------|
| `scrollY(pixels)` | Scroll vertically (positive = down) |
| `scrollX(pixels)` | Scroll horizontally (positive = right) |
| `scrollTo(selector)` | Scroll element into view |
| `scrollToPoint(x, y)` | Scroll to absolute coordinates |

### SpiderPage — waiting

| Method | Description |
|--------|-------------|
| `waitForSelector(selector, timeoutMs?)` | Wait for element (default 5 s) |
| `waitForNavigation(timeoutMs?)` | Wait for navigation (default 5 s) |
| `waitForReady(timeoutMs?)` | Wait for `readyState=complete` + DOM stability (default 10 s) |
| `waitForContent(minLength?, timeoutMs?)` | Wait until content reaches minimum length |
| `waitForNetworkIdle(timeoutMs?)` | Wait for network idle (default 8 s) |

### SpiderPage — DOM queries

| Method | Description |
|--------|-------------|
| `querySelector(selector)` | Returns `outerHTML` of first match (or null) |
| `querySelectorAll(selector)` | Returns `outerHTML[]` of all matches |
| `textContent(selector)` | Text content of element |
| `setViewport(width, height, scale?, mobile?)` | Set viewport dimensions |

## AI automation

AI methods require an `llm` config at construction time:

```typescript
const browser = new SpiderBrowser({
  apiKey: process.env.SPIDER_API_KEY,
  llm: {
    provider: "openai",       // "openai" | "anthropic" | "openrouter"
    model: "gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
  },
});
```

### act — execute a single action from natural language

```typescript
await browser.act("Click the Sign In button");
await browser.act("Type 'hello world' into the search box");
```

### observe — discover interactive elements on the page

```typescript
// Without LLM: returns all interactive elements via DOM traversal
const elements = await browser.observe();

// With instruction + LLM: filters and ranks by relevance
const buttons = await browser.observe("Find all Add to Cart buttons");
// Returns: [{ selector, tag, text, ariaLabel, rect, score, ... }]
```

### extract — pull structured data from the page

```typescript
import { z } from "zod";

const data = await browser.extract("Product name and price", {
  schema: z.object({
    name: z.string(),
    price: z.number(),
  }),
});
// Returns: { name: "Widget", price: 29.99 }
```

### agent — multi-step autonomous browsing

```typescript
const agent = browser.agent({ maxRounds: 20 });
const result = await agent.execute(
  "Search for 'spider browser', click the first result, and extract the page title"
);
// result: { done: true, rounds: 5, extracted: "...", label: "..." }
```

## Configuration

### SpiderBrowserOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | Spider API key |
| `browser` | `"auto" \| "chrome" \| "firefox"` | `"auto"` | Browser engine preference |
| `mode` | `"scraping" \| "cua"` | — | `scraping` for fast text, `cua` for full rendering |
| `stealth` | `0-3` | `0` | Stealth level (0 = auto-escalate on failure) |
| `maxStealthLevels` | `1-3` | `3` | Max stealth tier to escalate to |
| `captcha` | `"off" \| "detect" \| "solve"` | `"solve"` | CAPTCHA handling strategy |
| `smartRetry` | `boolean` | `true` | Enable smart retry with browser switching |
| `maxRetries` | `number` | `12` | Max retry attempts across all browsers |
| `country` | `string` | — | Geo-located proxy country code ("US", "GB", "DE") |
| `proxyUrl` | `string` | — | Custom proxy URL (e.g. `http://user:pass@host:port`); overrides `country` |
| `llm` | `LLMConfig` | — | LLM provider config for AI methods |
| `record` | `boolean` | `false` | Enable screencast recording |
| `hedge` | `boolean` | `false` | Mark as hedge session (parallel racing) |
| `connectTimeoutMs` | `number` | `30000` | WebSocket connection timeout |
| `commandTimeoutMs` | `number` | `30000` | CDP/BiDi command timeout |
| `retryTimeoutMs` | `number` | `15000` | Timeout for retry attempts |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | — | Log verbosity |

### Decision table — choosing options for your use case

| Use case | `mode` | `stealth` | `captcha` | `smartRetry` |
|----------|--------|-----------|-----------|--------------|
| Fast scraping, low protection | `"scraping"` | `1` | `"off"` | `false` |
| General scraping | `"scraping"` | `0` | `"solve"` | `true` |
| Heavy bot protection | `"scraping"` | `0` | `"solve"` | `true` + high `maxRetries` |
| AI browsing / form filling | `"cua"` | `0` | `"solve"` | `true` |
| Visual testing / screenshots | `"cua"` | `1` | `"off"` | `false` |

## Common patterns

### Scrape with smart retry (handles blocks automatically)

```typescript
const browser = new SpiderBrowser({
  apiKey: process.env.SPIDER_API_KEY,
  smartRetry: true,
});
await browser.init();
await browser.goto("https://protected-site.com");
const html = await browser.page.content();
await browser.close();
```

### AI-powered data extraction

```typescript
const browser = new SpiderBrowser({
  apiKey: process.env.SPIDER_API_KEY,
  llm: { provider: "anthropic", model: "claude-sonnet-4-5-20250929", apiKey: process.env.ANTHROPIC_API_KEY },
});
await browser.init();
await browser.goto("https://store.example.com");
const products = await browser.extract("All products with name, price, and rating", {
  schema: z.array(z.object({ name: z.string(), price: z.number(), rating: z.number() })),
});
await browser.close();
```

### Monitor retry events

```typescript
browser.on("stealth.escalated", ({ from, to, reason }) => {
  console.log(`Stealth ${from} → ${to}: ${reason}`);
});
browser.on("browser.switching", ({ from, to, reason }) => {
  console.log(`Switching ${from} → ${to}: ${reason}`);
});
browser.on("captcha.detected", ({ types, url }) => {
  console.log(`CAPTCHA detected: ${types.join(", ")} at ${url}`);
});
```

## Gotchas

1. **You must call `init()` before using `page` or any methods.** The constructor does not connect — `init()` opens the WebSocket and allocates a cloud browser.
2. **AI methods (`act`, `observe` with instruction, `extract`, `agent`) require an `llm` config.** They will throw `LLMError` if no LLM is configured. `observe()` without an instruction works without LLM (pure DOM traversal).
3. **Smart retry is on by default.** `goto()` on `SpiderBrowser` wraps navigation with retry logic. If you want raw navigation without retries, use `browser.page.goto()` directly.
4. **`content()` waits for network idle.** It polls for DOM stability and network quiet (default 8 s). Use `rawContent()` for immediate HTML or `gotoFast()` + `rawContent()` for speed.
5. **Stealth level 0 means auto-escalate.** Setting `stealth: 0` (the default) doesn't mean "no stealth" — it means the retry engine will start low and escalate automatically on blocked errors.
6. **Close your sessions.** Always call `close()` (or use Python's `async with`) to release cloud browser resources. Unclosed sessions consume credits.
7. **`extract()` uses Zod schemas (TypeScript) / Pydantic models (Python).** The schema constrains LLM output and enables type-safe structured extraction.
8. **The agent has a round limit.** Default `maxRounds: 30`. Long multi-step tasks may hit this limit — increase it or break into subtasks.
