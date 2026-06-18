"""SpiderPage — deterministic browser tab abstraction."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List, Optional

from .protocol.protocol_adapter import ProtocolAdapter
from .utils.errors import BlockedError, TimeoutError


class SpiderPage:
    """
    Deterministic browser tab abstraction.

    All standard browser automation methods (no LLM required).
    Works over both CDP (Chrome/Servo/LightPanda) and BiDi (Firefox)
    through the ProtocolAdapter.
    """

    def __init__(self, adapter: ProtocolAdapter) -> None:
        self._adapter = adapter

    # -------------------------------------------------------------------
    # Navigation
    # -------------------------------------------------------------------

    async def goto(self, url: str) -> None:
        """Navigate to a URL and wait for load."""
        await self._adapter.navigate(url)

    async def goto_fast(self, url: str) -> None:
        """Navigate without waiting for full page load (5s max wait).
        Use with content_with_early_return() for SPAs that never fire loadEventFired.
        """
        await self._adapter.navigate_fast(url)

    async def goto_dom(self, url: str) -> None:
        """Navigate and return as soon as DOMContentLoaded fires (3s max).
        Fastest option — the DOM shell is ready but subresources may still load.
        Pair with content_with_early_return() or content_with_network_idle() for best results.
        """
        await self._adapter.navigate_dom(url)

    async def go_back(self) -> None:
        await self._adapter.evaluate("window.history.back()")

    async def go_forward(self) -> None:
        await self._adapter.evaluate("window.history.forward()")

    async def reload(self) -> None:
        await self._adapter.evaluate("window.location.reload()")

    # -------------------------------------------------------------------
    # Content
    # -------------------------------------------------------------------

    async def content(self, wait_ms: int = 8000, min_length: int = 1000) -> str:
        """Get the full page HTML, ensuring the page is ready first.

        Waits for network idle + DOM stability, then checks content quality.
        If the content seems incomplete (too short or looks like a loading state),
        does incremental waits with exponential backoff before returning.

        Args:
            wait_ms: Max time to wait for readiness (default: 8000ms).
                     Pass 0 to skip readiness checks and return immediately.
            min_length: Minimum content length to consider "good" (default: 1000).
        """
        # Fast path: check if content is already sufficient before waiting for
        # network idle. SSR pages have full HTML available immediately after
        # navigation, so this skips the expensive networkIdle wait entirely.
        if wait_ms > 0:
            early_html = (await self._adapter.get_html()) or ""
            if (
                len(early_html) >= min_length
                and not self._is_interstitial_content(early_html)
                and not self._is_rate_limit_content(early_html)
            ):
                return early_html
            await self.wait_for_network_idle(wait_ms)

        html = (await self._adapter.get_html()) or ""

        # Interstitial detection — wait for challenge pages to resolve before failing.
        if wait_ms > 0 and self._is_interstitial_content(html):
            interstitial_waits = [2.0, 2.0, 3.0, 4.0, 5.0, 7.0, 7.0]
            for wait in interstitial_waits:
                await asyncio.sleep(wait)
                html = (await self._adapter.get_html()) or ""
                if not self._is_interstitial_content(html):
                    break
                if len(html) > 15_000:
                    break
            if self._is_interstitial_content(html):
                raise BlockedError("Page stuck on interstitial challenge")

        # Site-level rate limiting
        if wait_ms > 0 and self._is_rate_limit_content(html):
            raise BlockedError("Rate limit exceeded (site-level)")

        # Incremental quality check
        if wait_ms > 0 and len(html) < min_length:
            increments = [0.3, 0.5, 0.8, 1.2]
            for extra in increments:
                await asyncio.sleep(extra)
                updated = (await self._adapter.get_html()) or ""
                if len(updated) > len(html):
                    html = updated
                if len(html) >= min_length:
                    break
            # Polling phase for SPAs
            if len(html) < min_length:
                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline:
                    await asyncio.sleep(1.0)
                    polled = (await self._adapter.get_html()) or ""
                    if len(polled) > len(html):
                        html = polled
                    if len(html) >= min_length:
                        break

        return html

    async def raw_content(self) -> str:
        """Get the raw page HTML without any readiness waiting."""
        return await self._adapter.get_html()

    async def content_with_early_return(
        self,
        max_wait_ms: int = 15000,
        min_content_length: int = 500,
        poll_interval_ms: int = 2000,
    ) -> str:
        """Poll for content with early return — for SPAs that never fire loadEventFired."""
        deadline = time.monotonic() + max_wait_ms / 1000
        while time.monotonic() < deadline:
            html = (await self._adapter.get_html()) or ""
            if (
                len(html) >= min_content_length
                and not self._is_interstitial_content(html)
                and not self._is_rate_limit_content(html)
            ):
                return html
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            await asyncio.sleep(min(poll_interval_ms / 1000, remaining))
        return (await self._adapter.get_html()) or ""

    async def content_with_network_idle(
        self,
        max_wait_ms: int = 20000,
        min_content_length: int = 1000,
        interstitial_budget_ms: int = 16000,
    ) -> str:
        """Get content using network idle detection + polling hybrid approach."""
        deadline = time.monotonic() + max_wait_ms / 1000

        # Phase 1: Quick check — SSR pages have content immediately
        html = (await self._adapter.get_html()) or ""
        if (
            len(html) >= min_content_length
            and not self._is_interstitial_content(html)
            and not self._is_rate_limit_content(html)
        ):
            return html

        # Phase 2: Wait for readyState=interactive or complete
        dom_deadline = min(deadline, time.monotonic() + 5.0)
        while time.monotonic() < dom_deadline:
            state = await self._adapter.evaluate("document.readyState")
            if state in ("interactive", "complete"):
                break
            await asyncio.sleep(0.2)

        # Phase 3: Network + DOM idle monitoring
        idle_ms = 400
        idle_check_ms = min(8000, max(500, (deadline - time.monotonic()) * 1000))
        if idle_check_ms > 500:
            try:
                await self._adapter.evaluate(f"""
                    new Promise((resolve) => {{
                        let lastActivity = Date.now();
                        const idleThreshold = {idle_ms};
                        const deadline = Date.now() + {int(idle_check_ms)};
                        const perfObs = new PerformanceObserver(() => {{ lastActivity = Date.now(); }});
                        try {{ perfObs.observe({{ entryTypes: ['resource'] }}); }} catch(e) {{}}
                        const mutObs = new MutationObserver(() => {{ lastActivity = Date.now(); }});
                        mutObs.observe(document.documentElement, {{ childList: true, subtree: true, attributes: true }});
                        const check = () => {{
                            const now = Date.now();
                            if (now >= deadline || (now - lastActivity >= idleThreshold)) {{
                                perfObs.disconnect(); mutObs.disconnect(); resolve(true); return;
                            }}
                            setTimeout(check, 100);
                        }};
                        setTimeout(check, idleThreshold);
                    }})
                """)
            except Exception:
                await asyncio.sleep(0.5)

        # Check content after idle
        html = (await self._adapter.get_html()) or ""
        if (
            len(html) >= min_content_length
            and not self._is_interstitial_content(html)
            and not self._is_rate_limit_content(html)
        ):
            return html

        # Phase 4: Interstitial handling
        if self._is_interstitial_content(html):
            i_deadline = min(deadline, time.monotonic() + interstitial_budget_ms / 1000)
            waits = [2.0, 2.0, 3.0, 4.0, 5.0, 7.0, 10.0]
            for wait in waits:
                if time.monotonic() >= i_deadline:
                    break
                await asyncio.sleep(min(wait, i_deadline - time.monotonic()))
                html = (await self._adapter.get_html()) or ""
                if not self._is_interstitial_content(html):
                    break
                if len(html) > 15_000:
                    break
            if self._is_interstitial_content(html):
                raise BlockedError("Page stuck on interstitial challenge")

        if self._is_rate_limit_content(html):
            raise BlockedError("Rate limit exceeded (site-level)")

        # Phase 5: Final polling for async content
        if len(html) < min_content_length:
            while time.monotonic() < deadline:
                await asyncio.sleep(1.0)
                polled = (await self._adapter.get_html()) or ""
                if len(polled) > len(html):
                    html = polled
                if len(html) >= min_content_length:
                    break

        return html

    async def title(self) -> str:
        result = await self._adapter.evaluate("document.title")
        return str(result) if result is not None else ""

    async def url(self) -> str:
        result = await self._adapter.evaluate("window.location.href")
        return str(result) if result is not None else ""

    async def screenshot(self) -> str:
        """Capture a screenshot as base64 PNG."""
        return await self._adapter.capture_screenshot()

    async def evaluate(self, expression: str) -> Any:
        """Evaluate arbitrary JavaScript and return the result."""
        return await self._adapter.evaluate(expression)

    # -- Session snapshots — persist a session and resume it later ----------

    async def save_snapshot(self, snapshot_id: Optional[str] = None) -> Any:
        """Save the current session as a portable snapshot to persist and restore
        later — cookies, local/session storage, the current URL, extra request
        headers, and the viewport. Returns the snapshot blob; store it and pass
        it back to ``restore_snapshot`` to pick up where you left off."""
        params: Dict[str, Any] = {}
        if snapshot_id is not None:
            params["id"] = snapshot_id
        resp = await self._adapter.send_command("Snapshot.capture", params)
        if isinstance(resp, dict) and "snapshot" in resp:
            return resp["snapshot"]
        return resp

    async def restore_snapshot(self, snapshot: Any) -> Any:
        """Restore a previously saved session snapshot into this page. Accepts the
        blob returned by ``save_snapshot`` or the full capture result."""
        blob = (
            snapshot["snapshot"]
            if isinstance(snapshot, dict) and "snapshot" in snapshot
            else snapshot
        )
        return await self._adapter.send_command("Snapshot.restore", {"snapshot": blob})

    async def delete_snapshot(self, snapshot_id: str) -> Any:
        """Delete a saved snapshot by id from the browser's local cache."""
        return await self._adapter.send_command("Snapshot.delete", {"id": snapshot_id})

    # -------------------------------------------------------------------
    # Click Actions
    # -------------------------------------------------------------------

    async def click(self, selector: str) -> None:
        """Click an element by CSS selector."""
        pos = await self._get_element_center(selector)
        await self._adapter.click_point(pos["x"], pos["y"])

    async def click_at(self, x: float, y: float) -> None:
        """Click at specific viewport coordinates."""
        await self._adapter.click_point(x, y)

    async def dblclick(self, selector: str) -> None:
        pos = await self._get_element_center(selector)
        await self._adapter.double_click_point(pos["x"], pos["y"])

    async def right_click(self, selector: str) -> None:
        pos = await self._get_element_center(selector)
        await self._adapter.right_click_point(pos["x"], pos["y"])

    async def click_and_hold(self, selector: str, hold_ms: int = 1000) -> None:
        """Click and hold an element for a duration (default 1000ms)."""
        pos = await self._get_element_center(selector)
        await self._adapter.click_hold_point(pos["x"], pos["y"], hold_ms)

    async def click_and_hold_at(self, x: float, y: float, hold_ms: int = 1000) -> None:
        """Click and hold at coordinates for a duration (default 1000ms)."""
        await self._adapter.click_hold_point(x, y, hold_ms)

    async def click_all(self, selector: str) -> None:
        """Click all elements matching a selector."""
        points = await self._adapter.evaluate(f"""
            (function() {{
                const els = document.querySelectorAll({json.dumps(selector)});
                return Array.from(els).map(el => {{
                    const r = el.getBoundingClientRect();
                    return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
                }});
            }})()
        """)
        if isinstance(points, list):
            for pt in points:
                if isinstance(pt, dict):
                    await self._adapter.click_point(pt["x"], pt["y"])
                    await asyncio.sleep(0.1)

    # -------------------------------------------------------------------
    # Input Actions
    # -------------------------------------------------------------------

    async def fill(self, selector: str, value: str) -> None:
        """Fill a form field — focus, clear existing value, type new value."""
        await self._adapter.evaluate(f"""
            (function() {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) {{ el.focus(); el.value = ''; }}
            }})()
        """)
        try:
            pos = await self._get_element_center(selector)
            await self._adapter.click_point(pos["x"], pos["y"])
        except Exception:
            pass
        await self._adapter.insert_text(value)
        await self._adapter.evaluate(f"""
            (function() {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) {{
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }})()
        """)

    async def type(self, value: str) -> None:
        """Type text into the currently focused element."""
        await self._adapter.insert_text(value)

    async def press(self, key: str) -> None:
        """Press a named key (e.g. 'Enter', 'Tab', 'Escape')."""
        await self._adapter.press_key(key)

    async def clear(self, selector: str) -> None:
        await self._adapter.evaluate(
            f"document.querySelector({json.dumps(selector)}).value = ''"
        )

    async def select(self, selector: str, value: str) -> None:
        """Select an option in a <select> element."""
        await self._adapter.evaluate(f"""
            (function() {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) {{
                    el.value = {json.dumps(value)};
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }})()
        """)

    # -------------------------------------------------------------------
    # Focus & Hover
    # -------------------------------------------------------------------

    async def focus(self, selector: str) -> None:
        await self._adapter.evaluate(
            f"document.querySelector({json.dumps(selector)})?.focus()"
        )

    async def blur(self, selector: str) -> None:
        await self._adapter.evaluate(
            f"document.querySelector({json.dumps(selector)})?.blur()"
        )

    async def hover(self, selector: str) -> None:
        pos = await self._get_element_center(selector)
        await self._adapter.hover_point(pos["x"], pos["y"])

    # -------------------------------------------------------------------
    # Drag
    # -------------------------------------------------------------------

    async def drag(self, from_selector: str, to_selector: str) -> None:
        f = await self._get_element_center(from_selector)
        t = await self._get_element_center(to_selector)
        await self._adapter.drag_point(f["x"], f["y"], t["x"], t["y"])

    # -------------------------------------------------------------------
    # Scroll
    # -------------------------------------------------------------------

    async def scroll_y(self, pixels: int) -> None:
        await self._adapter.evaluate(f"window.scrollBy(0, {pixels})")

    async def scroll_x(self, pixels: int) -> None:
        await self._adapter.evaluate(f"window.scrollBy({pixels}, 0)")

    async def scroll_to(self, selector: str) -> None:
        await self._adapter.evaluate(
            f"document.querySelector({json.dumps(selector)})?.scrollIntoView({{ behavior: 'smooth', block: 'center' }})"
        )

    async def scroll_to_point(self, x: int, y: int) -> None:
        await self._adapter.evaluate(f"window.scrollTo({x}, {y})")

    # -------------------------------------------------------------------
    # Wait
    # -------------------------------------------------------------------

    async def wait_for_selector(self, selector: str, timeout_ms: int = 5000) -> None:
        """Wait for a CSS selector to appear in the DOM."""
        interval = 0.1
        max_iter = int(timeout_ms / 100)
        check_js = f"!!document.querySelector({json.dumps(selector)})"
        for _ in range(max_iter):
            found = await self._adapter.evaluate(check_js)
            if found:
                return
            await asyncio.sleep(interval)
        raise TimeoutError(f"Timeout waiting for selector: {selector}")

    async def wait_for_navigation(self, timeout_ms: int = 5000) -> None:
        await asyncio.sleep(min(timeout_ms, 1000) / 1000.0)

    async def wait_for_ready(self, timeout_ms: int = 10000) -> None:
        """Wait until the page is fully loaded and DOM is stable.

        Checks:
        1. document.readyState === 'complete'
        2. DOM content length stabilizes (no changes for 500ms)
        """
        start = time.monotonic()
        poll_interval = 0.2
        stable_threshold = 0.5

        # Phase 1: wait for readyState === 'complete'
        while time.monotonic() - start < timeout_ms / 1000:
            state = await self._adapter.evaluate("document.readyState")
            if state == "complete":
                break
            await asyncio.sleep(poll_interval)

        # Phase 2: wait for DOM content length to stabilize
        last_length = 0
        stable_since = time.monotonic()

        while time.monotonic() - start < timeout_ms / 1000:
            length = await self._adapter.evaluate(
                "document.documentElement.innerHTML.length"
            )
            length = int(length) if length else 0

            if length != last_length:
                last_length = length
                stable_since = time.monotonic()
            elif time.monotonic() - stable_since >= stable_threshold:
                return

            await asyncio.sleep(poll_interval)

    async def wait_for_content(self, min_length: int = 500, timeout_ms: int = 8000) -> None:
        """Wait until page content exceeds a minimum length."""
        start = time.monotonic()
        while time.monotonic() - start < timeout_ms / 1000:
            length = await self._adapter.evaluate(
                "document.documentElement.innerHTML.length"
            )
            length = int(length) if length else 0
            if length >= min_length:
                return
            await asyncio.sleep(0.2)

    async def wait_for_network_idle(self, timeout_ms: int = 8000) -> None:
        """Wait for network idle + DOM stability (cross-platform).

        Uses PerformanceObserver + MutationObserver to detect when
        the page stops loading and DOM mutations settle.
        """
        start = time.monotonic()
        poll_interval = 0.25

        # Phase 1: wait for readyState === 'complete'
        while time.monotonic() - start < timeout_ms / 1000:
            state = await self._adapter.evaluate("document.readyState")
            if state == "complete":
                break
            await asyncio.sleep(poll_interval)

        # Phase 2: network + DOM stability checker
        idle_ms = 400
        remaining = max(1000, timeout_ms - int((time.monotonic() - start) * 1000))
        try:
            await self._adapter.evaluate(f"""
                new Promise((resolve) => {{
                    let lastActivity = Date.now();
                    const idleThreshold = {idle_ms};
                    const deadline = Date.now() + {remaining};
                    const perfObs = new PerformanceObserver(() => {{ lastActivity = Date.now(); }});
                    try {{ perfObs.observe({{ entryTypes: ['resource'] }}); }} catch(e) {{}}
                    const mutObs = new MutationObserver(() => {{ lastActivity = Date.now(); }});
                    mutObs.observe(document.documentElement, {{
                        childList: true, subtree: true, attributes: true
                    }});
                    const check = () => {{
                        const now = Date.now();
                        if (now >= deadline || (now - lastActivity >= idleThreshold)) {{
                            perfObs.disconnect();
                            mutObs.disconnect();
                            resolve(true);
                            return;
                        }}
                        setTimeout(check, 100);
                    }};
                    setTimeout(check, idleThreshold);
                }})
            """)
        except Exception:
            await asyncio.sleep(0.5)

    # -------------------------------------------------------------------
    # Viewport
    # -------------------------------------------------------------------

    async def set_viewport(
        self,
        width: int,
        height: int,
        device_scale_factor: float = 2.0,
        mobile: bool = False,
    ) -> None:
        await self._adapter.set_viewport(width, height, device_scale_factor, mobile)

    # -------------------------------------------------------------------
    # DOM Queries
    # -------------------------------------------------------------------

    async def query_selector(self, selector: str) -> Optional[str]:
        """Query a single element and return its outer HTML."""
        result = await self._adapter.evaluate(
            f"document.querySelector({json.dumps(selector)})?.outerHTML ?? null"
        )
        return result if isinstance(result, str) else None

    async def query_selector_all(self, selector: str) -> List[str]:
        result = await self._adapter.evaluate(f"""
            Array.from(document.querySelectorAll({json.dumps(selector)})).map(el => el.outerHTML)
        """)
        return result if isinstance(result, list) else []

    async def text_content(self, selector: str) -> Optional[str]:
        result = await self._adapter.evaluate(
            f"document.querySelector({json.dumps(selector)})?.textContent ?? null"
        )
        return result if isinstance(result, str) else None

    async def extract_fields(
        self,
        fields: Dict[str, Any],
    ) -> Dict[str, Optional[str]]:
        """Extract multiple fields from the page in a single call.

        Each key maps to a CSS selector string (returns trimmed textContent)
        or a dict ``{"selector": "...", "attribute": "..."}`` (returns the
        attribute value).

        Example::

            data = await page.extract_fields({
                "title": "#productTitle",
                "price": ".a-price .a-offscreen",
                "rating": "#acrPopover .a-icon-alt",
                "image": {"selector": "#main-image", "attribute": "src"},
            })
        """
        field_map = []
        for key, val in fields.items():
            if isinstance(val, str):
                field_map.append({"key": key, "selector": val, "attribute": None})
            else:
                field_map.append({
                    "key": key,
                    "selector": val["selector"],
                    "attribute": val["attribute"],
                })

        result = await self._adapter.evaluate(f"""
            (() => {{
                const fields = {json.dumps(field_map)};
                const result = {{}};
                for (const f of fields) {{
                    const el = document.querySelector(f.selector);
                    result[f.key] = el
                        ? (f.attribute ? el.getAttribute(f.attribute) : el.textContent?.trim()) ?? null
                        : null;
                }}
                return JSON.stringify(result);
            }})()
        """)

        if isinstance(result, str):
            return json.loads(result)
        return {}

    # -------------------------------------------------------------------
    # Internals
    # -------------------------------------------------------------------

    async def _get_element_center(self, selector: str) -> Dict[str, float]:
        result = await self._adapter.evaluate(f"""
            (function() {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return null;
                el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                const r = el.getBoundingClientRect();
                return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
            }})()
        """)
        if not result or not isinstance(result, dict):
            raise RuntimeError(f"Element not found: {selector}")
        return result

    def _set_adapter(self, adapter: ProtocolAdapter) -> None:
        """Replace the adapter (used during browser switching)."""
        self._adapter = adapter

    @staticmethod
    def _is_interstitial_content(html: str) -> bool:
        """Detect challenge interstitials that may auto-resolve."""
        if len(html) > 15_000:
            return False
        lower = html.lower()
        if any(kw in lower for kw in (
            "just a moment", "checking your browser",
            "please wait while we verify", "verifying the device",
            "available after verification", "ddos-guard",
            "challenge-platform", "px-captcha",
            "_cf_chl_opt", "managed_challenge",
            "datadome", "ak_bmsc", "please enable cookies",
        )):
            return True
        if len(html) < 5_000:
            if "loading..." in lower or "loading results" in lower:
                return True
            if "please wait" in lower and "article" not in lower:
                return True
        return False

    @staticmethod
    def _is_rate_limit_content(html: str) -> bool:
        """Detect site-level rate limiting in page content."""
        if len(html) > 20_000:
            return False
        lower = html.lower()
        return (
            "rate limit exceeded" in lower
            or "too many requests" in lower
            or ("rate limit" in lower and "please try again" in lower)
        )
