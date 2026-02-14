# spider-browser

Python client for [Spider's](https://spider.cloud) Rust-powered browser cloud. Pre-warmed browsers, automatic stealth, smart retry, and AI automation.

## Install

```bash
pip install spider-browser
```

## Quick Start

```python
from spider_browser import SpiderBrowser, SpiderBrowserOptions

async with SpiderBrowser(SpiderBrowserOptions(api_key="sk-xxx")) as browser:
    await browser.page.goto("https://example.com")
    html = await browser.page.content()
    screenshot = await browser.page.screenshot()
```

## Page API

```python
# Navigation
await browser.page.goto("https://example.com")
await browser.page.goto_fast("https://example.com")  # 5s max wait
await browser.page.goto_dom("https://example.com")    # DOMContentLoaded
await browser.page.go_back()
await browser.page.go_forward()
await browser.page.reload()

# Content
html = await browser.page.content()          # smart waiting
raw = await browser.page.raw_content()       # immediate
title = await browser.page.title()
url = await browser.page.url()
png = await browser.page.screenshot()        # base64 PNG
result = await browser.page.evaluate("document.title")

# Interaction
await browser.page.click("button.submit")
await browser.page.click_at(100, 200)
await browser.page.click_all("a.link")
await browser.page.dblclick("button")
await browser.page.right_click("div.menu")
await browser.page.click_and_hold("#drag-handle", hold_ms=2000)
await browser.page.fill("input[name=q]", "query")
await browser.page.type("hello")
await browser.page.press("Enter")
await browser.page.select("select#country", "US")
await browser.page.hover("a.link")
await browser.page.drag("div.source", "div.target")

# Scroll
await browser.page.scroll_y(500)
await browser.page.scroll_x(200)
await browser.page.scroll_to("footer")

# Wait
await browser.page.wait_for_selector("div.loaded")
await browser.page.wait_for_navigation()

# DOM
el = await browser.page.query_selector("h1")
all_links = await browser.page.query_selector_all("a")
text = await browser.page.text_content("h1")
await browser.page.set_viewport(1920, 1080)
```

## AI Automation

Control the browser with natural language. Supports OpenAI, Anthropic, OpenRouter, and any OpenAI-compatible endpoint.

```python
from spider_browser.ai.llm_provider import LLMConfig

opts = SpiderBrowserOptions(
    api_key="sk-xxx",
    llm=LLMConfig(
        provider="openai",
        model="gpt-4o",
        api_key="sk-openai-xxx",
    ),
)

async with SpiderBrowser(opts) as browser:
    await browser.page.goto("https://example.com")

    # Single action
    await browser.act('Click the "Sign Up" button')

    # Structured data extraction
    data = await browser.extract("Get all product names and prices")

    # With Pydantic schema validation
    from pydantic import BaseModel
    class PageInfo(BaseModel):
        title: str
        link_count: int
    info = await browser.extract("Get page title and number of links", schema=PageInfo)

    # Element discovery (no LLM required)
    elements = await browser.observe()

    # Autonomous agent
    result = await browser.agent(AgentOptions(max_rounds=20)).execute("Find the cheapest flight to Tokyo")
```

## Smart Retry

Failures are classified and recovered automatically. Blocked pages trigger proxy escalation and browser rotation without any configuration.

```
request -> blocked -> escalate proxy -> rotate browser -> retry -> success
```

Four stealth tiers (0 = auto-escalate, 1-3 = explicit proxy quality). Browsers rotate automatically across the full fleet.

## Session Recording

```python
opts = SpiderBrowserOptions(api_key="sk-xxx", record=True)

async with SpiderBrowser(opts) as browser:
    browser.on("recording.completed", lambda e: print(f"Done: {e}"))
    await browser.page.goto("https://example.com")
```

## Configuration

```python
opts = SpiderBrowserOptions(
    api_key="sk-xxx",
    browser="auto",           # auto-selects best browser
    mode="scraping",          # "scraping" | "cua"
    stealth=0,                # 0 (auto) | 1 | 2 | 3
    country="US",             # geo-located proxy (US, GB, DE, ...)
    captcha="solve",          # "off" | "detect" | "solve"
    record=False,
    smart_retry=True,
    max_retries=12,
    connect_timeout_ms=30000,
    command_timeout_ms=30000,
    llm=LLMConfig(
        provider="openai",   # "openai" | "anthropic" | "openrouter"
        model="gpt-4o",
        api_key="sk-...",
        base_url="https://...",  # custom endpoint
    ),
)
```

## Events

```python
browser.on("captcha.detected", lambda e: print(f"Captcha: {e}"))
browser.on("captcha.solved", lambda _: print("Solved"))
browser.on("retry.attempt", lambda e: print(f"Retry: {e}"))
browser.on("stealth.escalated", lambda e: print(f"Stealth: {e}"))
browser.on("browser.switching", lambda e: print(f"{e['from']} -> {e['to']}"))
browser.on("recording.completed", lambda e: print(f"Recording: {e}"))
browser.on("metering", lambda e: print(f"Credits: {e}"))
browser.on("agent.step", lambda e: print(f"Round {e['round']}: {e['label']}"))
browser.on("agent.done", lambda e: print(f"Done in {e['rounds']} rounds"))
```

## License

MIT
