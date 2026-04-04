import type { Transport, TransportOptions } from '../protocol/transport.js';
import { ProtocolAdapter } from '../protocol/protocol-adapter.js';
import type { SpiderEventEmitter } from '../events/emitter.js';
import type { SpiderPage } from '../page.js';
import { BrowserSelector, BROWSER_ROTATION, PRIMARY_ROTATION, EXTENDED_ROTATION } from './browser-selector.js';
import { FailureTracker } from './failure-tracker.js';
import {
  ConnectionError,
  AuthError,
  RateLimitError,
  BlockedError,
  BackendUnavailableError,
  TimeoutError,
  NavigationError,
  PermanentNavError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';

import { KeywordClassifier } from './keyword-classifier.js';

/**
 * Error classification via Aho-Corasick multi-pattern matching.
 *
 * Scans the error message ONCE in O(n) regardless of keyword count.
 * Rules are priority-ordered — first match wins.
 *
 * To add a new keyword: add it to the appropriate array below.
 */
const errorClassifier = new KeywordClassifier<ErrorClass>([
  // Blocked — checked first (most common heuristic case)
  // NOTE: err_aborted is NOT here — it's handled specially in classifyError().
  // Server already retries ERR_ABORTED internally; when it reaches the client,
  // it's usually session interference (shared Chrome) not actual blocking.
  // Reconnecting (new session) is the right fix, not stealth escalation.
  [[
    'bot detect', 'are you a robot', 'bot or not', 'blocked', '403', 'captcha',
    'network security', 'human verification', 'verify you are human',
    'show us your human side', "can't tell if you're a human",
    'checking your browser', 'bot protection', 'automated access',
    'suspected automated', "prove you're not a robot",
    'pardon our interruption', 'powered and protected by',
    'request could not be processed', 'access to this page has been denied',
    'access denied', 'please complete the security check',
    'enable cookies', 'browser check', 'just a moment',
    'rate limit exceeded', 'too many requests',
    'err_blocked_by_client',
  ], 'blocked'],
  // Permanent — DNS/QUIC errors that will never resolve on retry (checked before auth/transient)
  [['err_name_not_resolved', 'err_quic_protocol_error'], 'permanent'],
  // Auth
  [['401', '402', 'unauthorized'], 'auth'],
  // Backend down
  [['backend unavailable', 'no backend', 'service unavailable', '503', 'failed to create page target', 'unexpected server response'], 'backend_down'],
  // Transient (connection)
  [['err_connection_reset', 'err_connection_closed', 'err_empty_response', 'err_ssl_protocol_error', 'err_ssl_version_or_cipher_mismatch', 'err_cert', 'timeout'], 'transient'],
  // Transient (WebSocket / session)
  [['websocket is not connected', 'websocket closed', 'session with given id not found', 'content contamination', 'insufficient content'], 'transient'],
]);

/** Disconnection detection — single O(n) scan. */
const disconnectionClassifier = new KeywordClassifier<boolean>([
  // NOT disconnections (page-level) — checked first
  // NOTE: err_aborted is intentionally NOT here — at high concurrency it's
  // usually session interference (shared Chrome process), so reconnecting
  // (new session) is the correct fix. For NavigationError, undefined → true.
  [['err_blocked_by_client'], false],
  // Actual disconnections (socket hang up = server killed the connection)
  // Content contamination = shared Chrome leaked another session's content → new session fixes it
  [[
    'websocket is not connected', 'websocket closed', 'session destroyed',
    'session with given id not found', 'err_connection_reset',
    'err_connection_closed', 'err_empty_response', 'socket hang up',
    'err_aborted', 'content contamination', 'insufficient content',
    'err_ssl_protocol_error', 'err_ssl_version_or_cipher_mismatch',
  ], true],
]);

export interface RetryOptions {
  maxRetries: number;
  transportOpts: TransportOptions;
  emitter: SpiderEventEmitter;
  /** Maximum stealth level to escalate to (1-3, default 3). */
  maxStealthLevel?: number;
  /** Timeout for retry attempts — shorter than first try (default: 15000ms). */
  retryTimeoutMs?: number;
  /** CDP/BiDi command timeout in ms, passed through to new adapters (default: 30000). */
  commandTimeoutMs?: number;
}

export interface RetryContext {
  transport: Transport;
  adapter: ProtocolAdapter;
  page: SpiderPage;
  currentUrl: string | undefined;
  onAdapterChanged: (adapter: ProtocolAdapter) => void;
}

/** Error classification for retry decisions. */
type ErrorClass = 'transient' | 'blocked' | 'backend_down' | 'auth' | 'rate_limit' | 'permanent';

/**
 * Smart retry engine with stealth-first escalation.
 *
 * **Strategy: escalate proxy quality (stealth) FAST, try alternative engines LAST.**
 *
 * - **Phase 1 (Stealth escalation)**: For each stealth level [0 → max],
 *   try PRIMARY browsers [chrome, chrome-new] with transient retries.
 *   If blocked → skip remaining primary browsers, escalate stealth immediately.
 *
 * - **Phase 2 (Extended rotation)**: Only at max stealth, if still blocked,
 *   try EXTENDED browsers [firefox, lightpanda, servo] for different engine
 *   fingerprints + best proxies.
 *
 * **Retry flow:**
 * ```
 * Phase 1 — stealth escalation across primary browsers:
 *   for each stealth level (initial → maxStealthLevel):
 *     for each PRIMARY browser [chrome, chrome-new]:
 *       attempt action
 *       if transient → reconnect same browser, retry up to 2x
 *       if blocked   → skip remaining primary, escalate stealth immediately
 *       if backend_down → mark down, next browser
 *       if auth      → throw immediately
 *       if rate_limit → wait, retry same browser
 *
 * Phase 2 — extended rotation at max stealth only (if blocked):
 *   for each EXTENDED browser [firefox, lightpanda, servo]:
 *     single attempt (no transient retries)
 * ```
 *
 * Error classification (mirrors server hints.rs):
 *
 * | Error Pattern              | Classification  | Action                                    |
 * |----------------------------|-----------------|-------------------------------------------|
 * | ERR_NAME_NOT_RESOLVED      | Permanent       | Throw immediately (no retry)              |
 * | ERR_QUIC_PROTOCOL_ERROR    | Permanent       | Throw immediately (no retry)              |
 * | ERR_ABORTED (nav)          | Transient+Disco | Reconnect (new session), retry up to 2x   |
 * | WS close 1006/1011         | Transient+Disco | Reconnect same browser, retry up to 2x    |
 * | Timeout                    | Transient       | Retry same browser up to 2x, then switch  |
 * | blocked / 403 / captcha    | Blocked         | Skip remaining primary, escalate stealth   |
 * | bot detection              | Blocked         | Skip remaining primary, escalate stealth   |
 * | 401 / 402                  | Auth            | Throw immediately (no retry)              |
 * | 429                        | Rate limit      | Wait + retry same browser                 |
 * | 503 / backend unavailable  | Backend down    | Mark down, switch browser                 |
 */
export class RetryEngine {
  private opts: RetryOptions;
  private selector: BrowserSelector;
  private currentStealthLevel: number;
  private maxStealthLevel: number;
  private retryTimeoutMs: number;
  private commandTimeoutMs: number;
  /** Browser backends that returned 503/unavailable — persists across stealth levels. */
  private downBackends = new Set<string>();

  /** Count of timeout errors — used for progressive timeout escalation. */
  private timeoutCount = 0;

  constructor(opts: RetryOptions) {
    this.opts = opts;
    this.selector = new BrowserSelector(new FailureTracker());
    this.currentStealthLevel = opts.transportOpts.stealthLevel ?? 0;
    this.maxStealthLevel = opts.maxStealthLevel ?? 3;
    this.retryTimeoutMs = opts.retryTimeoutMs ?? 15_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
  }

  /**
   * Progressive page timeout: fail fast initially, escalate on retries.
   * 1st attempt: 35s, 2nd: 50s, 3rd+: 65s.
   * Must exceed server-side nav timeout (20s) + retry (15s) to allow server retries.
   */
  private progressiveTimeout(): number {
    switch (this.timeoutCount) {
      case 0: return 35_000;
      case 1: return 50_000;
      default: return 65_000;
    }
  }

  /** Current stealth level (0=auto, 1-3=explicit tiers). */
  get stealthLevel(): number {
    return this.currentStealthLevel;
  }

  /**
   * Execute an action with stealth-first retry across browsers and stealth levels.
   *
   * Phase 1: Escalate stealth across primary browsers (chrome, chrome-new).
   * Blocked errors skip remaining primary browsers and immediately escalate stealth.
   *
   * Phase 2: At max stealth only, try extended browsers (firefox, lightpanda, servo)
   * for a different engine fingerprint with the best proxy quality.
   */
  async execute<T>(fn: () => Promise<T>, ctx: RetryContext): Promise<T> {
    let lastError: Error | undefined;
    let totalAttempts = 0;
    const budget = this.opts.maxRetries + 1; // total attempts allowed
    this.downBackends.clear();

    const stealthLevels = this.getStealthProgression();
    const initialBrowser = ctx.transport.browser;
    /** Consecutive WS disconnect errors — when 3+ in a row, server is overloaded. */
    let consecutiveDisconnects = 0;
    /** Whether the last error was a blocked error (for extended rotation decision). */
    let wasBlocked = false;
    /** Whether a timeout occurred — skip rest of Phase 1, jump to Phase 2 (Firefox). */
    let hadTimeout = false;
    /** Count of timeouts in Phase 1 — 2+ means skip remaining stealth levels. */
    let phase1Timeouts = 0;

    // Phase 1: Stealth escalation across primary browsers
    for (let si = 0; si < stealthLevels.length; si++) {
      if (totalAttempts >= budget) break;
      // 1+ timeout on Chrome → different Chrome variant won't help (same anti-bot
      // challenge, server already tried proxy escalation). Jump to Phase 2 (Firefox).
      if (phase1Timeouts >= 1) { hadTimeout = true; break; }

      const stealth = stealthLevels[si]!;

      // Stealth escalation (skip for first level)
      if (si > 0) {
        const prev = stealthLevels[si - 1]!;
        this.currentStealthLevel = stealth;
        ctx.transport.stealthLevel = stealth;

        logger.info(`retry: escalating stealth ${prev} -> ${stealth}`);
        this.opts.emitter.emit('stealth.escalated', {
          from: prev,
          to: stealth,
          reason: lastError ? this.classifyError(lastError) : 'exhausted',
        });

        // Clear domain failure tracking so all browsers are available again
        const domain = this.extractDomain(ctx.currentUrl);
        if (domain) this.selector.failureTracker.clear(domain);
      }

      const primaryBrowsers = si === 0
        ? this.orderedPrimaryBrowsers(initialBrowser)
        : [...PRIMARY_ROTATION];

      let triedAny = false;

      for (const browser of primaryBrowsers) {
        if (totalAttempts >= budget) break;
        if (this.downBackends.has(browser)) continue;

        // If 6+ consecutive WS disconnects across browsers, server is overloaded — stop
        if (consecutiveDisconnects >= 6) {
          logger.warn('retry: 6+ consecutive disconnects, server overloaded — aborting');
          break;
        }

        const result = await this.tryBrowser(fn, ctx, browser, stealth, totalAttempts, budget, true);
        totalAttempts = result.totalAttempts;
        if (result.success) {
          consecutiveDisconnects = 0;
          return result.value!;
        }
        if (result.triedAction) triedAny = true;
        if (result.lastError) {
          lastError = result.lastError;
          const errorClass = this.classifyError(lastError);
          wasBlocked = errorClass === 'blocked';
          if (errorClass === 'permanent') throw lastError;
          if (errorClass === 'auth') throw lastError;
          // Track consecutive disconnects
          if (this.isDisconnectionError(lastError)) {
            consecutiveDisconnects++;
          } else {
            consecutiveDisconnects = 0;
          }
          // Timeout → track count, 2+ means break to Phase 2 on next iteration
          if (lastError instanceof TimeoutError) {
            phase1Timeouts++;
            this.timeoutCount++;
            hadTimeout = true;
            break;
          }
          // Blocked → skip remaining primary browsers, escalate stealth immediately
          if (wasBlocked) break;
        }
      }

      // If no browser could be tried (all backends down), stop entirely
      if (!triedAny) {
        logger.warn('retry: all browser backends unavailable, stopping');
        break;
      }
    }

    // Phase 2: Extended rotation at max stealth — try non-Chrome engines when
    // primary rotation is exhausted. Different engine fingerprints may bypass
    // bot detection (blocked) or avoid shared-Chrome session instability (transient).
    if ((wasBlocked || hadTimeout || totalAttempts > 0) && totalAttempts < budget && EXTENDED_ROTATION.length > 0) {
      for (const browser of EXTENDED_ROTATION) {
        if (totalAttempts >= budget) break;
        if (this.downBackends.has(browser)) continue;

        // Extended browsers get a single attempt — no transient retries
        const maxStealth = stealthLevels[stealthLevels.length - 1] ?? this.maxStealthLevel;
        const result = await this.tryBrowser(fn, ctx, browser, maxStealth, totalAttempts, budget, false);
        totalAttempts = result.totalAttempts;
        if (result.success) return result.value!;
        if (result.lastError) {
          lastError = result.lastError;
          const cls = this.classifyError(lastError);
          if (cls === 'permanent' || cls === 'auth') throw lastError;
        }
      }
    }

    throw lastError ?? new Error('All browsers and stealth levels exhausted');
  }

  /**
   * Attempt an action on a specific browser, with optional transient retries.
   *
   * @param allowTransientRetries If true, retries up to 2x for transient errors
   *   (reconnect + retry). If false, a single attempt only (for extended browsers).
   */
  private async tryBrowser<T>(
    fn: () => Promise<T>,
    ctx: RetryContext,
    browser: string,
    stealth: number,
    totalAttempts: number,
    budget: number,
    allowTransientRetries: boolean,
  ): Promise<{ success: boolean; value?: T; totalAttempts: number; triedAction: boolean; lastError?: Error }> {
    let lastError: Error | undefined;

    // Switch to this browser (skip on very first attempt — already connected)
    if (totalAttempts > 0) {
      try {
        const prevBrowser = ctx.transport.browser;
        logger.info(`retry: switching ${prevBrowser} -> ${browser} (stealth=${stealth})`);
        this.opts.emitter.emit('browser.switching', {
          from: prevBrowser,
          to: browser,
          reason: lastError ? this.classifyError(lastError) : 'rotation',
        });

        const prevConnTimeout = this.opts.transportOpts.connectTimeoutMs;
        const prevCmdTimeout = this.opts.transportOpts.commandTimeoutMs;
        const progTimeout = this.progressiveTimeout();
        this.opts.transportOpts.connectTimeoutMs = progTimeout;
        this.opts.transportOpts.commandTimeoutMs = progTimeout;
        await this.switchBrowser(ctx, browser);
        this.opts.transportOpts.connectTimeoutMs = prevConnTimeout;
        this.opts.transportOpts.commandTimeoutMs = prevCmdTimeout;

        this.opts.emitter.emit('browser.switched', { browser });
      } catch (switchErr) {
        logger.warn(`retry: switch to ${browser} failed, skipping`, {
          error: switchErr instanceof Error ? switchErr.message : String(switchErr),
        });
        if (switchErr instanceof BackendUnavailableError) {
          this.downBackends.add(browser);
        }
        return { success: false, totalAttempts, triedAction: false, lastError: switchErr instanceof Error ? switchErr : undefined };
      }
    }

    const MAX_TRANSIENT_RETRIES = allowTransientRetries ? 2 : 0;
    const MAX_DISCONNECT_RETRIES = allowTransientRetries ? 2 : 0;
    let transientRetries = 0;
    let disconnectRetries = 0;

    while (totalAttempts < budget) {
      totalAttempts++;

      try {
        const result = await fn();
        const domain = this.extractDomain(ctx.currentUrl);
        if (domain) this.selector.failureTracker.recordSuccess(domain, browser);
        return { success: true, value: result, totalAttempts, triedAction: true };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errorClass = this.classifyError(lastError);

        logger.warn(`retry: attempt ${totalAttempts}/${budget} failed`, {
          error: lastError.message,
          class: errorClass,
          browser,
          stealth,
        });

        this.opts.emitter.emit('retry.attempt', {
          attempt: totalAttempts,
          maxRetries: this.opts.maxRetries,
          error: lastError.message,
        });

        // Permanent (DNS/QUIC) → throw immediately, no retries across any layer.
        // Set totalAttempts to budget so execute() won't try more browsers.
        if (errorClass === 'permanent') {
          return { success: false, totalAttempts: budget, triedAction: true, lastError };
        }

        // Auth → bubble up immediately (caller will throw)
        if (errorClass === 'auth') {
          return { success: false, totalAttempts, triedAction: true, lastError };
        }

        // Rate limit → exponential backoff with jitter, rotate after 2 consecutive 429s.
        // Server 429 means capacity full — retrying the same browser immediately
        // just adds pressure. Backoff lets capacity free up; rotating tries a
        // different browser pool that may have slots available.
        if (errorClass === 'rate_limit') {
          transientRetries++;
          if (transientRetries >= 2) {
            // 2+ consecutive rate limits on this browser → rotate to next
            const domain = this.extractDomain(ctx.currentUrl);
            if (domain) this.selector.failureTracker.recordFailure(domain, browser);
            return { success: false, totalAttempts, triedAction: true, lastError };
          }
          const baseMs = lastError instanceof RateLimitError && lastError.retryAfterMs
            ? lastError.retryAfterMs
            : 2000 * transientRetries; // 2s, 4s
          const jitter = Math.floor(Math.random() * 1000);
          await sleep(baseMs + jitter);
          continue;
        }

        // Backend down → mark this browser type as down
        if (errorClass === 'backend_down') {
          this.downBackends.add(browser);
          return { success: false, totalAttempts, triedAction: true, lastError };
        }

        // Blocked → record failure, move to next browser
        if (errorClass === 'blocked') {
          const domain = this.extractDomain(ctx.currentUrl);
          if (domain) this.selector.failureTracker.recordFailure(domain, browser);
          return { success: false, totalAttempts, triedAction: true, lastError };
        }

        // Timeout → rotate immediately, don't waste budget retrying same browser.
        // Pages stuck on anti-bot challenges won't resolve on retry — a different
        // browser engine (Firefox) or proxy tier is needed. Saves 25-50s of wasted
        // retries that would otherwise burn the page timeout budget.
        if (lastError instanceof TimeoutError) {
          const domain = this.extractDomain(ctx.currentUrl);
          if (domain) this.selector.failureTracker.recordFailure(domain, browser);
          return { success: false, totalAttempts, triedAction: true, lastError };
        }

        // WS disconnection → reconnect with backoff. First retry uses same browser
        // (might be transient). Second retry switches to a non-Chrome engine since
        // repeated disconnects suggest Chrome instability under load.
        if (errorClass === 'transient' && this.isDisconnectionError(lastError)) {
          if (disconnectRetries < MAX_DISCONNECT_RETRIES) {
            disconnectRetries++;
            const backoffMs = disconnectRetries === 1 ? 1000 : 3000;
            await sleep(backoffMs);
            // Second disconnect → try a different engine (Firefox/extended) if available
            const reconnectBrowser = disconnectRetries >= 2
              ? (this.pickAlternateEngine(browser) ?? browser)
              : browser;
            try {
              await this.switchBrowser(ctx, reconnectBrowser);
            } catch {
              const domain = this.extractDomain(ctx.currentUrl);
              if (domain) this.selector.failureTracker.recordFailure(domain, browser);
              return { success: false, totalAttempts, triedAction: true, lastError };
            }
            continue; // Retry the action
          }
          const domain = this.extractDomain(ctx.currentUrl);
          if (domain) this.selector.failureTracker.recordFailure(domain, browser);
          return { success: false, totalAttempts, triedAction: true, lastError };
        }

        // Non-disconnect transient → retry same browser up to MAX_TRANSIENT_RETRIES
        if (errorClass === 'transient' && transientRetries < MAX_TRANSIENT_RETRIES) {
          transientRetries++;
          await sleep(100);
          continue; // Retry same browser
        }

        // Transient retry exhausted → move to next browser
        const domain = this.extractDomain(ctx.currentUrl);
        if (domain) this.selector.failureTracker.recordFailure(domain, browser);
        return { success: false, totalAttempts, triedAction: true, lastError };
      }
    }

    return { success: false, totalAttempts, triedAction: true, lastError };
  }

  /** Check if an error indicates the WebSocket/session is dead and needs reconnection. */
  private isDisconnectionError(err: Error): boolean {
    // NavigationError with connection-level errors (but NOT page-level) → reconnect
    if (err instanceof NavigationError) {
      const result = disconnectionClassifier.classify(err.message);
      return result !== false; // false = page-level, true = disconnection, undefined = generic nav error → true
    }
    return disconnectionClassifier.classify(err.message) === true;
  }

  /**
   * Classify an error to determine retry strategy.
   *
   * Fast path: typed error instances (instanceof check, no string scan).
   * Slow path: Aho-Corasick O(n) single-pass keyword matching on error message.
   */
  private classifyError(err: Error): ErrorClass {
    // Fast path: typed error instances (no string matching needed)
    if (err instanceof PermanentNavError) return 'permanent';
    if (err instanceof AuthError) return 'auth';
    if (err instanceof RateLimitError) return 'rate_limit';
    if (err instanceof BlockedError) return 'blocked';
    if (err instanceof BackendUnavailableError) return 'backend_down';
    if (err instanceof TimeoutError) return 'transient';
    if (err instanceof ConnectionError) {
      const code = err.wsCode;
      if (code === 1006 || code === 1011) return 'transient';
      if (code === 4001 || code === 4002) return 'auth';
      return 'transient';
    }

    // NavigationError subtypes — ERR_ABORTED/ERR_BLOCKED_BY_CLIENT are page-level.
    // Server already retries ERR_ABORTED internally (MAX_NAV_RETRIES); if the client
    // still sees it, adding more connections makes overload worse. Classify as blocked
    // so the client rotates browser/stealth without piling on reconnects.
    if (err instanceof NavigationError) {
      const cls = errorClassifier.classify(err.message);
      return cls === 'blocked' ? 'blocked' : 'transient';
    }

    // Heuristic: single O(n) scan via Aho-Corasick trie
    // Note: "rate limit exceeded" / "too many requests" → blocked (browser rotation).
    // Only transport-level "429" without those phrases → rate_limit.
    const cls = errorClassifier.classify(err.message);
    if (cls) return cls;

    // Transport-level 429 fallback (not caught by keyword classifier which has "rate limit exceeded" → blocked)
    if (err.message.includes('429')) return 'rate_limit';

    return 'transient';
  }

  /** Reconnect with a (possibly different) browser, re-navigate to the same URL. */
  private async switchBrowser(ctx: RetryContext, newBrowser: string): Promise<void> {
    ctx.adapter.destroy();

    await ctx.transport.reconnect(newBrowser);

    const adapterOpts = this.commandTimeoutMs !== 30_000
      ? { commandTimeoutMs: this.commandTimeoutMs }
      : undefined;
    const newAdapter = new ProtocolAdapter(
      ctx.transport,
      this.opts.emitter,
      newBrowser,
      adapterOpts,
    );
    await newAdapter.init();

    ctx.adapter = newAdapter;
    ctx.onAdapterChanged(newAdapter);

    if (ctx.currentUrl) {
      await newAdapter.navigate(ctx.currentUrl);
      await sleep(200);
    }
  }

  /**
   * Get stealth progression: from current level up to maxStealthLevel.
   * e.g. start=0, max=3 → [0, 1, 2, 3]
   * e.g. start=2, max=3 → [2, 3]
   */
  private getStealthProgression(): number[] {
    const start = this.currentStealthLevel;
    const levels: number[] = [start];
    let next = start < 1 ? 1 : start + 1;
    while (next <= this.maxStealthLevel) {
      levels.push(next);
      next++;
    }
    return levels;
  }

  /**
   * Order PRIMARY browsers starting from `start`, then the rest in primary rotation order.
   * If `start` is not in PRIMARY_ROTATION, returns primary rotation as-is.
   */
  private orderedPrimaryBrowsers(start: string): string[] {
    const idx = PRIMARY_ROTATION.indexOf(start);
    if (idx <= 0) return [...PRIMARY_ROTATION];
    return [
      ...PRIMARY_ROTATION.slice(idx),
      ...PRIMARY_ROTATION.slice(0, idx),
    ];
  }

  /**
   * Pick a non-Chrome engine for disconnect recovery.
   * Returns the first available extended browser that isn't the current one and isn't down.
   */
  private pickAlternateEngine(current: string): string | null {
    for (const browser of EXTENDED_ROTATION) {
      if (browser !== current && !this.downBackends.has(browser)) {
        return browser;
      }
    }
    // Fallback: try any primary that isn't the current one
    for (const browser of PRIMARY_ROTATION) {
      if (browser !== current && !this.downBackends.has(browser)) {
        return browser;
      }
    }
    return null;
  }

  private extractDomain(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
