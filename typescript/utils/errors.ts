/** Base error for all spider-browser errors. */
export class SpiderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'SpiderError';
  }
}

/** WebSocket connection or transport error. */
export class ConnectionError extends SpiderError {
  constructor(message: string, public readonly wsCode?: number) {
    super(message, 'CONNECTION_ERROR', true);
    this.name = 'ConnectionError';
  }
}

/** Authentication failure (401/402). Never retried. */
export class AuthError extends SpiderError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR', false);
    this.name = 'AuthError';
  }
}

/** Rate limit (429). Retried with delay. */
export class RateLimitError extends SpiderError {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message, 'RATE_LIMIT', true);
    this.name = 'RateLimitError';
  }
}

/** The browser was blocked by the target site (403, captcha stuck). */
export class BlockedError extends SpiderError {
  constructor(message: string) {
    super(message, 'BLOCKED', true);
    this.name = 'BlockedError';
  }
}

/** The requested backend browser is unavailable. */
export class BackendUnavailableError extends SpiderError {
  constructor(message: string) {
    super(message, 'BACKEND_UNAVAILABLE', true);
    this.name = 'BackendUnavailableError';
  }
}

/** Timeout waiting for a response or navigation. */
export class TimeoutError extends SpiderError {
  constructor(message: string) {
    super(message, 'TIMEOUT', true);
    this.name = 'TimeoutError';
  }
}

/** Protocol-level error (invalid CDP/BiDi response). */
export class ProtocolError extends SpiderError {
  constructor(message: string) {
    super(message, 'PROTOCOL_ERROR', false);
    this.name = 'ProtocolError';
  }
}

/** Navigation error that can be retried (ERR_ABORTED, ERR_CONNECTION_RESET, etc.). */
export class NavigationError extends SpiderError {
  constructor(message: string) {
    super(message, 'NAVIGATION_ERROR', true);
    this.name = 'NavigationError';
  }
}

/** Permanent navigation error (DNS failure, QUIC broken). Never retried. */
export class PermanentNavError extends SpiderError {
  constructor(message: string) {
    super(message, 'PERMANENT_NAV_ERROR', false);
    this.name = 'PermanentNavError';
  }
}

/** LLM call failed or returned unparseable response. */
export class LLMError extends SpiderError {
  constructor(message: string) {
    super(message, 'LLM_ERROR', true);
    this.name = 'LLMError';
  }
}
