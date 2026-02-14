# spider-browser

TypeScript client for [Spider's](https://spider.cloud) Rust-powered browser cloud. Pre-warmed browsers, automatic stealth, smart retry, and AI automation.

## Install

```bash
npm install spider-browser
```

## Quick Start

```typescript
import { SpiderBrowser } from 'spider-browser';

const browser = new SpiderBrowser({ apiKey: process.env.SPIDER_API_KEY! });
await browser.init();

await browser.page.goto('https://example.com');
const html = await browser.page.content();
const screenshot = await browser.page.screenshot();

await browser.close();
```

## Page API

```typescript
// Navigation
await browser.page.goto('https://example.com');
await browser.page.gotoFast('https://example.com');  // 5s max wait
await browser.page.gotoDom('https://example.com');    // DOMContentLoaded
await browser.page.goBack();
await browser.page.goForward();
await browser.page.reload();

// Content
const html = await browser.page.content();          // smart waiting
const raw = await browser.page.rawContent();        // immediate
const title = await browser.page.title();
const url = await browser.page.url();
const png = await browser.page.screenshot();        // base64 PNG
const result = await browser.page.evaluate('document.title');

// Interaction
await browser.page.click('button.submit');
await browser.page.clickAt(100, 200);
await browser.page.clickAll('a.link');
await browser.page.dblclick('button');
await browser.page.rightClick('div.menu');
await browser.page.clickAndHold('#drag-handle', 2000);
await browser.page.fill('input[name=q]', 'query');
await browser.page.type('hello');
await browser.page.press('Enter');
await browser.page.select('select#country', 'US');
await browser.page.hover('a.link');
await browser.page.drag('div.source', 'div.target');

// Scroll
await browser.page.scrollY(500);
await browser.page.scrollX(200);
await browser.page.scrollTo('footer');

// Wait
await browser.page.waitForSelector('div.loaded');
await browser.page.waitForNavigation();
await browser.page.waitForReady();
await browser.page.waitForNetworkIdle();

// DOM
const el = await browser.page.querySelector('h1');
const all = await browser.page.querySelectorAll('a');
const text = await browser.page.textContent('h1');
await browser.page.setViewport(1920, 1080);
```

## AI Automation

Control the browser with natural language. Supports OpenAI, Anthropic, OpenRouter, and any OpenAI-compatible endpoint.

```typescript
const browser = new SpiderBrowser({
  apiKey: process.env.SPIDER_API_KEY!,
  llm: { provider: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! },
});
await browser.init();

// Single action
await browser.act('Click the "Sign Up" button');

// Structured data extraction
import { z } from 'zod';
const Products = z.array(z.object({ name: z.string(), price: z.string() }));
const products = await browser.extract('Get all product names and prices', { schema: Products });

// Element discovery (no LLM required)
const elements = await browser.observe();

// Autonomous agent
const result = await browser.agent({ maxRounds: 20 }).execute('Find the cheapest flight to Tokyo');
```

## Smart Retry

Failures are classified and recovered automatically. Blocked pages trigger proxy escalation and browser rotation without any configuration.

```
request -> blocked -> escalate proxy -> rotate browser -> retry -> success
```

Four stealth tiers (0 = auto-escalate, 1-3 = explicit proxy quality). Browsers rotate automatically across the full fleet.

## Session Recording

```typescript
const browser = new SpiderBrowser({ apiKey: 'sk-xxx', record: true });

browser.on('recording.completed', ({ sessionId, frameCount, durationMs }) => {
  console.log(`${frameCount} frames, ${durationMs}ms`);
});
```

## Configuration

```typescript
const browser = new SpiderBrowser({
  apiKey: 'sk-xxx',
  browser: 'auto',           // auto-selects best browser
  mode: 'scraping',          // 'scraping' | 'cua'
  stealth: 0,                // 0 (auto) | 1 | 2 | 3
  country: 'US',             // geo-located proxy (US, GB, DE, ...)
  captcha: 'solve',          // 'off' | 'detect' | 'solve'
  record: false,
  smartRetry: true,
  maxRetries: 12,
  connectTimeoutMs: 30_000,
  commandTimeoutMs: 30_000,
  llm: {
    provider: 'openai',      // 'openai' | 'anthropic' | 'openrouter'
    model: 'gpt-4o',
    apiKey: 'sk-...',
    baseUrl: 'https://...',  // custom endpoint
  },
});
```

## Events

```typescript
browser.on('captcha.detected', ({ types, url }) => {});
browser.on('captcha.solved', ({ url }) => {});
browser.on('retry.attempt', ({ attempt, maxRetries, error }) => {});
browser.on('stealth.escalated', ({ from, to, reason }) => {});
browser.on('browser.switching', ({ from, to, reason }) => {});
browser.on('screencast.frame', ({ data, timestamp, frameIndex }) => {});
browser.on('recording.completed', ({ sessionId, frameCount, durationMs }) => {});
browser.on('metering', ({ credits, rate }) => {});
browser.on('agent.step', ({ round, label }) => {});
browser.on('agent.done', ({ rounds, result }) => {});
```

## License

MIT
