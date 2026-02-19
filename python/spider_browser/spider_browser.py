"""SpiderBrowser — main entry point for spider-browser Python client."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, List, Literal, Optional, TypeVar

from .protocol.transport import Transport
from .protocol.protocol_adapter import ProtocolAdapter
from .events.emitter import SpiderEventEmitter
from .events.types import BrowserType
from .page import SpiderPage
from .retry.retry_engine import RetryEngine, RetryContext
from .ai.llm_provider import LLMConfig, LLMProvider, create_provider
from .ai.act import act
from .ai.observe import observe, ObserveResult
from .ai.extract import extract
from .ai.agent import Agent, AgentOptions, AgentResult
from .utils.logger import logger, set_level

T = TypeVar("T")


@dataclass
class SpiderBrowserOptions:
    """Configuration for SpiderBrowser."""

    api_key: str
    server_url: str = "wss://browser.spider.cloud"
    browser: BrowserType = "auto"
    url: Optional[str] = None
    captcha: Literal["off", "detect", "solve"] = "solve"
    smart_retry: bool = True
    max_retries: int = 12
    stealth: int = 0
    max_stealth_levels: int = 3
    log_level: Optional[str] = None
    connect_timeout_ms: int = 30_000
    command_timeout_ms: int = 30_000
    retry_timeout_ms: int = 15_000
    hedge: bool = False
    record: bool = False
    mode: Optional[str] = None  # 'scraping' or 'cua'
    country: Optional[str] = None
    proxy_url: Optional[str] = None
    llm: Optional[LLMConfig] = None


class SpiderBrowser:
    """
    Main entry point for spider-browser.

    Connects to Spider's pre-warmed browser fleet via WebSocket.
    Provides deterministic page control (via SpiderPage) and
    AI-powered automation (act, observe, extract, agent).

    Key features:
    - Pre-warmed browsers (no cold start)
    - Full stealth Chrome & Firefox
    - Smart retry with automatic browser switching
    - CDP (Chrome/Servo/LightPanda) + BiDi (Firefox) protocol support
    """

    def __init__(self, options: SpiderBrowserOptions) -> None:
        self._opts = options
        self._transport: Optional[Transport] = None
        self._adapter: Optional[ProtocolAdapter] = None
        self._retry_engine: Optional[RetryEngine] = None
        self._emitter = SpiderEventEmitter()
        self._page: Optional[SpiderPage] = None
        self._llm_provider: Optional[LLMProvider] = None
        self._current_url: Optional[str] = options.url

        if options.log_level:
            set_level(options.log_level)

        if options.llm:
            self._llm_provider = create_provider(options.llm)

    @property
    def page(self) -> SpiderPage:
        """The active page instance for deterministic browser control."""
        if not self._page:
            raise RuntimeError("SpiderBrowser not initialized. Call init() first.")
        return self._page

    @property
    def browser(self) -> BrowserType:
        """Current browser type."""
        if self._transport:
            return self._transport.browser
        return self._opts.browser

    @property
    def connected(self) -> bool:
        return self._transport.connected if self._transport else False

    @property
    def stealth_level(self) -> int:
        """Active stealth level (0=auto, 1-3=explicit tiers)."""
        if self._retry_engine:
            return self._retry_engine.stealth_level
        if self._transport:
            return self._transport.stealth_level
        return self._opts.stealth

    @property
    def credits(self) -> Optional[float]:
        """Credits remaining from last upgrade response."""
        return self._transport.upgrade_credits if self._transport else None

    @property
    def session_credits_used(self) -> Optional[float]:
        """Credits consumed during this session (from server Spider.metering event)."""
        return self._transport.session_credits_used if self._transport else None

    async def get_session_credits(self) -> float:
        """Request the exact session cost from the server.
        Unlike session_credits_used (which relies on async event delivery),
        this sends a Spider.getMetering command and waits for the response.
        Call this before close() for accurate per-session metering.
        """
        if not self._transport:
            return 0
        return await self._transport.request_metering()

    def on(self, event: str, handler: Any) -> "SpiderBrowser":
        """Subscribe to events."""
        self._emitter.on(event, handler)
        return self

    def off(self, event: str, handler: Any) -> "SpiderBrowser":
        """Unsubscribe from events."""
        self._emitter.off(event, handler)
        return self

    def once(self, event: str, handler: Any) -> "SpiderBrowser":
        """Subscribe to an event once."""
        self._emitter.once(event, handler)
        return self

    async def init(self) -> None:
        """Connect to the browser server WebSocket and initialize the protocol."""
        self._transport = Transport(
            api_key=self._opts.api_key,
            server_url=self._opts.server_url,
            browser=self._opts.browser,
            url=self._opts.url,
            captcha=self._opts.captcha,
            stealth=self._opts.stealth,
            record=self._opts.record,
            mode=self._opts.mode,
            hedge=self._opts.hedge,
            country=self._opts.country,
            proxy_url=self._opts.proxy_url,
            connect_timeout_ms=self._opts.connect_timeout_ms,
            command_timeout_ms=self._opts.command_timeout_ms,
            emitter=self._emitter,
        )
        await self._transport.connect()

        active_browser = self._transport.browser
        self._adapter = ProtocolAdapter(
            self._transport,
            self._emitter,
            active_browser,
            command_timeout_ms=self._opts.command_timeout_ms,
        )
        await self._adapter.init()

        self._page = SpiderPage(self._adapter)

        if self._opts.smart_retry:
            self._retry_engine = RetryEngine(
                max_retries=self._opts.max_retries,
                emitter=self._emitter,
                retry_timeout_ms=self._opts.retry_timeout_ms,
                command_timeout_ms=self._opts.command_timeout_ms,
                max_stealth_level=self._opts.max_stealth_levels,
                initial_stealth=self._opts.stealth,
            )

        self._current_url = self._opts.url
        logger.info(f"SpiderBrowser initialized (browser={active_browser})")

    async def with_retry(self, fn: Callable[[], Awaitable[T]]) -> T:
        """Execute with smart retry and browser switching."""
        if not self._retry_engine or not self._transport or not self._adapter:
            return await fn()

        ctx = RetryContext(
            transport=self._transport,
            adapter=self._adapter,
            current_url=self._current_url,
            on_adapter_changed=self._on_adapter_changed,
        )
        return await self._retry_engine.execute(fn, ctx)

    # -------------------------------------------------------------------
    # Navigation (with retry)
    # -------------------------------------------------------------------

    async def goto(self, url: str) -> None:
        """Navigate to a URL with smart retry.

        On ERR_ABORTED: closes the WebSocket, reconnects, and retries.
        On bot detection: switches to a different browser and retries.
        Also updates current_url for subsequent retries on other operations.
        """
        self._current_url = url
        await self.with_retry(lambda: self._page.goto(url))  # type: ignore

    # -------------------------------------------------------------------
    # AI Methods (require LLM config)
    # -------------------------------------------------------------------

    async def act(self, instruction: str) -> None:
        """Execute a single action from natural language."""
        self._require_llm()
        await self.with_retry(lambda: act(self._adapter, self._llm_provider, instruction))  # type: ignore

    async def observe(self, instruction: Optional[str] = None) -> List[ObserveResult]:
        """Discover interactive elements on the page."""
        return await self.with_retry(
            lambda: observe(self._adapter, instruction, self._llm_provider)  # type: ignore
        )

    async def extract(self, instruction: str, schema: Any = None) -> Any:
        """Extract structured data from the page."""
        self._require_llm()
        return await self.with_retry(
            lambda: extract(self._adapter, self._llm_provider, instruction, schema)  # type: ignore
        )

    def agent(self, options: Optional[AgentOptions] = None) -> Agent:
        """Create an autonomous agent for multi-step tasks."""
        self._require_llm()
        return Agent(self._adapter, self._llm_provider, self._emitter, options)  # type: ignore

    async def close(self) -> None:
        """Close the connection and clean up resources.

        Disconnects the WebSocket. The server automatically handles page/target
        cleanup on disconnect (disposes browser contexts, closes orphaned targets,
        deletes backend sessions). The browser process itself is NOT closed —
        it's pre-warmed and shared.
        """
        if self._adapter:
            self._adapter.destroy()
        if self._transport:
            await self._transport.close()
        self._emitter.remove_all_listeners()
        self._page = None
        self._adapter = None
        self._transport = None
        logger.info("SpiderBrowser closed")

    # -------------------------------------------------------------------
    # Context manager
    # -------------------------------------------------------------------

    async def __aenter__(self) -> "SpiderBrowser":
        await self.init()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    # -------------------------------------------------------------------
    # Internal
    # -------------------------------------------------------------------

    def _on_adapter_changed(self, new_adapter: ProtocolAdapter) -> None:
        self._adapter = new_adapter
        if self._page:
            self._page._set_adapter(new_adapter)

    def _require_llm(self) -> None:
        if not self._llm_provider:
            raise RuntimeError(
                "LLM not configured. Pass `llm` option to SpiderBrowserOptions for AI methods."
            )
