# spider-browser

[![npm](https://img.shields.io/npm/v/spider-browser)](https://www.npmjs.com/package/spider-browser)
[![PyPI](https://img.shields.io/pypi/v/spider-browser)](https://pypi.org/project/spider-browser/)
[![crates.io](https://img.shields.io/crates/v/spider-browser)](https://crates.io/crates/spider-browser)
[![Go Reference](https://pkg.go.dev/badge/github.com/spider-rs/spider-browser/go.svg)](https://pkg.go.dev/github.com/spider-rs/spider-browser/go)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Browser automation that works on every website.

[Spider](https://spider.cloud) gives you Rust-powered browsers in the cloud with automatic stealth, smart retry, adblock, tracker blocking, and AI automation for a [fraction of a cent per page](https://github.com/spider-rs/spider-browser-dataset/blob/main/latest-summary.json). No infrastructure to manage.

```bash
npm install spider-browser        # TypeScript
pip install spider-browser        # Python
cargo add spider-browser           # Rust
go get github.com/spider-rs/spider-browser/go  # Go
```

## Get Started

```typescript
import { SpiderBrowser } from 'spider-browser';

const browser = new SpiderBrowser({ apiKey: process.env.SPIDER_API_KEY! });
await browser.init();

await browser.page.goto('https://example.com');
const html = await browser.page.content();
const screenshot = await browser.page.screenshot();

await browser.close();
```

<details>
<summary>Python</summary>

```python
from spider_browser import SpiderBrowser, SpiderBrowserOptions

async with SpiderBrowser(SpiderBrowserOptions(api_key="sk-xxx")) as browser:
    await browser.page.goto("https://example.com")
    html = await browser.page.content()
    screenshot = await browser.page.screenshot()
```

</details>

<details>
<summary>Rust</summary>

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

</details>

<details>
<summary>Go</summary>

```go
package main

import (
	"os"

	spiderbrowser "github.com/spider-rs/spider-browser/go"
)

func main() {
	browser := spiderbrowser.New(spiderbrowser.SpiderBrowserOptions{
		APIKey: os.Getenv("SPIDER_API_KEY"),
	})
	if err := browser.Init(); err != nil {
		panic(err)
	}
	defer browser.Close()

	browser.Page().Goto("https://example.com")
	html, _ := browser.Page().Content(0, 0)
	screenshot, _ := browser.Page().Screenshot()
	_ = html
	_ = screenshot
}
```

</details>

## Features

| | |
|---|---|
| **Stealth** | Proxy escalation, browser rotation, and CAPTCHA solving &mdash; all automatic |
| **Protection** | Built-in adblock, tracker blocking, and malicious script blocking |
| **AI** | act, extract, observe, and autonomous agents with any LLM |
| **Recording** | Full screencast capture with interaction replay |
| **Scale** | 100 concurrent sessions, zero cold start |
| **Speed** | Pre-warmed browsers ready in milliseconds |

## AI Automation

Control the browser with natural language. Works with OpenAI, Anthropic, OpenRouter, or any compatible endpoint.

```typescript
const browser = new SpiderBrowser({
  apiKey: process.env.SPIDER_API_KEY!,
  llm: { provider: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! },
});
await browser.init();
await browser.page.goto('https://example.com');

// Perform a single action
await browser.act('Click the "Sign Up" button');

// Extract structured data
import { z } from 'zod';
const Products = z.array(z.object({ name: z.string(), price: z.string() }));
const products = await browser.extract('Get all product names and prices', { schema: Products });

// Discover interactive elements
const elements = await browser.observe();

// Run an autonomous agent
const result = await browser.agent({ maxRounds: 20 }).execute('Find the cheapest flight to Tokyo');
```

## Smart Retry

Failures are classified and recovered automatically. Proxies escalate, browsers rotate, and retries happen transparently.

## Page API

```typescript
// Navigate
await browser.page.goto(url);
await browser.page.gotoFast(url);           // 5s max
await browser.page.gotoDom(url);            // DOMContentLoaded
await browser.page.goBack();
await browser.page.reload();

// Content
const html = await browser.page.content();  // smart waiting
const raw  = await browser.page.rawContent();
const shot = await browser.page.screenshot();
const val  = await browser.page.evaluate('document.title');

// Interact
await browser.page.click('button');
await browser.page.fill('input', 'text');
await browser.page.press('Enter');
await browser.page.select('select', 'value');
await browser.page.hover('a');
await browser.page.drag('.from', '.to');
await browser.page.scrollY(500);

// Wait
await browser.page.waitForSelector('.loaded');
await browser.page.waitForNetworkIdle();
```

## Configuration

```typescript
new SpiderBrowser({
  apiKey: 'sk-xxx',
  browser: 'auto',          // auto-selects best browser
  mode: 'scraping',         // scraping (fast text) | cua (full render)
  stealth: 0,               // 0=auto | 1 | 2 | 3
  country: 'US',            // geo-located proxy (US, GB, DE, ...)
  proxyUrl: 'http://user:pass@host:port', // custom proxy (overrides country)
  captcha: 'solve',         // off | detect | solve
  record: false,            // screencast recording
  smartRetry: true,         // automatic retry + browser rotation
  maxRetries: 12,
  llm: { provider: 'openai', model: 'gpt-4o', apiKey: '...' },
});
```

## Events

```typescript
browser.on('captcha.detected', ({ types, url }) => {});
browser.on('captcha.solved', ({ url }) => {});
browser.on('stealth.escalated', ({ from, to, reason }) => {});
browser.on('browser.switching', ({ from, to, reason }) => {});
browser.on('retry.attempt', ({ attempt, maxRetries, error }) => {});
browser.on('metering', ({ credits, rate }) => {});
browser.on('recording.completed', ({ sessionId, frameCount, durationMs }) => {});
browser.on('agent.step', ({ round, label }) => {});
browser.on('agent.done', ({ rounds, result }) => {});
```

## License

MIT
