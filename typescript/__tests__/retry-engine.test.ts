import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryEngine } from '../retry/retry-engine.js';
import {
  AuthError,
  RateLimitError,
  BlockedError,
  BackendUnavailableError,
  TimeoutError,
  ConnectionError,
  NavigationError,
} from '../utils/errors.js';
import type { SpiderEventEmitter } from '../events/emitter.js';
import type { TransportOptions } from '../protocol/transport.js';

// --- Helpers to access private methods via reflection ---

function classifyError(engine: RetryEngine, err: Error): string {
  return (engine as any).classifyError(err);
}

function isDisconnectionError(engine: RetryEngine, err: Error): boolean {
  return (engine as any).isDisconnectionError(err);
}

function getStealthProgression(engine: RetryEngine): number[] {
  return (engine as any).getStealthProgression();
}

function orderedPrimaryBrowsers(engine: RetryEngine, start: string): string[] {
  return (engine as any).orderedPrimaryBrowsers(start);
}

function extractDomain(engine: RetryEngine, url: string | undefined): string | undefined {
  return (engine as any).extractDomain(url);
}

function createEngine(overrides: Partial<{
  maxRetries: number;
  stealthLevel: number;
  maxStealthLevel: number;
}> = {}): RetryEngine {
  const emitter = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as SpiderEventEmitter;
  const transportOpts: TransportOptions = {
    apiKey: 'test',
    serverUrl: 'wss://test',
    browser: 'chrome',
    stealthLevel: overrides.stealthLevel ?? 0,
  };
  return new RetryEngine({
    maxRetries: overrides.maxRetries ?? 3,
    transportOpts,
    emitter,
    maxStealthLevel: overrides.maxStealthLevel ?? 3,
  });
}

// ====================================================================
// Error Classification Tests — most critical logic for retry behavior
// ====================================================================

describe('RetryEngine.classifyError', () => {
  let engine: RetryEngine;

  beforeEach(() => {
    engine = createEngine();
  });

  describe('typed error instances', () => {
    it('AuthError → auth', () => {
      expect(classifyError(engine, new AuthError('Unauthorized'))).toBe('auth');
    });

    it('RateLimitError → rate_limit', () => {
      expect(classifyError(engine, new RateLimitError('Too many requests'))).toBe('rate_limit');
    });

    it('BlockedError → blocked', () => {
      expect(classifyError(engine, new BlockedError('Blocked by WAF'))).toBe('blocked');
    });

    it('BackendUnavailableError → backend_down', () => {
      expect(classifyError(engine, new BackendUnavailableError('No backend'))).toBe('backend_down');
    });

    it('TimeoutError → transient', () => {
      expect(classifyError(engine, new TimeoutError('Timed out'))).toBe('transient');
    });

    it('ConnectionError with 1006 → transient', () => {
      expect(classifyError(engine, new ConnectionError('WS close', 1006))).toBe('transient');
    });

    it('ConnectionError with 1011 → transient', () => {
      expect(classifyError(engine, new ConnectionError('WS close', 1011))).toBe('transient');
    });

    it('ConnectionError with 4001 → auth', () => {
      expect(classifyError(engine, new ConnectionError('Bad API key', 4001))).toBe('auth');
    });

    it('ConnectionError with 4002 → auth', () => {
      expect(classifyError(engine, new ConnectionError('Insufficient credits', 4002))).toBe('auth');
    });
  });

  describe('NavigationError subtypes', () => {
    it('ERR_ABORTED → transient (reconnect with new session)', () => {
      expect(classifyError(engine, new NavigationError('net::ERR_ABORTED'))).toBe('transient');
    });

    it('ERR_BLOCKED_BY_CLIENT → blocked', () => {
      expect(classifyError(engine, new NavigationError('net::ERR_BLOCKED_BY_CLIENT'))).toBe('blocked');
    });

    it('ERR_CONNECTION_RESET → transient', () => {
      expect(classifyError(engine, new NavigationError('net::ERR_CONNECTION_RESET'))).toBe('transient');
    });

    it('ERR_CONNECTION_CLOSED → transient', () => {
      expect(classifyError(engine, new NavigationError('net::ERR_CONNECTION_CLOSED'))).toBe('transient');
    });

    it('ERR_EMPTY_RESPONSE → transient', () => {
      expect(classifyError(engine, new NavigationError('net::ERR_EMPTY_RESPONSE'))).toBe('transient');
    });

    it('generic navigation error → transient', () => {
      expect(classifyError(engine, new NavigationError('Navigation failed'))).toBe('transient');
    });
  });

  describe('heuristic classification from error messages', () => {
    // Blocked patterns
    const blockedPatterns = [
      'bot detection triggered',
      'bot detected on page',
      'Are you a robot?',
      'blocked by firewall',
      'HTTP 403 Forbidden',
      'captcha required',
      'network security check',
      'human verification required',
      'verify you are human',
      'checking your browser',
      'bot protection active',
      'automated access denied',
      'pardon our interruption',
      'powered and protected by cloudflare',
      'request could not be processed',
      'access to this page has been denied',
      'access denied by security policy',
      'please complete the security check',
      'enable cookies to continue',
      'browser check in progress',
      // NOTE: 'net::ERR_ABORTED' is no longer classified as blocked — it's transient
      // (server retries internally; client reconnects with new session)
      'net::ERR_BLOCKED_BY_CLIENT in generic error',
      'just a moment while we verify',
      'Rate limit exceeded. Rate limit exceeded.',
      'too many requests from this IP',
    ];

    for (const pattern of blockedPatterns) {
      it(`"${pattern}" → blocked`, () => {
        expect(classifyError(engine, new Error(pattern))).toBe('blocked');
      });
    }

    // Auth patterns
    const authPatterns = [
      'HTTP 401 response',
      'HTTP 402 Payment Required',
      'unauthorized access attempt',
    ];

    for (const pattern of authPatterns) {
      it(`"${pattern}" → auth`, () => {
        expect(classifyError(engine, new Error(pattern))).toBe('auth');
      });
    }

    // Rate limit patterns (transport-level 429 only — content "rate limit exceeded" is blocked)
    const rateLimitPatterns = [
      'HTTP 429',
    ];

    for (const pattern of rateLimitPatterns) {
      it(`"${pattern}" → rate_limit`, () => {
        expect(classifyError(engine, new Error(pattern))).toBe('rate_limit');
      });
    }

    // Backend down patterns
    const backendDownPatterns = [
      'backend unavailable for browser',
      'no backend found',
      'service unavailable',
      'HTTP 503',
    ];

    for (const pattern of backendDownPatterns) {
      it(`"${pattern}" → backend_down`, () => {
        expect(classifyError(engine, new Error(pattern))).toBe('backend_down');
      });
    }

    // Transient patterns
    const transientPatterns = [
      'timeout waiting for response',
      'websocket is not connected',
      'websocket closed unexpectedly',
      'session with given id not found',
      'err_connection_reset occurred',
      'err_connection_closed occurred',
      'err_empty_response received',
      'Navigation failed: net::ERR_SSL_PROTOCOL_ERROR',
      'Content contamination: got wrong page',
      'Page has insufficient content (< 500 chars)',
    ];

    for (const pattern of transientPatterns) {
      it(`"${pattern}" → transient`, () => {
        expect(classifyError(engine, new Error(pattern))).toBe('transient');
      });
    }

    it('unknown error → transient (default)', () => {
      expect(classifyError(engine, new Error('something completely unknown'))).toBe('transient');
    });
  });
});

// ====================================================================
// Disconnection Detection Tests
// ====================================================================

describe('RetryEngine.isDisconnectionError', () => {
  let engine: RetryEngine;

  beforeEach(() => {
    engine = createEngine();
  });

  describe('page-level errors', () => {
    it('ERR_ABORTED → true (session interference at high concurrency, reconnect fixes)', () => {
      expect(isDisconnectionError(engine, new NavigationError('net::ERR_ABORTED'))).toBe(true);
    });

    it('ERR_BLOCKED_BY_CLIENT → false (page-level block, not connection)', () => {
      expect(isDisconnectionError(engine, new NavigationError('net::ERR_BLOCKED_BY_CLIENT'))).toBe(false);
    });

    it('generic error with err_aborted → true (reconnect fixes)', () => {
      expect(isDisconnectionError(engine, new Error('Navigation failed: net::ERR_ABORTED'))).toBe(true);
    });
  });

  describe('connection-level errors ARE disconnections', () => {
    it('NavigationError (non-aborted) → true', () => {
      expect(isDisconnectionError(engine, new NavigationError('net::ERR_CONNECTION_RESET'))).toBe(true);
    });

    it('websocket is not connected → true', () => {
      expect(isDisconnectionError(engine, new Error('WebSocket is not connected'))).toBe(true);
    });

    it('websocket closed → true', () => {
      expect(isDisconnectionError(engine, new Error('WebSocket closed unexpectedly'))).toBe(true);
    });

    it('session destroyed → true', () => {
      expect(isDisconnectionError(engine, new Error('session destroyed'))).toBe(true);
    });

    it('session with given id not found → true', () => {
      expect(isDisconnectionError(engine, new Error('session with given id not found'))).toBe(true);
    });

    it('err_connection_reset → true', () => {
      expect(isDisconnectionError(engine, new Error('net::ERR_CONNECTION_RESET'))).toBe(true);
    });

    it('err_connection_closed → true', () => {
      expect(isDisconnectionError(engine, new Error('ERR_CONNECTION_CLOSED'))).toBe(true);
    });

    it('err_empty_response → true', () => {
      expect(isDisconnectionError(engine, new Error('ERR_EMPTY_RESPONSE'))).toBe(true);
    });

    it('socket hang up → true', () => {
      expect(isDisconnectionError(engine, new Error('WebSocket error: socket hang up'))).toBe(true);
    });

    it('content contamination → true (needs fresh session)', () => {
      expect(isDisconnectionError(engine, new Error('Content contamination: got wrong page'))).toBe(true);
    });

    it('insufficient content → true (needs fresh session)', () => {
      expect(isDisconnectionError(engine, new Error('Page has insufficient content (< 500 chars)'))).toBe(true);
    });

    it('SSL protocol error → true (needs reconnect)', () => {
      expect(isDisconnectionError(engine, new Error('Navigation failed: net::ERR_SSL_PROTOCOL_ERROR'))).toBe(true);
    });
  });

  describe('unrelated errors are NOT disconnections', () => {
    it('timeout error → false', () => {
      expect(isDisconnectionError(engine, new Error('Timed out after 30s'))).toBe(false);
    });

    it('generic error → false', () => {
      expect(isDisconnectionError(engine, new Error('Something went wrong'))).toBe(false);
    });
  });
});

// ====================================================================
// Stealth Progression Tests
// ====================================================================

describe('RetryEngine.getStealthProgression', () => {
  it('start=0, max=3 → [0, 1, 2, 3]', () => {
    const engine = createEngine({ stealthLevel: 0, maxStealthLevel: 3 });
    expect(getStealthProgression(engine)).toEqual([0, 1, 2, 3]);
  });

  it('start=1, max=3 → [1, 2, 3]', () => {
    const engine = createEngine({ stealthLevel: 1, maxStealthLevel: 3 });
    expect(getStealthProgression(engine)).toEqual([1, 2, 3]);
  });

  it('start=2, max=3 → [2, 3]', () => {
    const engine = createEngine({ stealthLevel: 2, maxStealthLevel: 3 });
    expect(getStealthProgression(engine)).toEqual([2, 3]);
  });

  it('start=3, max=3 → [3]', () => {
    const engine = createEngine({ stealthLevel: 3, maxStealthLevel: 3 });
    expect(getStealthProgression(engine)).toEqual([3]);
  });

  it('start=0, max=1 → [0, 1]', () => {
    const engine = createEngine({ stealthLevel: 0, maxStealthLevel: 1 });
    expect(getStealthProgression(engine)).toEqual([0, 1]);
  });
});

// ====================================================================
// Primary Browser Ordering Tests
// ====================================================================

describe('RetryEngine.orderedPrimaryBrowsers', () => {
  let engine: RetryEngine;

  beforeEach(() => {
    engine = createEngine();
  });

  it('starting from chrome-h → [chrome-h, chrome-new, navi]', () => {
    expect(orderedPrimaryBrowsers(engine, 'chrome-h')).toEqual(['chrome-h', 'chrome-new', 'navi']);
  });

  it('starting from chrome-new → [chrome-new, navi, chrome-h]', () => {
    expect(orderedPrimaryBrowsers(engine, 'chrome-new')).toEqual(['chrome-new', 'navi', 'chrome-h']);
  });

  it('starting from navi → [navi, chrome-h, chrome-new]', () => {
    expect(orderedPrimaryBrowsers(engine, 'navi')).toEqual(['navi', 'chrome-h', 'chrome-new']);
  });

  it('starting from non-primary browser → default order', () => {
    expect(orderedPrimaryBrowsers(engine, 'firefox')).toEqual(['chrome-h', 'chrome-new', 'navi']);
  });

  it('starting from auto → default order', () => {
    expect(orderedPrimaryBrowsers(engine, 'auto')).toEqual(['chrome-h', 'chrome-new', 'navi']);
  });
});

// ====================================================================
// Domain Extraction Tests
// ====================================================================

describe('RetryEngine.extractDomain', () => {
  let engine: RetryEngine;

  beforeEach(() => {
    engine = createEngine();
  });

  it('extracts hostname from URL', () => {
    expect(extractDomain(engine, 'https://example.com/path')).toBe('example.com');
  });

  it('extracts hostname with subdomain', () => {
    expect(extractDomain(engine, 'https://www.example.com/path')).toBe('www.example.com');
  });

  it('returns undefined for undefined input', () => {
    expect(extractDomain(engine, undefined)).toBeUndefined();
  });

  it('returns undefined for invalid URL', () => {
    expect(extractDomain(engine, 'not-a-url')).toBeUndefined();
  });
});

// ====================================================================
// Constructor / stealthLevel Property Tests
// ====================================================================

describe('RetryEngine constructor', () => {
  it('initializes stealth level from transport options', () => {
    const engine = createEngine({ stealthLevel: 2 });
    expect(engine.stealthLevel).toBe(2);
  });

  it('defaults stealth level to 0', () => {
    const engine = createEngine();
    expect(engine.stealthLevel).toBe(0);
  });
});
