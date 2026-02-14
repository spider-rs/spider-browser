import type { Transport } from './transport.js';
import { CDPSession } from './cdp-session.js';
import { BiDiSession } from './bidi-session.js';
import { SpiderEventEmitter } from '../events/emitter.js';
import { getKeyParams } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Unified protocol interface that wraps either CDPSession or BiDiSession
 * based on the browser type.
 *
 * - chrome, chrome-new, chrome-h, servo, lightpanda → CDP
 * - firefox → BiDi
 */
export interface ProtocolAdapterOptions {
  commandTimeoutMs?: number;
}

export class ProtocolAdapter {
  private cdp: CDPSession | null = null;
  private bidi: BiDiSession | null = null;
  private transport: Transport;
  private emitter: SpiderEventEmitter;
  private protocol: 'cdp' | 'bidi' | 'auto';
  private adapterOpts: ProtocolAdapterOptions;

  constructor(transport: Transport, emitter: SpiderEventEmitter, browser: string, opts?: ProtocolAdapterOptions) {
    this.transport = transport;
    this.emitter = emitter;
    this.adapterOpts = opts ?? {};

    const sessionOpts = opts?.commandTimeoutMs ? { commandTimeoutMs: opts.commandTimeoutMs } : undefined;

    // Determine protocol from browser type
    if (browser === 'auto') {
      this.protocol = 'auto';
      // Don't create sessions yet — auto-detect in init()
    } else if (browser === 'firefox') {
      this.protocol = 'bidi';
      this.bidi = new BiDiSession(transport, sessionOpts);
    } else {
      this.protocol = 'cdp';
      this.cdp = new CDPSession(transport, sessionOpts);
    }

    // Wire up message routing
    transport.onMessage((data: string) => this.routeMessage(data));
  }

  /** Whether this adapter uses CDP or BiDi (or 'auto' before init). */
  get protocolType(): 'cdp' | 'bidi' | 'auto' {
    return this.protocol;
  }

  /** Route incoming WebSocket messages to the right session + spider events. */
  private routeMessage(data: string): void {
    // Check for Spider.* events first
    try {
      const msg = JSON.parse(data);
      if (typeof msg.method === 'string' && msg.method.startsWith('Spider.')) {
        this.handleSpiderEvent(msg.method, msg.params ?? {});
        return;
      }
    } catch {
      // ignore parse errors for spider event check
    }

    // Route to protocol session
    if (this.cdp) {
      this.cdp.handleMessage(data);
    } else if (this.bidi) {
      this.bidi.handleMessage(data);
    }
  }

  /** Handle Spider.* custom events from the server. */
  private handleSpiderEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Spider.captchaDetected':
        this.emitter.emit('captcha.detected', {
          types: (params.types as string[]) ?? [],
          url: (params.url as string) ?? '',
        });
        break;
      case 'Spider.captchaSolving':
        this.emitter.emit('captcha.solving', {
          types: (params.types as string[]) ?? [],
          url: (params.url as string) ?? '',
          round: (params.round as number) ?? 0,
        });
        break;
      case 'Spider.captchaSolved':
        this.emitter.emit('captcha.solved', { url: (params.url as string) ?? '' });
        break;
      case 'Spider.captchaFailed':
        this.emitter.emit('captcha.failed', {
          url: (params.url as string) ?? '',
          reason: (params.reason as string) ?? '',
        });
        break;
      default:
        logger.debug(`unhandled Spider event: ${method}`, params);
    }
  }

  // -------------------------------------------------------------------
  // Unified interface — all methods work for both CDP and BiDi
  // -------------------------------------------------------------------

  /**
   * Initialize the protocol session.
   *
   * For CDP (Chrome/Servo/LightPanda): discovers page targets, attaches to one
   * with flatten:true to get a sessionId, then enables Page + Runtime domains
   * on that target. This is required because the server proxies to Chrome's
   * browser-level CDP endpoint.
   *
   * For BiDi (Firefox): gets or creates a browsing context.
   *
   * For "auto" mode: tries CDP first (Target.setDiscoverTargets). If it fails
   * (e.g. we actually got a BiDi session), falls back to BiDi.
   */
  async init(): Promise<void> {
    if (this.protocol === 'auto') {
      await this.autoDetectAndInit();
      return;
    }

    if (this.cdp) {
      await this.cdp.attachToPage();
    } else if (this.bidi) {
      await this.bidi.getOrCreateContext();
    }
  }

  /**
   * Auto-detect protocol by trying CDP first, falling back to BiDi.
   * Used when browser type is "auto" and we don't know what the server gave us.
   */
  private async autoDetectAndInit(): Promise<void> {
    const sessionOpts = this.adapterOpts.commandTimeoutMs
      ? { commandTimeoutMs: this.adapterOpts.commandTimeoutMs }
      : undefined;

    // Try CDP first (most common — Chrome is the default)
    try {
      this.cdp = new CDPSession(this.transport, sessionOpts);
      // Re-wire message routing to include CDP
      this.transport.onMessage((data: string) => this.routeMessage(data));
      await this.cdp.attachToPage();
      this.protocol = 'cdp';
      logger.info('auto-detected CDP protocol');
      return;
    } catch {
      // CDP failed — likely a BiDi session
      this.cdp?.destroy();
      this.cdp = null;
    }

    // Try BiDi
    this.bidi = new BiDiSession(this.transport, sessionOpts);
    this.transport.onMessage((data: string) => this.routeMessage(data));
    await this.bidi.getOrCreateContext();
    this.protocol = 'bidi';
    logger.info('auto-detected BiDi protocol');
  }

  /** Navigate to URL. */
  async navigate(url: string): Promise<void> {
    if (this.cdp) {
      await this.cdp.navigate(url);
    } else {
      await this.bidi!.navigate(url);
    }
  }

  /** Navigate without waiting for full load — for use with polling content extraction. */
  async navigateFast(url: string): Promise<void> {
    if (this.cdp) {
      await this.cdp.navigateFast(url);
    } else {
      await this.bidi!.navigate(url); // BiDi doesn't support fast nav, use regular
    }
  }

  /** Navigate and return on DOMContentLoaded (3s max) — fastest option for SPAs. */
  async navigateDom(url: string): Promise<void> {
    if (this.cdp) {
      await this.cdp.navigateDom(url);
    } else {
      await this.bidi!.navigate(url); // BiDi doesn't support DOM nav, use regular
    }
  }

  /** Get page HTML. */
  async getHTML(): Promise<string> {
    if (this.cdp) {
      return this.cdp.getHTML();
    }
    return this.bidi!.getHTML();
  }

  /** Evaluate JavaScript expression. */
  async evaluate(expression: string): Promise<unknown> {
    if (this.cdp) {
      return this.cdp.evaluate(expression);
    }
    return this.bidi!.evaluate(expression);
  }

  /** Capture screenshot as base64 PNG. */
  async captureScreenshot(): Promise<string> {
    if (this.cdp) {
      return this.cdp.captureScreenshot();
    }
    return this.bidi!.captureScreenshot();
  }

  /** Click at viewport coordinates. */
  async clickPoint(x: number, y: number): Promise<void> {
    if (this.cdp) {
      await this.cdp.clickPoint(x, y);
    } else {
      await this.bidi!.clickPoint(x, y);
    }
  }

  /** Right-click at coordinates. */
  async rightClickPoint(x: number, y: number): Promise<void> {
    if (this.cdp) {
      await this.cdp.rightClickPoint(x, y);
    } else {
      // BiDi right-click via pointer actions
      await this.bidi!.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          actions: [
            { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 2 },
            { type: 'pointerUp', button: 2 },
          ],
        },
      ]);
    }
  }

  /** Double-click at coordinates. */
  async doubleClickPoint(x: number, y: number): Promise<void> {
    if (this.cdp) {
      await this.cdp.doubleClickPoint(x, y);
    } else {
      await this.bidi!.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          actions: [
            { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
    }
  }

  /** Click and hold at coordinates. */
  async clickHoldPoint(x: number, y: number, holdMs: number): Promise<void> {
    if (this.cdp) {
      await this.cdp.clickHoldPoint(x, y, holdMs);
    } else {
      await this.bidi!.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          actions: [
            { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: holdMs },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
    }
  }

  /** Hover at coordinates. */
  async hoverPoint(x: number, y: number): Promise<void> {
    if (this.cdp) {
      await this.cdp.hoverPoint(x, y);
    } else {
      await this.bidi!.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }],
        },
      ]);
    }
  }

  /** Smooth drag from point to point. */
  async dragPoint(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    if (this.cdp) {
      await this.cdp.dragPoint(fromX, fromY, toX, toY);
    } else {
      const steps = 10;
      const actions: any[] = [
        { type: 'pointerMove', x: Math.round(fromX), y: Math.round(fromY) },
        { type: 'pointerDown', button: 0 },
      ];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        actions.push({
          type: 'pointerMove',
          x: Math.round(fromX + (toX - fromX) * t),
          y: Math.round(fromY + (toY - fromY) * t),
          duration: 16,
        });
      }
      actions.push({ type: 'pointerUp', button: 0 });
      await this.bidi!.performActions([{ type: 'pointer', id: 'mouse', actions }]);
    }
  }

  /** Insert text. */
  async insertText(text: string): Promise<void> {
    if (this.cdp) {
      await this.cdp.insertText(text);
    } else {
      await this.bidi!.insertText(text);
    }
  }

  /** Press a named key (e.g. "Enter", "Tab"). */
  async pressKey(keyName: string): Promise<void> {
    const { key, code, keyCode } = getKeyParams(keyName);
    if (this.cdp) {
      await this.cdp.pressKey(key, code, keyCode);
    } else {
      await this.bidi!.performActions([
        {
          type: 'key',
          id: 'keyboard',
          actions: [
            { type: 'keyDown', value: key },
            { type: 'keyUp', value: key },
          ],
        },
      ]);
    }
  }

  /** Send keyDown. */
  async keyDown(keyName: string): Promise<void> {
    const { key, code, keyCode } = getKeyParams(keyName);
    if (this.cdp) {
      await this.cdp.keyDown(key, code, keyCode);
    } else {
      await this.bidi!.performActions([
        { type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: key }] },
      ]);
    }
  }

  /** Send keyUp. */
  async keyUp(keyName: string): Promise<void> {
    const { key, code, keyCode } = getKeyParams(keyName);
    if (this.cdp) {
      await this.cdp.keyUp(key, code, keyCode);
    } else {
      await this.bidi!.performActions([
        { type: 'key', id: 'keyboard', actions: [{ type: 'keyUp', value: key }] },
      ]);
    }
  }

  /** Set viewport dimensions. */
  async setViewport(
    width: number,
    height: number,
    deviceScaleFactor: number = 2,
    mobile: boolean = false,
  ): Promise<void> {
    if (this.cdp) {
      await this.cdp.setViewport(width, height, deviceScaleFactor, mobile);
    } else {
      // BiDi doesn't have a direct viewport override — use script
      await this.bidi!.evaluate(
        `window.resizeTo(${width}, ${height})`,
      );
    }
  }

  /** Subscribe to a CDP domain event (only relevant for CDP). */
  onProtocolEvent(method: string, handler: (params: Record<string, unknown>) => void): void {
    if (this.cdp) {
      this.cdp.on(method, handler);
    } else if (this.bidi) {
      this.bidi.on(method, handler);
    }
  }

  /** Clean up resources. Nulls references first to prevent stale message routing. */
  destroy(): void {
    const cdp = this.cdp;
    const bidi = this.bidi;
    // Null out first so routeMessage() drops any in-flight messages during destroy
    this.cdp = null;
    this.bidi = null;
    cdp?.destroy();
    bidi?.destroy();
  }
}
