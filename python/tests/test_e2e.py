"""
E2E tests for spider-browser Python client.

Tests against the live browser.spider.cloud backend.
Usage: SPIDER_API_KEY=sk-xxx python -m pytest tests/test_e2e.py -v
"""

from __future__ import annotations

import asyncio
import base64
import os
import sys

import pytest

# Allow running from python/ directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from spider_browser import SpiderBrowser, SpiderBrowserOptions

API_KEY = os.environ.get("SPIDER_API_KEY", "")

pytestmark = pytest.mark.skipif(not API_KEY, reason="SPIDER_API_KEY not set")


@pytest.fixture
def chrome_opts() -> SpiderBrowserOptions:
    return SpiderBrowserOptions(api_key=API_KEY, browser="chrome")


@pytest.fixture
def firefox_opts() -> SpiderBrowserOptions:
    return SpiderBrowserOptions(api_key=API_KEY, browser="firefox")


# -------------------------------------------------------------------
# Chrome (CDP) Tests
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chrome_connect_and_init(chrome_opts: SpiderBrowserOptions) -> None:
    browser = SpiderBrowser(chrome_opts)
    try:
        await browser.init()
        assert browser.connected
    finally:
        await browser.close()


@pytest.mark.asyncio
async def test_chrome_navigate_and_title(chrome_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(chrome_opts) as browser:
        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        title = await browser.page.title()
        assert title and "example" in title.lower()


@pytest.mark.asyncio
async def test_chrome_page_content(chrome_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(chrome_opts) as browser:
        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        html = await browser.page.content()
        assert "Example Domain" in html


@pytest.mark.asyncio
async def test_chrome_screenshot(chrome_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(chrome_opts) as browser:
        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        shot = await browser.page.screenshot()
        assert shot and len(shot) > 100
        decoded = base64.b64decode(shot)
        assert len(decoded) > 100


@pytest.mark.asyncio
async def test_chrome_evaluate_js(chrome_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(chrome_opts) as browser:
        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        result = await browser.page.evaluate("1 + 1")
        assert result == 2


@pytest.mark.asyncio
async def test_chrome_get_url(chrome_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(chrome_opts) as browser:
        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        url = await browser.page.url()
        assert "example.com" in url


@pytest.mark.asyncio
async def test_chrome_observe_no_llm(chrome_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(chrome_opts) as browser:
        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        elements = await browser.observe()
        assert isinstance(elements, list)
        links = [e for e in elements if e.tag == "a"]
        assert len(links) > 0


# -------------------------------------------------------------------
# Firefox (BiDi) Tests
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_firefox_connect_and_init(firefox_opts: SpiderBrowserOptions) -> None:
    browser = SpiderBrowser(firefox_opts)
    try:
        await browser.init()
        assert browser.connected
    finally:
        await browser.close()


@pytest.mark.asyncio
async def test_firefox_navigate_and_title(firefox_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(firefox_opts) as browser:
        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        title = await browser.page.title()
        assert title and "example" in title.lower()


# -------------------------------------------------------------------
# Event System
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_events_ws_open() -> None:
    browser = SpiderBrowser(SpiderBrowserOptions(api_key=API_KEY, browser="chrome"))
    ws_open_fired = False

    def on_ws_open(data: dict) -> None:
        nonlocal ws_open_fired
        ws_open_fired = True

    browser.on("ws.open", on_ws_open)
    try:
        await browser.init()
        assert ws_open_fired
    finally:
        await browser.close()


# -------------------------------------------------------------------
# Multiple Navigations
# -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chrome_multiple_navigations(chrome_opts: SpiderBrowserOptions) -> None:
    async with SpiderBrowser(chrome_opts) as browser:
        await browser.page.goto("https://httpbin.org/html")
        await asyncio.sleep(2)
        html = await browser.page.content()
        assert "Herman Melville" in html

        await browser.page.goto("https://example.com")
        await asyncio.sleep(2)
        title = await browser.page.title()
        assert "example" in title.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--timeout=60"])
