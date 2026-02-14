"""spider-browser — Python browser automation client for Spider's pre-warmed browser fleet."""

from .spider_browser import SpiderBrowser, SpiderBrowserOptions
from .page import SpiderPage
from .events.types import BrowserType
from .events.emitter import SpiderEventEmitter
from .utils.errors import (
    SpiderError,
    ConnectionError as SpiderConnectionError,
    AuthError,
    RateLimitError,
    BlockedError,
    BackendUnavailableError,
    TimeoutError as SpiderTimeoutError,
    ProtocolError,
    LLMError,
)
from .ai.llm_provider import LLMConfig, create_provider
from .ai.agent import Agent, AgentOptions, AgentResult

__all__ = [
    "SpiderBrowser",
    "SpiderBrowserOptions",
    "SpiderPage",
    "BrowserType",
    "SpiderEventEmitter",
    "SpiderError",
    "SpiderConnectionError",
    "AuthError",
    "RateLimitError",
    "BlockedError",
    "BackendUnavailableError",
    "SpiderTimeoutError",
    "ProtocolError",
    "LLMError",
    "LLMConfig",
    "create_provider",
    "Agent",
    "AgentOptions",
    "AgentResult",
]
