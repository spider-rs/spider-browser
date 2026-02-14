"""Unified protocol interface wrapping CDP or BiDi based on browser type."""

from __future__ import annotations

import asyncio
import math
from typing import Any, Optional

from .transport import Transport
from .cdp_session import CDPSession
from .bidi_session import BiDiSession
from ..events.emitter import SpiderEventEmitter
from ..events.types import BrowserType
from .types import get_key_params
from ..utils.logger import logger


class ProtocolAdapter:
    """
    Unified interface over CDP and BiDi.

    - chrome, chrome-h, servo, lightpanda -> CDP
    - firefox -> BiDi
    - auto -> tries CDP first, falls back to BiDi
    """

    def __init__(
        self,
        transport: Transport,
        emitter: SpiderEventEmitter,
        browser: BrowserType,
        *,
        command_timeout_ms: Optional[int] = None,
    ) -> None:
        self._transport = transport
        self._emitter = emitter
        self._protocol: str = "auto" if browser == "auto" else ("bidi" if browser == "firefox" else "cdp")
        self._cdp: Optional[CDPSession] = None
        self._bidi: Optional[BiDiSession] = None
        self._command_timeout_ms = command_timeout_ms

        timeout_s = (command_timeout_ms / 1000) if command_timeout_ms else 30.0

        if self._protocol == "cdp":
            self._cdp = CDPSession(transport, command_timeout=timeout_s)
        elif self._protocol == "bidi":
            self._bidi = BiDiSession(transport, command_timeout=timeout_s)
        # 'auto' defers creation to init()

        transport.on_message(self._route_message)

    @property
    def protocol_type(self) -> str:
        return self._protocol

    async def init(self) -> None:
        if self._protocol == "auto":
            await self._auto_detect_and_init()
            return
        if self._cdp:
            await self._cdp.attach_to_page()
        elif self._bidi:
            await self._bidi.get_or_create_context()

    # ------------------------------------------------------------------
    # Unified interface
    # ------------------------------------------------------------------

    async def navigate(self, url: str) -> None:
        if self._cdp:
            await self._cdp.navigate(url)
        else:
            await self._bidi.navigate(url)  # type: ignore

    async def navigate_fast(self, url: str) -> None:
        """Navigate with 5s max wait — for use with polling content extraction."""
        if self._cdp:
            await self._cdp.navigate_fast(url)
        else:
            await self._bidi.navigate(url)  # type: ignore  # BiDi doesn't support fast nav

    async def navigate_dom(self, url: str) -> None:
        """Navigate and return on DOMContentLoaded (3s max) — fastest option for SPAs."""
        if self._cdp:
            await self._cdp.navigate_dom(url)
        else:
            await self._bidi.navigate(url)  # type: ignore  # BiDi doesn't support DOM nav

    async def get_html(self) -> str:
        if self._cdp:
            return await self._cdp.get_html()
        return await self._bidi.get_html()  # type: ignore

    async def evaluate(self, expression: str) -> Any:
        if self._cdp:
            return await self._cdp.evaluate(expression)
        return await self._bidi.evaluate(expression)  # type: ignore

    async def capture_screenshot(self) -> str:
        if self._cdp:
            return await self._cdp.capture_screenshot()
        return await self._bidi.capture_screenshot()  # type: ignore

    async def click_point(self, x: float, y: float) -> None:
        if self._cdp:
            await self._cdp.click_point(x, y)
        else:
            await self._bidi.click_point(x, y)  # type: ignore

    async def right_click_point(self, x: float, y: float) -> None:
        if self._cdp:
            await self._cdp.right_click_point(x, y)
        else:
            await self._bidi.perform_actions([{  # type: ignore
                "type": "pointer", "id": "mouse",
                "actions": [
                    {"type": "pointerMove", "x": round(x), "y": round(y)},
                    {"type": "pointerDown", "button": 2},
                    {"type": "pointerUp", "button": 2},
                ],
            }])

    async def double_click_point(self, x: float, y: float) -> None:
        if self._cdp:
            await self._cdp.double_click_point(x, y)
        else:
            await self._bidi.perform_actions([{  # type: ignore
                "type": "pointer", "id": "mouse",
                "actions": [
                    {"type": "pointerMove", "x": round(x), "y": round(y)},
                    {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
                    {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
                ],
            }])

    async def click_hold_point(self, x: float, y: float, hold_ms: int) -> None:
        if self._cdp:
            await self._cdp.click_hold_point(x, y, hold_ms)
        else:
            await self._bidi.perform_actions([{  # type: ignore
                "type": "pointer", "id": "mouse",
                "actions": [
                    {"type": "pointerMove", "x": round(x), "y": round(y)},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pause", "duration": hold_ms},
                    {"type": "pointerUp", "button": 0},
                ],
            }])

    async def hover_point(self, x: float, y: float) -> None:
        if self._cdp:
            await self._cdp.hover_point(x, y)
        else:
            await self._bidi.perform_actions([{  # type: ignore
                "type": "pointer", "id": "mouse",
                "actions": [{"type": "pointerMove", "x": round(x), "y": round(y)}],
            }])

    async def drag_point(self, fx: float, fy: float, tx: float, ty: float) -> None:
        if self._cdp:
            await self._cdp.drag_point(fx, fy, tx, ty)
        else:
            steps = 10
            actions: list[dict[str, Any]] = [
                {"type": "pointerMove", "x": round(fx), "y": round(fy)},
                {"type": "pointerDown", "button": 0},
            ]
            for i in range(1, steps + 1):
                t = i / steps
                actions.append({
                    "type": "pointerMove",
                    "x": round(fx + (tx - fx) * t),
                    "y": round(fy + (ty - fy) * t),
                    "duration": 16,
                })
            actions.append({"type": "pointerUp", "button": 0})
            await self._bidi.perform_actions([{"type": "pointer", "id": "mouse", "actions": actions}])  # type: ignore

    async def insert_text(self, text: str) -> None:
        if self._cdp:
            await self._cdp.insert_text(text)
        else:
            await self._bidi.insert_text(text)  # type: ignore

    async def press_key(self, key_name: str) -> None:
        key, code, kc = get_key_params(key_name)
        if self._cdp:
            await self._cdp.press_key(key, code, kc)
        else:
            await self._bidi.perform_actions([{  # type: ignore
                "type": "key", "id": "keyboard",
                "actions": [{"type": "keyDown", "value": key}, {"type": "keyUp", "value": key}],
            }])

    async def key_down(self, key_name: str) -> None:
        key, code, kc = get_key_params(key_name)
        if self._cdp:
            await self._cdp.key_down(key, code, kc)
        else:
            await self._bidi.perform_actions([{  # type: ignore
                "type": "key", "id": "keyboard",
                "actions": [{"type": "keyDown", "value": key}],
            }])

    async def key_up(self, key_name: str) -> None:
        key, code, kc = get_key_params(key_name)
        if self._cdp:
            await self._cdp.key_up(key, code, kc)
        else:
            await self._bidi.perform_actions([{  # type: ignore
                "type": "key", "id": "keyboard",
                "actions": [{"type": "keyUp", "value": key}],
            }])

    async def set_viewport(self, w: int, h: int, dpr: float = 2.0, mobile: bool = False) -> None:
        if self._cdp:
            await self._cdp.set_viewport(w, h, dpr, mobile)
        else:
            await self._bidi.evaluate(f"window.resizeTo({w},{h})")  # type: ignore

    def on_protocol_event(self, method: str, handler: Any) -> None:
        """Subscribe to a CDP/BiDi protocol event."""
        if self._cdp:
            self._cdp.on(method, handler)
        elif self._bidi:
            self._bidi.on(method, handler)

    def destroy(self) -> None:
        cdp = self._cdp
        bidi = self._bidi
        self._cdp = None
        self._bidi = None
        if cdp:
            cdp.destroy()
        if bidi:
            bidi.destroy()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _route_message(self, data: str) -> None:
        try:
            msg = __import__("json").loads(data)
            method = msg.get("method")
            if isinstance(method, str) and method.startswith("Spider."):
                self._handle_spider_event(method, msg.get("params", {}))
                return
        except Exception:
            pass
        if self._cdp:
            self._cdp.handle_message(data)
        elif self._bidi:
            self._bidi.handle_message(data)

    def _handle_spider_event(self, method: str, params: dict[str, Any]) -> None:
        event_map = {
            "Spider.captchaDetected": "captcha.detected",
            "Spider.captchaSolving": "captcha.solving",
            "Spider.captchaSolved": "captcha.solved",
            "Spider.captchaFailed": "captcha.failed",
        }
        mapped = event_map.get(method)
        if mapped:
            self._emitter.emit(mapped, params)

    async def _auto_detect_and_init(self) -> None:
        timeout_s = (self._command_timeout_ms / 1000) if self._command_timeout_ms else 30.0

        try:
            self._cdp = CDPSession(self._transport, command_timeout=timeout_s)
            self._transport.on_message(self._route_message)
            await self._cdp.attach_to_page()
            self._protocol = "cdp"
            logger.info("auto-detected CDP protocol")
            return
        except Exception:
            if self._cdp:
                self._cdp.destroy()
            self._cdp = None

        self._bidi = BiDiSession(self._transport, command_timeout=timeout_s)
        self._transport.on_message(self._route_message)
        await self._bidi.get_or_create_context()
        self._protocol = "bidi"
        logger.info("auto-detected BiDi protocol")
