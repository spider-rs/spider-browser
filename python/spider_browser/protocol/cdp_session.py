"""CDP JSON-RPC session over the Spider WebSocket transport.

The server proxies to Chrome's BROWSER-LEVEL CDP target.
We must discover/create a page target, attach with flatten=True,
then scope all Page/Runtime/Input commands with the sessionId.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from .transport import Transport
from ..utils.errors import ProtocolError, TimeoutError
from ..utils.logger import logger

_CMD_TIMEOUT = 30.0


class CDPSession:
    def __init__(self, transport: Transport, *, command_timeout: float = _CMD_TIMEOUT) -> None:
        self._transport = transport
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._event_handlers: dict[str, list] = {}
        self._target_session_id: str | None = None
        self._timeout = command_timeout

    @property
    def session_id(self) -> str | None:
        return self._target_session_id

    # ------------------------------------------------------------------
    # Message routing
    # ------------------------------------------------------------------

    def handle_message(self, data: str) -> bool:
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            return False

        # Response
        if isinstance(msg.get("id"), int):
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                fut.set_result(msg)
                return True
            return False

        # Event
        method = msg.get("method")
        if isinstance(method, str):
            params = msg.get("params", {})
            for h in list(self._event_handlers.get(method, [])):
                try:
                    h(params)
                except Exception:
                    pass
            for h in list(self._event_handlers.get("*", [])):
                try:
                    h({"method": method, **params})
                except Exception:
                    pass
            return True

        return False

    # ------------------------------------------------------------------
    # Command sending
    # ------------------------------------------------------------------

    async def send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send a browser-level CDP command."""
        cmd_id = self._next_id
        self._next_id += 1
        cmd: dict[str, Any] = {"id": cmd_id, "method": method, "params": params or {}}

        fut: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending[cmd_id] = fut
        await self._transport.send_async(json.dumps(cmd))
        try:
            return await asyncio.wait_for(fut, timeout=self._timeout)
        except asyncio.TimeoutError:
            self._pending.pop(cmd_id, None)
            raise TimeoutError(f"CDP command timeout: {method} ({self._timeout}s)")

    async def send_to_target(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send a page-scoped CDP command (requires attachToPage first)."""
        if not self._target_session_id:
            raise ProtocolError("No target session — call attach_to_page() first")
        cmd_id = self._next_id
        self._next_id += 1
        cmd: dict[str, Any] = {
            "id": cmd_id,
            "method": method,
            "params": params or {},
            "sessionId": self._target_session_id,
        }
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending[cmd_id] = fut
        await self._transport.send_async(json.dumps(cmd))
        try:
            return await asyncio.wait_for(fut, timeout=self._timeout)
        except asyncio.TimeoutError:
            self._pending.pop(cmd_id, None)
            raise TimeoutError(f"CDP command timeout: {method} ({self._timeout}s)")

    def on(self, method: str, handler: Any) -> None:
        self._event_handlers.setdefault(method, []).append(handler)

    def off(self, method: str, handler: Any) -> None:
        try:
            self._event_handlers.get(method, []).remove(handler)
        except ValueError:
            pass

    # ------------------------------------------------------------------
    # Target management
    # ------------------------------------------------------------------

    async def attach_to_page(self) -> str:
        """Discover/create a page target, attach, enable domains."""
        await self.send("Target.setDiscoverTargets", {"discover": True})
        resp = await self.send("Target.getTargets")
        infos = (resp.get("result") or {}).get("targetInfos", [])

        target_id: str | None = None
        for t in infos:
            if t.get("type") == "page" and not (t.get("url") or "").startswith("devtools://"):
                target_id = t["targetId"]
                break

        if not target_id:
            cr = await self.send("Target.createTarget", {"url": "about:blank"})
            target_id = (cr.get("result") or {}).get("targetId")
            if not target_id:
                raise ProtocolError("Failed to create page target")

        attach_resp = await self.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        sid = (attach_resp.get("result") or {}).get("sessionId")

        if not sid:
            event_fut: asyncio.Future[str] = asyncio.get_event_loop().create_future()

            def _handler(params: dict[str, Any]) -> None:
                s = params.get("sessionId")
                if s and not event_fut.done():
                    event_fut.set_result(s)

            self.on("Target.attachedToTarget", _handler)
            try:
                sid = await asyncio.wait_for(event_fut, timeout=5.0)
            except asyncio.TimeoutError:
                raise TimeoutError("Timeout waiting for Target.attachedToTarget")
            finally:
                self.off("Target.attachedToTarget", _handler)

        self._target_session_id = sid
        logger.info(f"attached to page target target_id={target_id} session_id={sid}")

        await self.send_to_target("Page.enable")
        await self.send_to_target("Runtime.enable")
        return sid

    # ------------------------------------------------------------------
    # High-level CDP commands
    # ------------------------------------------------------------------

    async def capture_screenshot(self) -> str:
        resp = await self.send_to_target("Page.captureScreenshot", {"format": "png"})
        data = (resp.get("result") or {}).get("data")
        if not isinstance(data, str):
            raise ProtocolError("captureScreenshot: missing result.data")
        return data

    async def get_html(self) -> str:
        resp = await self.send_to_target("Runtime.evaluate", {
            "expression": "document.documentElement.outerHTML",
            "returnByValue": True,
        })
        return self._extract_eval_value(resp)  # type: ignore

    async def evaluate(self, expression: str) -> Any:
        resp = await self.send_to_target("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
        })
        return self._extract_eval_value(resp)

    async def navigate(self, url: str) -> None:
        load_event = self._wait_for_event("Page.loadEventFired", 8.0)
        stop_event = self._wait_for_event("Page.frameStoppedLoading", 10.0)
        resp = await self.send_to_target("Page.navigate", {"url": url})
        error_text = (resp.get("result") or {}).get("errorText")
        if error_text:
            load_event.cancel()
            stop_event.cancel()
            from ..utils.errors import NavigationError
            if self._is_retryable_nav_error(error_text):
                raise NavigationError(f"Navigation failed: {error_text}")
            raise ProtocolError(f"Navigation failed: {error_text}")
        loaded = await load_event
        if not loaded:
            await stop_event

    async def navigate_fast(self, url: str) -> None:
        """Navigate with 5s max wait for load event."""
        load_event = self._wait_for_event("Page.loadEventFired", 5.0)
        resp = await self.send_to_target("Page.navigate", {"url": url})
        error_text = (resp.get("result") or {}).get("errorText")
        if error_text:
            load_event.cancel()
            from ..utils.errors import NavigationError
            if self._is_retryable_nav_error(error_text):
                raise NavigationError(f"Navigation failed: {error_text}")
            raise ProtocolError(f"Navigation failed: {error_text}")
        await load_event

    async def navigate_dom(self, url: str) -> None:
        """Navigate and return on DOMContentLoaded (3s max)."""
        dom_event = self._wait_for_event("Page.domContentEventFired", 3.0)
        resp = await self.send_to_target("Page.navigate", {"url": url})
        error_text = (resp.get("result") or {}).get("errorText")
        if error_text:
            dom_event.cancel()
            from ..utils.errors import NavigationError
            if self._is_retryable_nav_error(error_text):
                raise NavigationError(f"Navigation failed: {error_text}")
            raise ProtocolError(f"Navigation failed: {error_text}")
        await dom_event

    async def click_point(self, x: float, y: float) -> None:
        await self._mouse("mouseMoved", x, y, "none", 0)
        await self._mouse("mousePressed", x, y, "left", 1)
        await self._mouse("mouseReleased", x, y, "left", 1)

    async def right_click_point(self, x: float, y: float) -> None:
        await self._mouse("mouseMoved", x, y, "none", 0)
        await self._mouse("mousePressed", x, y, "right", 1)
        await self._mouse("mouseReleased", x, y, "right", 1)

    async def double_click_point(self, x: float, y: float) -> None:
        await self._mouse("mouseMoved", x, y, "none", 0)
        await self._mouse("mousePressed", x, y, "left", 1)
        await self._mouse("mouseReleased", x, y, "left", 1)
        await self._mouse("mousePressed", x, y, "left", 2)
        await self._mouse("mouseReleased", x, y, "left", 2)

    async def click_hold_point(self, x: float, y: float, hold_ms: int) -> None:
        await self._mouse("mouseMoved", x, y, "none", 0)
        await self._mouse("mousePressed", x, y, "left", 1)
        await asyncio.sleep(hold_ms / 1000)
        await self._mouse("mouseReleased", x, y, "left", 1)

    async def hover_point(self, x: float, y: float) -> None:
        await self._mouse("mouseMoved", x, y, "none", 0)

    async def drag_point(self, fx: float, fy: float, tx: float, ty: float) -> None:
        steps = 10
        await self._mouse("mouseMoved", fx, fy, "none", 0)
        await self._mouse("mousePressed", fx, fy, "left", 1)
        for i in range(1, steps + 1):
            t = i / steps
            await self._mouse("mouseMoved", fx + (tx - fx) * t, fy + (ty - fy) * t, "left", 0)
            await asyncio.sleep(0.016)
        await self._mouse("mouseReleased", tx, ty, "left", 1)

    async def insert_text(self, text: str) -> None:
        await self.send_to_target("Input.insertText", {"text": text})

    async def press_key(self, key: str, code: str, key_code: int) -> None:
        await self.send_to_target("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code, "text": key,
        })
        await self.send_to_target("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code,
        })

    async def key_down(self, key: str, code: str, key_code: int) -> None:
        await self.send_to_target("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code, "text": key,
        })

    async def key_up(self, key: str, code: str, key_code: int) -> None:
        await self.send_to_target("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": key, "code": code,
            "windowsVirtualKeyCode": key_code,
        })

    async def set_viewport(self, w: int, h: int, dpr: float = 2.0, mobile: bool = False) -> None:
        await self.send_to_target("Emulation.setDeviceMetricsOverride", {
            "width": w, "height": h, "deviceScaleFactor": dpr, "mobile": mobile,
        })

    def destroy(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(Exception("session destroyed"))
        self._pending.clear()
        self._event_handlers.clear()

    # ------------------------------------------------------------------

    def _wait_for_event(self, method: str, timeout_s: float) -> asyncio.Task[bool]:
        """Wait for a CDP event with timeout. Returns a Task that resolves to True if event fired."""
        fut: asyncio.Future[bool] = asyncio.get_event_loop().create_future()

        def _handler(_params: Any) -> None:
            if not fut.done():
                fut.set_result(True)
            self.off(method, _handler)

        self.on(method, _handler)

        async def _wait() -> bool:
            try:
                return await asyncio.wait_for(asyncio.shield(fut), timeout=timeout_s)
            except asyncio.TimeoutError:
                self.off(method, _handler)
                if not fut.done():
                    fut.set_result(False)
                return False
            except asyncio.CancelledError:
                self.off(method, _handler)
                return False

        return asyncio.get_event_loop().create_task(_wait())

    @staticmethod
    def _is_retryable_nav_error(error_text: str) -> bool:
        retryable = [
            "ERR_ABORTED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED",
            "ERR_EMPTY_RESPONSE", "ERR_BLOCKED_BY_CLIENT",
            "ERR_SSL_PROTOCOL_ERROR", "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
        ]
        return any(e in error_text for e in retryable)

    async def _mouse(self, typ: str, x: float, y: float, button: str, click: int) -> None:
        await self.send_to_target("Input.dispatchMouseEvent", {
            "type": typ, "x": x, "y": y, "button": button, "clickCount": click,
        })

    def _extract_eval_value(self, resp: dict[str, Any]) -> Any:
        err = resp.get("error")
        if err:
            raise ProtocolError(f"CDP error: {err.get('message', err)}")
        r = resp.get("result", {})
        return r.get("result", {}).get("value")
