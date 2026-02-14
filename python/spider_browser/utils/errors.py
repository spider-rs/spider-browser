"""Error hierarchy for spider-browser."""


class SpiderError(Exception):
    """Base error for all spider-browser errors."""

    def __init__(self, message: str, code: str = "UNKNOWN", retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class ConnectionError(SpiderError):
    """WebSocket connection or transport error."""

    def __init__(self, message: str, ws_code: int | None = None):
        super().__init__(message, "CONNECTION_ERROR", retryable=True)
        self.ws_code = ws_code


class AuthError(SpiderError):
    """Authentication failure (401/402). Never retried."""

    def __init__(self, message: str):
        super().__init__(message, "AUTH_ERROR", retryable=False)


class RateLimitError(SpiderError):
    """Rate limit (429). Retried with delay."""

    def __init__(self, message: str, retry_after_ms: int | None = None):
        super().__init__(message, "RATE_LIMIT", retryable=True)
        self.retry_after_ms = retry_after_ms


class BlockedError(SpiderError):
    """The browser was blocked by the target site."""

    def __init__(self, message: str):
        super().__init__(message, "BLOCKED", retryable=True)


class BackendUnavailableError(SpiderError):
    """The requested backend browser is unavailable."""

    def __init__(self, message: str):
        super().__init__(message, "BACKEND_UNAVAILABLE", retryable=True)


class NavigationError(SpiderError):
    """Navigation failed (ERR_ABORTED, ERR_CONNECTION_RESET, etc)."""

    def __init__(self, message: str):
        super().__init__(message, "NAVIGATION_ERROR", retryable=True)


class TimeoutError(SpiderError):
    """Timeout waiting for a response or navigation."""

    def __init__(self, message: str):
        super().__init__(message, "TIMEOUT", retryable=True)


class ProtocolError(SpiderError):
    """Protocol-level error (invalid CDP/BiDi response)."""

    def __init__(self, message: str):
        super().__init__(message, "PROTOCOL_ERROR", retryable=False)


class LLMError(SpiderError):
    """LLM call failed or returned unparseable response."""

    def __init__(self, message: str):
        super().__init__(message, "LLM_ERROR", retryable=True)
