import { Transport, type TransportOptions } from './protocol/transport.js';
import { ProtocolAdapter } from './protocol/protocol-adapter.js';
import { SpiderEventEmitter } from './events/emitter.js';
import type { Browser, SpiderEvents, SpiderEventName } from './events/types.js';
import { SpiderPage } from './page.js';
import { RetryEngine, type RetryOptions } from './retry/retry-engine.js';
import type { LLMConfig } from './ai/llm-provider.js';
import { createProvider, type LLMProvider } from './ai/llm-provider.js';
import { act } from './ai/act.js';
import { observe, type ObserveResult } from './ai/observe.js';
import { extract } from './ai/extract.js';
import { Agent, type AgentOptions, type AgentResult } from './ai/agent.js';
import { logger, type LogLevel } from './utils/logger.js';
import type { z } from 'zod';

export interface SpiderBrowserOptions {
  /** Spider API key (required). */
  apiKey: string;
  /** WebSocket server URL (default: wss://browser.spider.cloud). */
  serverUrl?: string;
  /**
   * Browser to use (default: `'auto'`).
   * - `'auto'` — server picks the best browser automatically.
   * - `'chrome'` — Chrome.
   * - `'firefox'` — Firefox.
   */
  browser?: Browser;
  /** Target URL hint for server browser+proxy selection. */
  url?: string;
  /** Captcha handling (default: solve). */
  captcha?: 'off' | 'detect' | 'solve';
  /** Enable smart retry with browser switching (default: true). */
  smartRetry?: boolean;
  /** Max retry attempts across all browsers (default: 3). */
  maxRetries?: number;
  /** Stealth level (1-3). Controls proxy quality tier. 0 or undefined = auto-escalate on failure. */
  stealth?: number;
  /** Country code for geo-located proxy (e.g. "US", "GB", "DE"). */
  country?: string;
  /** Maximum stealth level to auto-escalate to (1-3, default: 3). */
  maxStealthLevels?: number;
  /** LLM configuration for AI methods (optional). */
  llm?: LLMConfig;
  /** Log level (default: info). */
  logLevel?: LogLevel;
  /** WebSocket connect timeout in ms (default: 30000). */
  connectTimeoutMs?: number;
  /** CDP/BiDi command timeout in ms (default: 30000). */
  commandTimeoutMs?: number;
  /** Timeout for retry attempts — shorter than first try (default: 15000). */
  retryTimeoutMs?: number;
  /** Mark this session as a hedge (parallel attempt). Hedge sessions don't count
   *  toward per-user session limits on the server, allowing aggressive parallel racing. */
  hedge?: boolean;
  /** Enable screencast recording for this session (default: false). */
  record?: boolean;
  /** Browser mode: 'scraping' for fast text extraction, 'cua' for full rendering (video, PDF, Canvas). */
  mode?: 'scraping' | 'cua';
}

/**
 * SpiderBrowser — main entry point for spider-browser.
 *
 * Connects to Spider's pre-warmed browser fleet via WebSocket.
 * Provides deterministic page control (via SpiderPage) and
 * AI-powered automation (act, observe, extract, agent).
 *
 * Key features:
 * - Pre-warmed browsers (no cold start)
 * - Full stealth Chrome & Firefox
 * - Smart retry with automatic browser switching
 * - CDP (Chrome/Servo/LightPanda) + BiDi (Firefox) protocol support
 */
export class SpiderBrowser {
  private opts: Required<
    Pick<SpiderBrowserOptions, 'apiKey' | 'serverUrl' | 'browser' | 'captcha' | 'smartRetry' | 'maxRetries' | 'stealth' | 'maxStealthLevels' | 'connectTimeoutMs' | 'commandTimeoutMs' | 'retryTimeoutMs'>
  > & Pick<SpiderBrowserOptions, 'url' | 'llm' | 'hedge' | 'record' | 'mode' | 'country'>;
  private transport: Transport | null = null;
  private adapter: ProtocolAdapter | null = null;
  private retryEngine: RetryEngine | null = null;
  private emitter = new SpiderEventEmitter();
  private _page: SpiderPage | null = null;
  private llmProvider: LLMProvider | null = null;
  private currentUrl: string | undefined;

  constructor(options: SpiderBrowserOptions) {
    this.opts = {
      apiKey: options.apiKey,
      serverUrl: options.serverUrl ?? 'wss://browser.spider.cloud',
      browser: options.browser ?? 'auto',
      captcha: options.captcha ?? 'solve',
      smartRetry: options.smartRetry ?? true,
      maxRetries: options.maxRetries ?? 12,
      stealth: options.stealth ?? 0,
      maxStealthLevels: options.maxStealthLevels ?? 3,
      connectTimeoutMs: options.connectTimeoutMs ?? 30_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      retryTimeoutMs: options.retryTimeoutMs ?? 15_000,
      url: options.url,
      llm: options.llm,
      hedge: options.hedge,
      record: options.record,
      mode: options.mode,
      country: options.country,
    };

    if (options.logLevel) {
      logger.setLevel(options.logLevel);
    }

    if (this.opts.llm) {
      this.llmProvider = createProvider(this.opts.llm);
    }
  }

  /** The active page instance for deterministic browser control. */
  get page(): SpiderPage {
    if (!this._page) {
      throw new Error('SpiderBrowser not initialized. Call init() first.');
    }
    return this._page;
  }

  /** Current browser type. */
  get browser(): string {
    return this.transport?.browser ?? this.opts.browser;
  }

  /** Whether the WebSocket is connected. */
  get connected(): boolean {
    return this.transport?.connected ?? false;
  }

  /** Active stealth level (0=auto, 1-3=explicit tiers). */
  get stealthLevel(): number {
    return this.retryEngine?.stealthLevel ?? this.transport?.stealthLevel ?? this.opts.stealth;
  }

  /** Credits remaining from last upgrade response. */
  get credits(): number | undefined {
    return this.transport?.upgradeCredits;
  }

  /** Credits consumed during this session (from server Spider.metering event). */
  get sessionCreditsUsed(): number | undefined {
    return this.transport?.sessionCreditsUsed;
  }

  /**
   * Request the exact session cost from the server.
   * Unlike `sessionCreditsUsed` (which relies on async event delivery),
   * this sends a Spider.getMetering command and waits for the response.
   * Call this before close() for accurate per-session metering.
   */
  async getSessionCredits(): Promise<number> {
    if (!this.transport) return 0;
    return this.transport.requestMetering();
  }

  /** Subscribe to events. */
  on<K extends SpiderEventName>(event: K, handler: (data: SpiderEvents[K]) => void): this {
    this.emitter.on(event, handler);
    return this;
  }

  /** Unsubscribe from events. */
  off<K extends SpiderEventName>(event: K, handler: (data: SpiderEvents[K]) => void): this {
    this.emitter.off(event, handler);
    return this;
  }

  /** Subscribe to an event once. */
  once<K extends SpiderEventName>(event: K, handler: (data: SpiderEvents[K]) => void): this {
    this.emitter.once(event, handler);
    return this;
  }

  /**
   * Connect to the browser server WebSocket and initialize the protocol.
   */
  async init(): Promise<void> {
    const transportOpts: TransportOptions = {
      apiKey: this.opts.apiKey,
      serverUrl: this.opts.serverUrl,
      browser: this.opts.browser,
      url: this.opts.url,
      captcha: this.opts.captcha,
      stealthLevel: this.opts.stealth,
      connectTimeoutMs: this.opts.connectTimeoutMs,
      commandTimeoutMs: this.opts.commandTimeoutMs,
      hedge: this.opts.hedge,
      record: this.opts.record,
      mode: this.opts.mode,
      country: this.opts.country,
    };

    this.transport = new Transport(transportOpts, this.emitter);
    await this.transport.connect();

    const activeBrowser = this.transport.browser;
    this.adapter = new ProtocolAdapter(this.transport, this.emitter, activeBrowser, {
      commandTimeoutMs: this.opts.commandTimeoutMs,
    });
    await this.adapter.init();

    this._page = new SpiderPage(this.adapter);

    if (this.opts.smartRetry) {
      const retryOpts: RetryOptions = {
        maxRetries: this.opts.maxRetries,
        transportOpts,
        emitter: this.emitter,
        maxStealthLevel: this.opts.maxStealthLevels,
        retryTimeoutMs: this.opts.retryTimeoutMs,
        commandTimeoutMs: this.opts.commandTimeoutMs,
      };
      this.retryEngine = new RetryEngine(retryOpts);
    }

    this.currentUrl = this.opts.url;
    logger.info('SpiderBrowser initialized', { browser: activeBrowser });
  }

  /**
   * Execute an action with smart retry. On failure, classifies the error and
   * may switch browsers, reconnect, re-navigate, and retry.
   */
  async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.retryEngine || !this.transport || !this.adapter) {
      return fn();
    }

    return this.retryEngine.execute(fn, {
      transport: this.transport,
      adapter: this.adapter,
      page: this._page!,
      currentUrl: this.currentUrl,
      onAdapterChanged: (newAdapter) => {
        this.adapter = newAdapter;
        this._page!._setAdapter(newAdapter);
      },
    });
  }

  // -------------------------------------------------------------------
  // Navigation (with retry)
  // -------------------------------------------------------------------

  /**
   * Navigate to a URL with smart retry.
   *
   * On ERR_ABORTED: closes the WebSocket, reconnects, and retries.
   * On bot detection: switches to a different browser and retries.
   *
   * Also updates `currentUrl` for subsequent retries on other operations.
   */
  async goto(url: string): Promise<void> {
    this.currentUrl = url;
    await this.withRetry(async () => {
      await this._page!.goto(url);
    });
  }

  // -------------------------------------------------------------------
  // AI Methods (require LLM config)
  // -------------------------------------------------------------------

  /**
   * Execute a single action from natural language.
   *
   * Example: `await browser.act('Click the login button')`
   */
  async act(instruction: string): Promise<void> {
    this.requireLLM();
    await this.withRetry(() => act(this.adapter!, this.llmProvider!, instruction));
  }

  /**
   * Discover interactive elements on the page.
   *
   * Works WITHOUT an LLM — injects DOM traversal to collect elements.
   * When instruction is provided + LLM is configured, adds ranking/filtering.
   */
  async observe(instruction?: string): Promise<ObserveResult[]> {
    return this.withRetry(() =>
      observe(this.adapter!, instruction, this.llmProvider ?? undefined),
    );
  }

  /**
   * Extract structured data from the page.
   *
   * Example: `await browser.extract('Product name and price', { schema: z.object({...}) })`
   */
  async extract<T>(
    instruction: string,
    options?: { schema?: z.ZodType<T> },
  ): Promise<T> {
    this.requireLLM();
    return this.withRetry(() =>
      extract(this.adapter!, this.llmProvider!, instruction, options?.schema),
    );
  }

  /**
   * Create an autonomous agent that executes multi-step tasks.
   *
   * Uses the same action vocabulary and system prompt as Spider's
   * server-side captcha solver for consistent behavior.
   */
  agent(options?: Partial<AgentOptions>): Agent {
    this.requireLLM();
    return new Agent(this.adapter!, this.llmProvider!, this.emitter, options);
  }

  /**
   * Close the connection and clean up resources.
   *
   * Disconnects the WebSocket. The server automatically handles page/target
   * cleanup on disconnect (disposes browser contexts, closes orphaned targets,
   * deletes backend sessions). The browser process itself is NOT closed —
   * it's pre-warmed and shared across sessions.
   */
  async close(): Promise<void> {
    this.adapter?.destroy();
    this.transport?.close();
    this.emitter.removeAllListeners();
    this._page = null;
    this.adapter = null;
    this.transport = null;
    logger.info('SpiderBrowser closed');
  }

  private requireLLM(): void {
    if (!this.llmProvider) {
      throw new Error(
        'LLM not configured. Pass `llm` option to SpiderBrowser constructor for AI methods.',
      );
    }
  }
}
