"""Smart retry engine with tiered browser switching and stealth escalation."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Set, TypeVar, Tuple
from urllib.parse import urlparse

from ..protocol.transport import Transport
from ..protocol.protocol_adapter import ProtocolAdapter
from ..events.emitter import SpiderEventEmitter
from ..events.types import BrowserType
from ..utils.errors import (
    AuthError,
    RateLimitError,
    BlockedError,
    BackendUnavailableError,
    TimeoutError,
    ConnectionError,
    NavigationError,
)
from ..utils.logger import logger
from .browser_selector import (
    BrowserSelector,
    BROWSER_ROTATION,
    PRIMARY_ROTATION,
    EXTENDED_ROTATION,
)
from .failure_tracker import FailureTracker

T = TypeVar("T")

ErrorClass = str  # "transient" | "blocked" | "backend_down" | "auth" | "rate_limit"


@dataclass
class RetryContext:
    transport: Transport
    adapter: ProtocolAdapter
    current_url: Optional[str]
    on_adapter_changed: Callable[[ProtocolAdapter], None]


class RetryEngine:
    """
    Smart retry with tiered browser rotation and stealth escalation.

    Two-tier rotation strategy:

    - **Tier 1 (Primary)**: Chrome variants [chrome, chrome-new, chrome-h]
      Used for ALL error types. Each browser gets up to 2 transient retries.

    - **Tier 2 (Extended)**: Non-Chrome engines [firefox, lightpanda, servo]
      Used ONLY for ``blocked`` errors. Single attempt, no transient retries.

    Error classification (mirrors server hints.rs):
    - WS close 1006/1011       → transient → retry same browser up to 2x
    - blocked / 403 / captcha  → blocked → next primary, then extended
    - timeout                  → transient → retry same browser up to 2x
    - 401 / 402                → auth → throw immediately
    - 429                      → rate_limit → wait + retry same browser
    - backend unavailable      → mark down, skip browser
    """

    def __init__(
        self,
        max_retries: int,
        emitter: SpiderEventEmitter,
        *,
        retry_timeout_ms: int = 15_000,
        command_timeout_ms: int = 30_000,
        max_stealth_level: int = 3,
        initial_stealth: int = 0,
    ) -> None:
        self._max_retries = max_retries
        self._emitter = emitter
        self._selector = BrowserSelector(FailureTracker())
        self._retry_timeout_ms = retry_timeout_ms
        self._command_timeout_ms = command_timeout_ms
        self._current_stealth = initial_stealth
        self._max_stealth = max_stealth_level
        self._down_backends: Set[BrowserType] = set()

    @property
    def stealth_level(self) -> int:
        return self._current_stealth

    async def execute(self, fn: Callable[[], Awaitable[T]], ctx: RetryContext) -> T:
        """Execute an action with smart tiered retry across browsers and stealth levels."""
        last_error: Optional[Exception] = None
        total_attempts = 0
        budget = self._max_retries + 1
        self._down_backends.clear()
        was_blocked = False
        consecutive_disconnects = 0
        primary_disconnects = 0

        stealth_levels = self._get_stealth_progression()
        initial_browser = ctx.transport.browser

        for si, stealth in enumerate(stealth_levels):
            if total_attempts >= budget:
                break

            # Stealth escalation (skip for first level)
            if si > 0:
                prev = stealth_levels[si - 1]
                self._current_stealth = stealth
                ctx.transport.stealth_level = stealth

                logger.info(f"retry: escalating stealth {prev} -> {stealth}")
                self._emitter.emit("stealth.escalated", {
                    "from": prev,
                    "to": stealth,
                    "reason": self._classify_error(last_error) if last_error else "exhausted",
                })

                domain = self._extract_domain(ctx.current_url)
                if domain:
                    self._selector.failure_tracker.clear(domain)

            # Phase 1: Try PRIMARY browsers (Chrome variants)
            primary_browsers = (
                self._ordered_primary_browsers(initial_browser)
                if si == 0
                else list(PRIMARY_ROTATION)
            )

            tried_any = False

            for browser in primary_browsers:
                if total_attempts >= budget:
                    break
                if browser in self._down_backends:
                    continue

                # If 3+ consecutive WS disconnects, server is overloaded — stop
                if consecutive_disconnects >= 3:
                    logger.warning("retry: 3+ consecutive disconnects, server overloaded — aborting")
                    break

                success, value, total_attempts, tried, err = await self._try_browser(
                    fn, ctx, browser, stealth, total_attempts, budget,
                    allow_transient_retries=True,
                )
                if tried:
                    tried_any = True
                if success:
                    consecutive_disconnects = 0
                    return value  # type: ignore[return-value]
                if err:
                    last_error = err
                    error_class = self._classify_error(err)
                    was_blocked = error_class == "blocked"
                    if error_class == "auth":
                        raise err
                    if self._is_disconnection_error(err):
                        consecutive_disconnects += 1
                        primary_disconnects += 1
                    else:
                        consecutive_disconnects = 0

            # Phase 2: Try EXTENDED browsers if blocked OR persistent WS disconnects
            if primary_disconnects >= 2 and not was_blocked:
                was_blocked = True
            if was_blocked and total_attempts < budget:
                for browser in EXTENDED_ROTATION:
                    if total_attempts >= budget:
                        break
                    if browser in self._down_backends:
                        continue

                    success, value, total_attempts, tried, err = await self._try_browser(
                        fn, ctx, browser, stealth, total_attempts, budget,
                        allow_transient_retries=False,
                    )
                    if tried:
                        tried_any = True
                    if success:
                        return value  # type: ignore[return-value]
                    if err:
                        last_error = err
                        if self._classify_error(err) == "auth":
                            raise err

            if not tried_any:
                logger.warning("retry: all browser backends unavailable, stopping")
                break

        raise last_error or Exception("All browsers and stealth levels exhausted")

    async def _try_browser(
        self,
        fn: Callable[[], Awaitable[T]],
        ctx: RetryContext,
        browser: BrowserType,
        stealth: int,
        total_attempts: int,
        budget: int,
        *,
        allow_transient_retries: bool,
    ) -> Tuple[bool, Optional[T], int, bool, Optional[Exception]]:
        """
        Attempt an action on a specific browser.

        Returns (success, value, total_attempts, tried_action, last_error).
        """
        last_error: Optional[Exception] = None

        # Switch to this browser (skip on very first attempt)
        if total_attempts > 0:
            try:
                prev_browser = ctx.transport.browser
                logger.info(f"retry: switching {prev_browser} -> {browser} (stealth={stealth})")
                self._emitter.emit("browser.switching", {
                    "from": prev_browser,
                    "to": browser,
                    "reason": "rotation",
                })
                await self._switch_browser(ctx, browser)
                self._emitter.emit("browser.switched", {"browser": browser})
            except BackendUnavailableError:
                self._down_backends.add(browser)
                return False, None, total_attempts, False, None
            except Exception as switch_err:
                logger.warning(f"retry: switch to {browser} failed: {switch_err}")
                return False, None, total_attempts, False, (
                    switch_err if isinstance(switch_err, Exception) else None
                )

        max_transient = 2 if allow_transient_retries else 0
        transient_retries = 0

        while total_attempts < budget:
            total_attempts += 1

            try:
                result = await fn()
                domain = self._extract_domain(ctx.current_url)
                if domain:
                    self._selector.failure_tracker.record_success(domain, browser)
                return True, result, total_attempts, True, None
            except Exception as err:
                last_error = err
                error_class = self._classify_error(err)

                logger.warning(
                    f"retry: attempt {total_attempts}/{budget} failed "
                    f"error={err} class={error_class} browser={browser} stealth={stealth}"
                )
                self._emitter.emit("retry.attempt", {
                    "attempt": total_attempts,
                    "maxRetries": self._max_retries,
                    "error": str(err),
                })

                # Auth → bubble up
                if error_class == "auth":
                    return False, None, total_attempts, True, last_error

                # Rate limit → wait and retry same browser
                if error_class == "rate_limit":
                    wait_s = getattr(err, "retry_after_s", 2.0)
                    await asyncio.sleep(wait_s)
                    continue

                # Backend down → mark down, move on
                if error_class == "backend_down":
                    self._down_backends.add(browser)
                    return False, None, total_attempts, True, last_error

                # Blocked → record failure, move to next browser
                if error_class == "blocked":
                    domain = self._extract_domain(ctx.current_url)
                    if domain:
                        self._selector.failure_tracker.record_failure(domain, browser)
                    return False, None, total_attempts, True, last_error

                # WS disconnection → skip transient retries, rotate to next browser.
                # Reconnecting the same browser after a hang-up rarely helps.
                if error_class == "transient" and self._is_disconnection_error(err):
                    domain = self._extract_domain(ctx.current_url)
                    if domain:
                        self._selector.failure_tracker.record_failure(domain, browser)
                    return False, None, total_attempts, True, last_error

                # Non-disconnect transient → retry same browser up to max_transient
                if error_class == "transient" and transient_retries < max_transient:
                    transient_retries += 1
                    await asyncio.sleep(0.1)
                    continue

                # Transient exhausted → move to next browser
                domain = self._extract_domain(ctx.current_url)
                if domain:
                    self._selector.failure_tracker.record_failure(domain, browser)
                return False, None, total_attempts, True, last_error

        return False, None, total_attempts, True, last_error

    def _classify_error(self, err: Exception) -> ErrorClass:
        if isinstance(err, AuthError):
            return "auth"
        if isinstance(err, RateLimitError):
            return "rate_limit"
        if isinstance(err, BlockedError):
            return "blocked"
        if isinstance(err, BackendUnavailableError):
            return "backend_down"
        if isinstance(err, TimeoutError):
            return "transient"
        if isinstance(err, ConnectionError):
            return "transient"
        # NavigationError: ERR_ABORTED/ERR_BLOCKED_BY_CLIENT = page-level → blocked
        # ERR_CONNECTION_RESET etc = connection-level → transient
        if isinstance(err, NavigationError):
            msg = str(err).lower()
            if "err_aborted" in msg or "err_blocked_by_client" in msg:
                return "blocked"
            return "transient"

        msg = str(err).lower()
        if any(kw in msg for kw in (
            "bot detection", "bot detected", "are you a robot",
        )):
            return "blocked"
        if any(kw in msg for kw in (
            "blocked", "403", "captcha", "network security",
            "human verification", "verify you are human",
            "checking your browser", "bot protection",
            "automated access", "pardon our interruption",
            "powered and protected by", "request could not be processed",
            "access to this page has been denied",
            "access denied", "please complete the security check",
            "enable cookies", "browser check",
            "just a moment",
            "rate limit exceeded", "too many requests",
            "err_aborted", "err_blocked_by_client",
        )):
            return "blocked"
        if any(kw in msg for kw in ("401", "402", "unauthorized")):
            return "auth"
        # Transport-level 429 → rate_limit (wait + retry same browser)
        # Note: content-level "rate limit exceeded" is caught above as "blocked" (browser rotation)
        if "429" in msg:
            return "rate_limit"
        if any(kw in msg for kw in (
            "backend unavailable", "no backend", "service unavailable", "503",
        )):
            return "backend_down"
        if any(kw in msg for kw in ("timeout",)):
            return "transient"
        if any(kw in msg for kw in (
            "websocket is not connected", "websocket closed",
            "session with given id not found",
        )):
            return "transient"
        return "transient"

    @staticmethod
    def _is_disconnection_error(err: Exception) -> bool:
        msg = str(err).lower()
        # ERR_ABORTED is page-level, NOT a disconnection
        if "err_aborted" in msg or "err_blocked_by_client" in msg:
            return False
        if isinstance(err, NavigationError):
            return True
        return any(kw in msg for kw in (
            "websocket is not connected",
            "websocket closed",
            "session destroyed",
            "session with given id not found",
            "err_connection_reset",
            "err_connection_closed",
            "err_empty_response",
            "socket hang up",
        ))

    async def _switch_browser(self, ctx: RetryContext, new_browser: BrowserType) -> None:
        ctx.adapter.destroy()
        await ctx.transport.reconnect(new_browser)

        new_adapter = ProtocolAdapter(ctx.transport, self._emitter, new_browser)
        await new_adapter.init()
        ctx.adapter = new_adapter
        ctx.on_adapter_changed(new_adapter)

        if ctx.current_url:
            await new_adapter.navigate(ctx.current_url)
            await asyncio.sleep(0.2)

    def _get_stealth_progression(self) -> list[int]:
        start = self._current_stealth
        levels = [start]
        nxt = 1 if start < 1 else start + 1
        while nxt <= self._max_stealth:
            levels.append(nxt)
            nxt += 1
        return levels

    @staticmethod
    def _ordered_primary_browsers(start: BrowserType) -> list[BrowserType]:
        try:
            idx = PRIMARY_ROTATION.index(start)
        except ValueError:
            return list(PRIMARY_ROTATION)
        if idx <= 0:
            return list(PRIMARY_ROTATION)
        return PRIMARY_ROTATION[idx:] + PRIMARY_ROTATION[:idx]

    @staticmethod
    def _extract_domain(url: Optional[str]) -> Optional[str]:
        if not url:
            return None
        try:
            return urlparse(url).hostname
        except Exception:
            return None
