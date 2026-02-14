"""WebDriver BiDi session over the Spider WebSocket transport (Firefox)."""

from __future__ import annotations

import asyncio
import json
import math
from typing import Any

from .transport import Transport
from ..utils.errors import ProtocolError, TimeoutError
from ..utils.logger import logger

_CMD_TIMEOUT = 30.0


class BiDiSession:
    def __init__(self, transport: Transport, *, command_timeout: float = _CMD_TIMEOUT) -> None:
        self._transport = transport
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._event_handlers: dict[str, list] = {}
        self._browsing_context: str | None = None
        self._timeout = command_timeout

    @property
    def context(self) -> str | None:
        return self._browsing_context

    def handle_message(self, data: str) -> bool:
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            return False

        if isinstance(msg.get("id"), int) and "type" in msg:
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                fut.set_result(msg)
                return True
            return False

        if msg.get("type") == "event" and isinstance(msg.get("method"), str):
            params = msg.get("params", {})
            for h in list(self._event_handlers.get(msg["method"], [])):
                try:
                    h(params)
                except Exception:
                    pass
            return True

        return False

    async def send(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        cmd_id = self._next_id
        self._next_id += 1
        cmd = {"id": cmd_id, "method": method, "params": params}
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending[cmd_id] = fut
        await self._transport.send_async(json.dumps(cmd))
        try:
            return await asyncio.wait_for(fut, timeout=self._timeout)
        except asyncio.TimeoutError:
            self._pending.pop(cmd_id, None)
            raise TimeoutError(f"BiDi command timeout: {method} ({self._timeout}s)")

    def on(self, method: str, handler: Any) -> None:
        self._event_handlers.setdefault(method, []).append(handler)

    def off(self, method: str, handler: Any) -> None:
        try:
            self._event_handlers.get(method, []).remove(handler)
        except ValueError:
            pass

    # ------------------------------------------------------------------
    # Context management
    # ------------------------------------------------------------------

    async def get_or_create_context(self) -> str:
        if self._browsing_context:
            return self._browsing_context

        # Strategy 1: getTree with short timeout
        try:
            saved = self._timeout
            self._timeout = 5.0
            resp = await self.send("browsingContext.getTree", {})
            self._timeout = saved
            contexts = (resp.get("result") or {}).get("contexts", [])
            if contexts:
                self._browsing_context = contexts[0]["context"]
                return self._browsing_context
        except Exception:
            self._timeout = _CMD_TIMEOUT

        # Strategy 2: create
        try:
            saved = self._timeout
            self._timeout = 5.0
            cr = await self.send("browsingContext.create", {"type": "tab"})
            self._timeout = saved
            ctx = (cr.get("result") or {}).get("context")
            if ctx:
                self._browsing_context = ctx
                return self._browsing_context
        except Exception:
            self._timeout = _CMD_TIMEOUT

        # Strategy 3: placeholder — geckodriver already has one
        self._browsing_context = "__default__"
        return self._browsing_context

    # ------------------------------------------------------------------
    # High-level
    # ------------------------------------------------------------------

    async def navigate(self, url: str) -> None:
        ctx = await self.get_or_create_context()
        await self.send("browsingContext.navigate", {"context": ctx, "url": url, "wait": "complete"})

    async def capture_screenshot(self) -> str:
        ctx = await self.get_or_create_context()
        resp = await self.send("browsingContext.captureScreenshot", {"context": ctx})
        data = (resp.get("result") or {}).get("data")
        if not isinstance(data, str):
            raise ProtocolError("captureScreenshot: missing result.data")
        return data

    async def evaluate(self, expression: str) -> Any:
        ctx = await self.get_or_create_context()
        resp = await self.send("script.evaluate", {
            "expression": expression,
            "target": {"context": ctx},
            "awaitPromise": False,
            "resultOwnership": "none",
        })
        if resp.get("type") == "error":
            raise ProtocolError(f"BiDi script error: {resp.get('message') or resp.get('error')}")
        result_obj = (resp.get("result") or {}).get("result") or resp.get("result")
        return self._extract_bidi_value(result_obj)

    async def get_html(self) -> str:
        return await self.evaluate("document.documentElement.outerHTML")  # type: ignore

    async def perform_actions(self, actions: list[dict[str, Any]]) -> None:
        ctx = await self.get_or_create_context()
        await self.send("input.performActions", {"context": ctx, "actions": actions})

    async def click_point(self, x: float, y: float) -> None:
        await self.perform_actions([{
            "type": "pointer", "id": "mouse",
            "actions": [
                {"type": "pointerMove", "x": round(x), "y": round(y)},
                {"type": "pointerDown", "button": 0},
                {"type": "pointerUp", "button": 0},
            ],
        }])

    async def insert_text(self, text: str) -> None:
        actions = []
        for ch in text:
            actions.extend([{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}])
        await self.perform_actions([{"type": "key", "id": "keyboard", "actions": actions}])

    def destroy(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(Exception("session destroyed"))
        self._pending.clear()
        self._event_handlers.clear()

    # ------------------------------------------------------------------

    def _extract_bidi_value(self, rv: Any) -> Any:
        if not rv or not isinstance(rv, dict):
            return rv
        t = rv.get("type")
        if t in ("undefined",):
            return None
        if t == "null":
            return None
        if t in ("string", "number", "boolean", "bigint"):
            return rv.get("value")
        if t == "array" and isinstance(rv.get("value"), list):
            return [self._extract_bidi_value(v) for v in rv["value"]]
        if t == "object" and isinstance(rv.get("value"), list):
            obj: dict[str, Any] = {}
            for entry in rv["value"]:
                if isinstance(entry, list) and len(entry) == 2:
                    k = entry[0] if isinstance(entry[0], str) else (entry[0] or {}).get("value", str(entry[0]))
                    obj[k] = self._extract_bidi_value(entry[1])
            return obj
        return rv.get("value", rv)
