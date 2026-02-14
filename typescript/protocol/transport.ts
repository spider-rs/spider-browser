import WebSocket from 'ws';
import { SpiderEventEmitter } from '../events/emitter.js';
import type { SpiderEvents } from '../events/types.js';
import { ConnectionError, AuthError, BackendUnavailableError, RateLimitError, TimeoutError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface TransportOptions {
  apiKey: string;
  serverUrl: string;
  browser: string;
  url?: string;
  captcha?: 'off' | 'detect' | 'solve';
  /** Stealth level (1-3). 0 or undefined = auto. Controls proxy quality tier on server. */
  stealthLevel?: number;
  /** Country code for geo-located proxy (e.g. "US", "GB", "DE"). */
  country?: string;
  /** WebSocket connect timeout in ms (default: 30000). */
  connectTimeoutMs?: number;
  /** CDP/BiDi command timeout in ms (default: 30000). Passed through to sessions. */
  commandTimeoutMs?: number;
  /** Mark this session as a hedge — bypasses per-user session limits on the server. */
  hedge?: boolean;
  /** Enable screencast recording for this session (default: false). */
  record?: boolean;
  /** Browser mode: 'scraping' for fast text extraction, 'cua' for full rendering. */
  mode?: 'scraping' | 'cua';
}

/**
 * WebSocket transport to Spider's browser fleet.
 *
 * Connects to `wss://browser.spider.cloud/v1/browser?token=TOKEN&browser=TYPE`,
 * handles reconnection on browser switch, and dispatches raw messages.
 */
export class Transport {
  private ws: WebSocket | null = null;
  private messageHandler: ((data: string) => void) | null = null;
  private currentBrowser: string;
  private opts: TransportOptions;
  private emitter: SpiderEventEmitter;
  private _stealthLevel: number;
  /** Generation counter — incremented on each connect. Prevents stale WS messages from being processed. */
  private generation = 0;
  /** Credits remaining from last upgrade response (x-sc header). */
  private _upgradeCredits: number | undefined;
  /** Stealth tier from last upgrade response (x-sr header). */
  private _upgradeStealthTier: number | undefined;
  /** Proxy tier bucket from last upgrade response (x-pt header: 1=cheap, 2=mid, 3=strong). */
  private _upgradeProxyTier: number | undefined;
  /** Credits consumed during this session (from Spider.metering event). */
  private _sessionCreditsUsed: number | undefined;

  constructor(opts: TransportOptions, emitter: SpiderEventEmitter) {
    this.opts = opts;
    this.currentBrowser = opts.browser === 'auto' ? 'chrome-h' : opts.browser;
    this.emitter = emitter;
    this._stealthLevel = opts.stealthLevel ?? 0;
  }

  get browser(): string {
    return this.currentBrowser;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get stealthLevel(): number {
    return this._stealthLevel;
  }

  set stealthLevel(level: number) {
    this._stealthLevel = Math.max(0, Math.min(3, level));
  }

  /** Credits remaining from the WebSocket upgrade response. */
  get upgradeCredits(): number | undefined {
    return this._upgradeCredits;
  }

  /** Active stealth tier from the WebSocket upgrade response. */
  get upgradeStealthTier(): number | undefined {
    return this._upgradeStealthTier;
  }

  /** Proxy tier bucket from the WebSocket upgrade response (1=cheap, 2=mid, 3=strong). */
  get upgradeProxyTier(): number | undefined {
    return this._upgradeProxyTier;
  }

  /** Credits consumed during this session (from server Spider.metering event). */
  get sessionCreditsUsed(): number | undefined {
    return this._sessionCreditsUsed;
  }

  /**
   * Request the current session cost from the server via Spider.getMetering.
   * This is a synchronous CDP-style request/response — no event-loop timing issues.
   * Returns the credits used so far, or the last known value if the request fails.
   */
  async requestMetering(timeoutMs = 3000): Promise<number> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return this._sessionCreditsUsed ?? 0;
    }

    const meteringId = 2147483640; // High ID to avoid collisions with client CDP IDs

    return new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        resolve(this._sessionCreditsUsed ?? 0);
      }, timeoutMs);

      // Temporarily intercept the response by wrapping the message handler
      const origHandler = this.messageHandler;
      this.messageHandler = (data: string) => {
        // Check if this is our Spider.getMetering response
        if (data.includes(`"id":${meteringId}`)) {
          try {
            const msg = JSON.parse(data);
            if (msg.id === meteringId && msg.result?.credits_used !== undefined) {
              clearTimeout(timer);
              this._sessionCreditsUsed = msg.result.credits_used;
              this.messageHandler = origHandler;
              resolve(msg.result.credits_used);
              return;
            }
          } catch { /* not valid JSON, pass through */ }
        }
        // Forward all other messages to the original handler
        if (origHandler) origHandler(data);
      };

      try {
        this.send(JSON.stringify({ id: meteringId, method: 'Spider.getMetering' }));
      } catch {
        clearTimeout(timer);
        this.messageHandler = origHandler;
        resolve(this._sessionCreditsUsed ?? 0);
      }
    });
  }

  /** Set the handler that receives raw JSON messages from the WebSocket. */
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  /** Connect to the Spider WebSocket with retry. */
  async connect(maxAttempts = 3): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.connectInternal();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Don't retry auth errors
        if (lastError instanceof AuthError) throw lastError;
        if (attempt < maxAttempts) {
          const backoff = 500 * attempt;
          logger.warn(`connect attempt ${attempt}/${maxAttempts} failed, retrying in ${backoff}ms`, {
            error: lastError.message,
          });
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    throw lastError!;
  }

  /** Reconnect with a different browser type (used by retry engine). */
  async reconnect(browser: string): Promise<void> {
    const prev = this.currentBrowser;
    this.currentBrowser = browser;
    this.close();
    logger.info(`switching browser: ${prev} -> ${browser}`);
    return this.connectInternal();
  }

  /** Send a raw JSON string through the WebSocket. */
  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError('WebSocket is not connected');
    }
    this.ws.send(data);
  }

  /** Close the WebSocket connection, removing event listeners to prevent data mixing. */
  close(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;

      // Remove non-error listeners first to prevent stale messages from being
      // routed to the new adapter after reconnect().
      ws.removeAllListeners('message');
      ws.removeAllListeners('open');
      ws.removeAllListeners('close');
      ws.removeAllListeners('upgrade');

      // Replace the error handler with a no-op. Doing removeAllListeners('error')
      // followed by on('error') is safer than removeAllListeners() which strips
      // ALL handlers — the ws library's Receiver can emit errors during terminate()
      // teardown, and any micro-gap without an error handler crashes the process.
      ws.removeAllListeners('error');
      ws.on('error', () => {});

      try {
        // terminate() immediately destroys the socket — no close handshake.
        // This prevents the old WS from processing any more incoming data.
        ws.terminate();
      } catch {
        // ignore
      }
    }
  }

  private buildUrl(): string {
    const base = this.opts.serverUrl.replace(/\/$/, '');
    const params = new URLSearchParams();
    params.set('token', this.opts.apiKey);
    if (this.currentBrowser !== 'auto') {
      params.set('browser', this.currentBrowser);
    }
    if (this.opts.url) {
      params.set('url', this.opts.url);
    }
    if (this.opts.captcha && this.opts.captcha !== 'off') {
      params.set('ai_captcha', this.opts.captcha);
    }
    if (this._stealthLevel > 0) {
      params.set('s', String(this._stealthLevel));
    }
    if (this.opts.hedge) {
      params.set('hedge', 'true');
    }
    if (this.opts.record) {
      params.set('record', 'true');
    }
    if (this.opts.mode) {
      params.set('mode', this.opts.mode);
    }
    if (this.opts.country) {
      params.set('country', this.opts.country);
    }
    return `${base}/v1/browser?${params.toString()}`;
  }

  private connectInternal(): Promise<void> {
    // Bump generation — any messages from previous WS instances with a stale
    // generation will be silently dropped (belt-and-suspenders with removeAllListeners).
    const gen = ++this.generation;

    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      logger.debug(`connecting to ${url.replace(/token=[^&]+/, 'token=***')}`);

      const ws = new WebSocket(url);
      let resolved = false;

      const connectMs = this.opts.connectTimeoutMs ?? 30_000;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.removeAllListeners();
          ws.on('error', () => {}); // Prevent unhandled error crash
          ws.terminate();
          reject(new TimeoutError(`WebSocket connection timeout (${connectMs}ms)`));
        }
      }, connectMs);

      ws.on('upgrade', (response: import('http').IncomingMessage) => {
        // Capture credit/stealth/proxy-tier headers from the WebSocket upgrade response
        const sc = response.headers['x-sc'];
        const sr = response.headers['x-sr'];
        const pt = response.headers['x-pt'];
        if (sc) {
          this._upgradeCredits = parseFloat(String(sc));
        }
        if (sr) {
          this._upgradeStealthTier = parseInt(String(sr), 10);
        }
        if (pt) {
          this._upgradeProxyTier = parseInt(String(pt), 10);
        }
        if (this._upgradeCredits !== undefined) {
          this.emitter.emit('metering', {
            credits: this._upgradeCredits,
            rate: this._upgradeStealthTier ?? 0,
          });
        }
      });

      ws.on('open', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.ws = ws;
          this.emitter.emit('ws.open', {});
          logger.info(`connected (browser=${this.currentBrowser}, stealth=${this._stealthLevel})`);
          resolve();
        }
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        // Guard: ignore messages from stale WebSocket instances
        if (gen !== this.generation) return;
        const str = raw.toString();

        // Intercept Spider screencast/recording events from the server.
        if (str.includes('"Spider.')) {
          try {
            const msg = JSON.parse(str);
            if (msg.method === 'Spider.screencastFrame' && msg.params) {
              this.emitter.emit('screencast.frame', msg.params as SpiderEvents['screencast.frame']);
              return;
            }
            if (msg.method === 'Spider.interactionEvents' && msg.params) {
              this.emitter.emit('screencast.interactionEvents', msg.params as SpiderEvents['screencast.interactionEvents']);
              return;
            }
            if (msg.method === 'Spider.rrwebEvents' && msg.params) {
              this.emitter.emit('screencast.rrwebEvents', msg.params as SpiderEvents['screencast.rrwebEvents']);
              return;
            }
            if (msg.method === 'Spider.recordingStarted' && msg.params) {
              this.emitter.emit('recording.started', msg.params as SpiderEvents['recording.started']);
              return;
            }
            if (msg.method === 'Spider.recordingCompleted' && msg.params) {
              this.emitter.emit('recording.completed', msg.params as SpiderEvents['recording.completed']);
              return;
            }
          } catch { /* not valid JSON, pass through */ }
        }

        // Intercept Spider.metering events from the server.
        // Sent right before close with the exact session credits cost.
        if (str.includes('"Spider.metering"')) {
          try {
            const msg = JSON.parse(str);
            if (msg.method === 'Spider.metering' && msg.params?.credits_used !== undefined) {
              this._sessionCreditsUsed = msg.params.credits_used;
              this.emitter.emit('metering', {
                credits: this._upgradeCredits ?? 0,
                rate: this._upgradeStealthTier ?? 0,
                session_credits_used: msg.params.credits_used,
              });
              return; // Don't forward to CDP handler
            }
          } catch { /* not valid JSON, pass through */ }
        }

        if (this.messageHandler) {
          this.messageHandler(str);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        // Only emit events for the current generation
        if (gen === this.generation) {
          this.emitter.emit('ws.close', { code, reason: reasonStr });
        }

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (code === 4001 || code === 4002) {
            reject(new AuthError(`Authentication failed (code ${code}): ${reasonStr}`));
          } else if (code === 4003) {
            reject(new BackendUnavailableError(`Backend unavailable: ${reasonStr}`));
          } else {
            reject(new ConnectionError(`WebSocket closed during connect: ${code} ${reasonStr}`, code));
          }
        }
      });

      ws.on('error', (err: Error) => {
        if (gen === this.generation) {
          this.emitter.emit('ws.error', { error: err });
        }
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          // Server 429 = capacity full, not a connection error. Throw RateLimitError
          // so the retry engine applies backoff instead of marking browser as down.
          if (err.message.includes('429')) {
            reject(new RateLimitError('Server at capacity (429)'));
          } else {
            reject(new ConnectionError(`WebSocket error: ${err.message}`));
          }
        }
      });
    });
  }
}
