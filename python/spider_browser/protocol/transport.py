"""WebSocket transport to Spider's browser fleet."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Optional
from urllib.parse import urlencode

import websockets
import websockets.client

from ..events.emitter import SpiderEventEmitter
from ..events.types import BrowserType
from ..utils.errors import ConnectionError, AuthError, BackendUnavailableError, RateLimitError, TimeoutError
from ..utils.logger import logger


class Transport:
    """
    WebSocket transport to Spider's browser fleet.

    Connects to ``wss://browser.spider.cloud/v1/browser?token=TOKEN&browser=TYPE``,
    handles reconnection on browser switch, and dispatches raw messages.
    """

    def __init__(
        self,
        *,
        api_key: str,
        server_url: str,
        browser: BrowserType,
        url: Optional[str] = None,
        captcha: str = "solve",
        stealth: int = 0,
        record: bool = False,
        mode: Optional[str] = None,
        hedge: bool = False,
        country: Optional[str] = None,
        proxy_url: Optional[str] = None,
        connect_timeout_ms: int = 30_000,
        command_timeout_ms: int = 30_000,
        emitter: SpiderEventEmitter,
    ) -> None:
        self._api_key = api_key
        self._server_url = server_url.rstrip("/")
        self._current_browser: BrowserType = "chrome-h" if browser == "auto" else browser
        self._url = url
        self._captcha = captcha
        self._stealth_level = stealth
        self._record = record
        self._mode = mode
        self._hedge = hedge
        self._country = country
        self._proxy_url = proxy_url
        self._connect_timeout_ms = connect_timeout_ms
        self._command_timeout_ms = command_timeout_ms
        self._emitter = emitter
        self._ws: Optional[websockets.client.WebSocketClientProtocol] = None
        self._message_handler: Optional[Callable[[str], None]] = None
        self._recv_task: Optional[asyncio.Task[None]] = None
        self._generation = 0

        # Upgrade response headers
        self._upgrade_credits: Optional[float] = None
        self._upgrade_stealth_tier: Optional[int] = None
        self._upgrade_proxy_tier: Optional[int] = None
        # Session metering
        self._session_credits_used: Optional[float] = None

    @property
    def browser(self) -> BrowserType:
        return self._current_browser

    @property
    def connected(self) -> bool:
        return self._ws is not None and self._ws.open

    @property
    def stealth_level(self) -> int:
        return self._stealth_level

    @stealth_level.setter
    def stealth_level(self, level: int) -> None:
        self._stealth_level = max(0, min(3, level))

    @property
    def upgrade_credits(self) -> Optional[float]:
        """Credits remaining from the WebSocket upgrade response."""
        return self._upgrade_credits

    @property
    def upgrade_stealth_tier(self) -> Optional[int]:
        """Active stealth tier from the WebSocket upgrade response."""
        return self._upgrade_stealth_tier

    @property
    def upgrade_proxy_tier(self) -> Optional[int]:
        """Proxy tier bucket from the WebSocket upgrade response (1=cheap, 2=mid, 3=strong)."""
        return self._upgrade_proxy_tier

    @property
    def session_credits_used(self) -> Optional[float]:
        """Credits consumed during this session (from server Spider.metering event)."""
        return self._session_credits_used

    @property
    def command_timeout_ms(self) -> int:
        return self._command_timeout_ms

    async def request_metering(self, timeout_ms: int = 3000) -> float:
        """Request the current session cost from the server via Spider.getMetering."""
        if not self._ws or not self._ws.open:
            return self._session_credits_used or 0

        metering_id = 2147483640  # High ID to avoid collisions

        fut: asyncio.Future[float] = asyncio.get_event_loop().create_future()
        orig_handler = self._message_handler

        def _intercept(data: str) -> None:
            if f'"id":{metering_id}' in data:
                try:
                    msg = json.loads(data)
                    if msg.get("id") == metering_id and msg.get("result", {}).get("credits_used") is not None:
                        self._session_credits_used = msg["result"]["credits_used"]
                        self._message_handler = orig_handler
                        if not fut.done():
                            fut.set_result(msg["result"]["credits_used"])
                        return
                except Exception:
                    pass
            if orig_handler:
                orig_handler(data)

        self._message_handler = _intercept

        try:
            await self.send_async(json.dumps({"id": metering_id, "method": "Spider.getMetering"}))
            return await asyncio.wait_for(fut, timeout=timeout_ms / 1000)
        except (asyncio.TimeoutError, Exception):
            self._message_handler = orig_handler
            return self._session_credits_used or 0

    def on_message(self, handler: Callable[[str], None]) -> None:
        self._message_handler = handler

    async def connect(self, max_attempts: int = 3) -> None:
        """Connect to the WebSocket endpoint with retry."""
        if self._ws and self._ws.open:
            return

        last_error: Optional[Exception] = None
        for attempt in range(1, max_attempts + 1):
            try:
                await self._connect_internal()
                return
            except AuthError:
                raise
            except Exception as exc:
                last_error = exc
                if attempt < max_attempts:
                    backoff = 0.5 * attempt
                    logger.warning(
                        f"connect attempt {attempt}/{max_attempts} failed, retrying in {backoff}s: {exc}"
                    )
                    await asyncio.sleep(backoff)
        raise last_error  # type: ignore

    async def reconnect(self, browser: BrowserType) -> None:
        prev = self._current_browser
        self._current_browser = browser
        await self.close()
        logger.info(f"switching browser: {prev} -> {browser}")
        await self._connect_internal()

    def send(self, data: str) -> None:
        if not self._ws or not self._ws.open:
            raise ConnectionError("WebSocket is not connected")
        asyncio.get_event_loop().create_task(self._ws.send(data))

    async def send_async(self, data: str) -> None:
        if not self._ws or not self._ws.open:
            raise ConnectionError("WebSocket is not connected")
        await self._ws.send(data)

    async def close(self) -> None:
        if self._recv_task:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):
                pass
            self._recv_task = None
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    def _build_url(self) -> str:
        params: dict[str, str] = {"token": self._api_key}
        if self._current_browser != "auto":
            params["browser"] = self._current_browser
        if self._url:
            params["url"] = self._url
        if self._captcha and self._captcha != "off":
            params["ai_captcha"] = self._captcha
        if self._stealth_level > 0:
            params["s"] = str(self._stealth_level)
        if self._hedge:
            params["hedge"] = "true"
        if self._record:
            params["record"] = "true"
        if self._mode:
            params["mode"] = self._mode
        if self._country:
            params["country"] = self._country
        if self._proxy_url:
            params["proxy_url"] = self._proxy_url
        return f"{self._server_url}/v1/browser?{urlencode(params)}"

    async def _connect_internal(self) -> None:
        self._generation += 1
        gen = self._generation

        url = self._build_url()
        safe_url = url.split("token=")[0] + "token=***"
        logger.debug(f"connecting to {safe_url}")

        timeout_s = self._connect_timeout_ms / 1000

        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(url, max_size=50 * 1024 * 1024, open_timeout=timeout_s),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            raise TimeoutError(f"WebSocket connection timeout ({self._connect_timeout_ms}ms)")
        except Exception as exc:
            msg = str(exc)
            if "429" in msg:
                raise RateLimitError("Server at capacity (429)")
            raise ConnectionError(f"WebSocket error: {exc}")

        self._emitter.emit("ws.open")
        logger.info(f"connected (browser={self._current_browser}, stealth={self._stealth_level})")
        self._recv_task = asyncio.get_event_loop().create_task(self._recv_loop(gen))

    async def _recv_loop(self, gen: int) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                # Guard: ignore messages from stale WebSocket instances
                if gen != self._generation:
                    return
                msg = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")

                # Intercept Spider.* events from the server
                if '"Spider.' in msg:
                    if self._handle_spider_transport_event(msg):
                        continue

                if self._message_handler:
                    self._message_handler(msg)
        except websockets.exceptions.ConnectionClosedError as exc:
            if gen == self._generation:
                code = exc.code
                reason = str(exc.reason)
                self._emitter.emit("ws.close", {"code": code, "reason": reason})
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            if gen == self._generation:
                self._emitter.emit("ws.error", {"error": str(exc)})

    def _handle_spider_transport_event(self, data: str) -> bool:
        """Handle Spider.* events at the transport level. Returns True if consumed."""
        try:
            msg = json.loads(data)
            method = msg.get("method")
            params = msg.get("params", {})

            if method == "Spider.screencastFrame":
                self._emitter.emit("screencast.frame", params)
                return True
            if method == "Spider.interactionEvents":
                self._emitter.emit("screencast.interactionEvents", params)
                return True
            if method == "Spider.rrwebEvents":
                self._emitter.emit("screencast.rrwebEvents", params)
                return True
            if method == "Spider.recordingStarted":
                self._emitter.emit("recording.started", params)
                return True
            if method == "Spider.recordingCompleted":
                self._emitter.emit("recording.completed", params)
                return True
            if method == "Spider.metering":
                credits_used = params.get("credits_used")
                if credits_used is not None:
                    self._session_credits_used = credits_used
                    self._emitter.emit("metering", {
                        "credits": self._upgrade_credits or 0,
                        "rate": self._upgrade_stealth_tier or 0,
                        "session_credits_used": credits_used,
                    })
                    return True
        except Exception:
            pass
        return False
