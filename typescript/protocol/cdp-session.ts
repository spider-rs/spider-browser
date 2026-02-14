import type { Transport } from './transport.js';
import type { CDPResponse, CDPEvent } from './types.js';
import { NavigationError, ProtocolError, TimeoutError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

type PendingResolver = {
  resolve: (value: CDPResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (params: Record<string, unknown>) => void;

/**
 * CDP JSON-RPC session over the Spider WebSocket transport.
 *
 * The server proxies to Chrome's BROWSER-LEVEL CDP target.
 * This means we must:
 *   1. Discover/create a page target
 *   2. Attach to it with flatten: true to get a sessionId
 *   3. Send all Page/Runtime/Input commands with that sessionId
 *
 * Used for Chrome, Chrome-H, Servo, and LightPanda browsers.
 */
export class CDPSession {
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private transport: Transport;
  /** CDP session ID from Target.attachToTarget (required for page-level commands). */
  private targetSessionId: string | undefined;
  private commandTimeoutMs: number;

  constructor(transport: Transport, opts?: { commandTimeoutMs?: number }) {
    this.transport = transport;
    this.commandTimeoutMs = opts?.commandTimeoutMs ?? 30_000;
  }

  /** Get the attached target session ID. */
  get sessionId(): string | undefined {
    return this.targetSessionId;
  }

  /** Process a raw message from the transport. Returns true if handled. */
  handleMessage(data: string): boolean {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return false;
    }

    // Response to a command (has "id")
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg as CDPResponse);
        return true;
      }
      return false;
    }

    // Event (has "method", no "id")
    if (typeof msg.method === 'string') {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        const params = msg.params ?? {};
        for (const h of handlers) {
          try {
            h(params);
          } catch {
            // ignore handler errors
          }
        }
      }
      // Also fire wildcard handlers (for target discovery)
      const wildcardHandlers = this.eventHandlers.get('*');
      if (wildcardHandlers) {
        for (const h of wildcardHandlers) {
          try {
            h({ method: msg.method, ...(msg.params ?? {}) });
          } catch {
            // ignore
          }
        }
      }
      return true;
    }

    return false;
  }

  /** Send a CDP command and wait for the response. */
  async send(method: string, params?: Record<string, unknown>): Promise<CDPResponse> {
    const id = this.nextId++;
    const cmd: any = { id, method, params: params ?? {} };

    return new Promise<CDPResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`CDP command timeout: ${method} (${this.commandTimeoutMs}ms)`));
      }, this.commandTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send(JSON.stringify(cmd));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Send a CDP command scoped to the attached page session.
   * This is what you use for Page.*, Runtime.*, Input.* commands.
   */
  async sendToTarget(method: string, params?: Record<string, unknown>): Promise<CDPResponse> {
    if (!this.targetSessionId) {
      throw new ProtocolError('No target session — call attachToPage() first');
    }
    const id = this.nextId++;
    const cmd: any = {
      id,
      method,
      params: params ?? {},
      sessionId: this.targetSessionId,
    };

    return new Promise<CDPResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`CDP command timeout: ${method} (${this.commandTimeoutMs}ms)`));
      }, this.commandTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send(JSON.stringify(cmd));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Subscribe to a CDP event. */
  on(method: string, handler: EventHandler): void {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
  }

  /** Unsubscribe from a CDP event. */
  off(method: string, handler: EventHandler): void {
    this.eventHandlers.get(method)?.delete(handler);
  }

  // -------------------------------------------------------------------
  // Browser-level target management
  // -------------------------------------------------------------------

  /**
   * Discover page targets, find or create one, attach to it, and enable
   * the required CDP domains (Page, Runtime).
   *
   * This is the key initialization step — without this, Page.navigate and
   * Runtime.evaluate won't work because we're connected at browser level.
   */
  async attachToPage(): Promise<string> {
    // Step 1: Enable target discovery
    await this.send('Target.setDiscoverTargets', { discover: true });

    // Step 2: Always create a fresh page target.
    // When multiple sessions share a Chrome instance, reusing existing page targets
    // causes content contamination (wrong cookies, storage, cached content).
    // The server injects browserContextId into Target.createTarget to isolate
    // each session's pages in their own browser context.
    let pageTargetId: string | undefined;
    logger.debug('creating fresh page target for session isolation');
    const createResp = await this.send('Target.createTarget', { url: 'about:blank' });
    pageTargetId = (createResp.result as any)?.targetId;
    if (!pageTargetId) {
      throw new ProtocolError('Failed to create page target');
    }
    logger.debug(`created page target: ${pageTargetId}`);

    // Step 4: Attach to the target with flatten: true
    // flatten: true gives us a flat session — commands with sessionId go directly to the target
    const attachResp = await this.send('Target.attachToTarget', {
      targetId: pageTargetId,
      flatten: true,
    });

    // The sessionId comes either from the response or from a Target.attachedToTarget event
    let sessionId = (attachResp.result as any)?.sessionId;

    if (!sessionId) {
      // Some Chrome versions send the sessionId via an event instead
      // Wait briefly for the event
      sessionId = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.off('Target.attachedToTarget', handler);
          reject(new TimeoutError('Timeout waiting for Target.attachedToTarget event'));
        }, 5000);

        const handler = (params: Record<string, unknown>) => {
          const sid = (params as any).sessionId;
          if (sid) {
            clearTimeout(timeout);
            this.off('Target.attachedToTarget', handler);
            resolve(sid);
          }
        };
        this.on('Target.attachedToTarget', handler);
      });
    }

    this.targetSessionId = sessionId;
    logger.info(`attached to page target`, { targetId: pageTargetId, sessionId });

    // Step 5: Enable domains on the target session
    await this.sendToTarget('Page.enable');
    await this.sendToTarget('Runtime.enable');

    return sessionId;
  }

  // -------------------------------------------------------------------
  // High-level CDP commands (all use sendToTarget for page-scoped ops)
  // -------------------------------------------------------------------

  /** Capture a screenshot as base64 PNG (10s timeout to avoid blocking on heavy pages). */
  async captureScreenshot(): Promise<string> {
    const screenshotTimeout = Math.min(this.commandTimeoutMs, 10_000);
    const id = this.nextId++;
    const cmd: any = {
      id,
      method: 'Page.captureScreenshot',
      params: { format: 'png' },
      sessionId: this.targetSessionId,
    };

    const resp = await new Promise<CDPResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`CDP command timeout: Page.captureScreenshot (${screenshotTimeout}ms)`));
      }, screenshotTimeout);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send(JSON.stringify(cmd));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });

    const data = resp.result?.['data'];
    if (typeof data !== 'string') {
      throw new ProtocolError('captureScreenshot: missing result.data');
    }
    return data;
  }

  /** Get full page HTML. */
  async getHTML(): Promise<string> {
    const resp = await this.sendToTarget('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    return this.extractEvalValue(resp) as string;
  }

  /** Evaluate a JavaScript expression and return the value. */
  async evaluate(expression: string): Promise<unknown> {
    const resp = await this.sendToTarget('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    return this.extractEvalValue(resp);
  }

  /** Wait for a CDP event to fire, with timeout. Returns true if event fired, false on timeout. */
  private waitForEvent(method: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.off(method, handler);
        resolve(false);
      }, timeoutMs);

      const handler = () => {
        clearTimeout(timer);
        this.off(method, handler);
        resolve(true);
      };
      this.on(method, handler);
    });
  }

  /** Navigate to a URL and wait for the page to load.
   *
   * Uses short timeouts (8s load + 10s fallback = 10s max after load timeout) because:
   * - Most pages fire loadEventFired in <5s
   * - SPAs that don't fire it in 8s rarely will (they use client-side rendering)
   * - content() has built-in SPA polling that handles incomplete loads gracefully
   * - Short navigate means more page timeout budget for retries and content extraction
   */
  async navigate(url: string): Promise<void> {
    // Start listening for load events BEFORE sending navigate
    const loadPromise = this.waitForEvent('Page.loadEventFired', 8_000);
    const stopPromise = this.waitForEvent('Page.frameStoppedLoading', 10_000);

    const resp = await this.sendToTarget('Page.navigate', { url });

    // Check for navigation errors (e.g. net::ERR_NAME_NOT_RESOLVED)
    const errorText = (resp.result as any)?.errorText;
    if (errorText) {
      // Clean up event listeners
      loadPromise.catch(() => {});
      stopPromise.catch(() => {});
      // Retryable nav errors: close connection and try fresh
      if (isRetryableNavError(errorText)) {
        throw new NavigationError(`Navigation failed: ${errorText}`);
      }
      throw new ProtocolError(`Navigation failed: ${errorText}`);
    }

    // Wait for load event; if it times out, fall back to frameStoppedLoading
    const loaded = await loadPromise;
    if (!loaded) {
      // loadEventFired timed out — wait briefly for frameStoppedLoading
      await stopPromise;
      // Proceed silently even if both timed out — content() polls for content
    }
  }

  /**
   * Navigate without waiting for full page load — returns after the navigation
   * response is received and a brief initial load wait (5s).
   * Use with contentWithEarlyReturn() for SPAs that never fire loadEventFired.
   */
  async navigateFast(url: string): Promise<void> {
    const loadPromise = this.waitForEvent('Page.loadEventFired', 5_000);

    const resp = await this.sendToTarget('Page.navigate', { url });

    const errorText = (resp.result as any)?.errorText;
    if (errorText) {
      loadPromise.catch(() => {});
      if (isRetryableNavError(errorText)) {
        throw new NavigationError(`Navigation failed: ${errorText}`);
      }
      throw new ProtocolError(`Navigation failed: ${errorText}`);
    }

    // Wait up to 5s for load — if it fires, great. If not, proceed to polling.
    await loadPromise;
  }

  /**
   * Navigate and return as soon as DOMContentLoaded fires (3s max).
   * Much faster than navigate() for SPAs — the DOM shell is ready at
   * DOMContentLoaded, and content() polling handles async rendering.
   * Falls through silently if DOMContentLoaded doesn't fire.
   */
  async navigateDom(url: string): Promise<void> {
    const domPromise = this.waitForEvent('Page.domContentEventFired', 3_000);

    const resp = await this.sendToTarget('Page.navigate', { url });

    const errorText = (resp.result as any)?.errorText;
    if (errorText) {
      domPromise.catch(() => {});
      if (isRetryableNavError(errorText)) {
        throw new NavigationError(`Navigation failed: ${errorText}`);
      }
      throw new ProtocolError(`Navigation failed: ${errorText}`);
    }

    await domPromise;
  }

  /** Dispatch a mouse event. */
  async dispatchMouseEvent(
    type: string,
    x: number,
    y: number,
    button: string = 'none',
    clickCount: number = 0,
  ): Promise<void> {
    await this.sendToTarget('Input.dispatchMouseEvent', { type, x, y, button, clickCount });
  }

  /** Click at coordinates (mouseMoved -> mousePressed -> mouseReleased). */
  async clickPoint(x: number, y: number): Promise<void> {
    await this.dispatchMouseEvent('mouseMoved', x, y, 'none', 0);
    await this.dispatchMouseEvent('mousePressed', x, y, 'left', 1);
    await this.dispatchMouseEvent('mouseReleased', x, y, 'left', 1);
  }

  /** Right-click at coordinates. */
  async rightClickPoint(x: number, y: number): Promise<void> {
    await this.dispatchMouseEvent('mouseMoved', x, y, 'none', 0);
    await this.dispatchMouseEvent('mousePressed', x, y, 'right', 1);
    await this.dispatchMouseEvent('mouseReleased', x, y, 'right', 1);
  }

  /** Double-click at coordinates. */
  async doubleClickPoint(x: number, y: number): Promise<void> {
    await this.dispatchMouseEvent('mouseMoved', x, y, 'none', 0);
    await this.dispatchMouseEvent('mousePressed', x, y, 'left', 1);
    await this.dispatchMouseEvent('mouseReleased', x, y, 'left', 1);
    await this.dispatchMouseEvent('mousePressed', x, y, 'left', 2);
    await this.dispatchMouseEvent('mouseReleased', x, y, 'left', 2);
  }

  /** Click and hold at coordinates for a duration. */
  async clickHoldPoint(x: number, y: number, holdMs: number): Promise<void> {
    await this.dispatchMouseEvent('mouseMoved', x, y, 'none', 0);
    await this.dispatchMouseEvent('mousePressed', x, y, 'left', 1);
    await sleep(holdMs);
    await this.dispatchMouseEvent('mouseReleased', x, y, 'left', 1);
  }

  /** Hover (mouseMoved only). */
  async hoverPoint(x: number, y: number): Promise<void> {
    await this.dispatchMouseEvent('mouseMoved', x, y, 'none', 0);
  }

  /** Smooth drag from point to point (10-step interpolation). */
  async dragPoint(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    const steps = 10;
    await this.dispatchMouseEvent('mouseMoved', fromX, fromY, 'none', 0);
    await this.dispatchMouseEvent('mousePressed', fromX, fromY, 'left', 1);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = fromX + (toX - fromX) * t;
      const y = fromY + (toY - fromY) * t;
      await this.dispatchMouseEvent('mouseMoved', x, y, 'left', 0);
      await sleep(16);
    }
    await this.dispatchMouseEvent('mouseReleased', toX, toY, 'left', 1);
  }

  /** Insert text via Input.insertText. */
  async insertText(text: string): Promise<void> {
    await this.sendToTarget('Input.insertText', { text });
  }

  /** Press a key (keyDown + keyUp). */
  async pressKey(key: string, code: string, keyCode: number): Promise<void> {
    await this.sendToTarget('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      text: key,
    });
    await this.sendToTarget('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }

  /** Send keyDown event. */
  async keyDown(key: string, code: string, keyCode: number): Promise<void> {
    await this.sendToTarget('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      text: key,
    });
  }

  /** Send keyUp event. */
  async keyUp(key: string, code: string, keyCode: number): Promise<void> {
    await this.sendToTarget('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }

  /** Set viewport via Emulation.setDeviceMetricsOverride. */
  async setViewport(
    width: number,
    height: number,
    deviceScaleFactor: number = 2,
    mobile: boolean = false,
  ): Promise<void> {
    await this.sendToTarget('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  /** Clean up all pending commands and event handlers. Rejects in-flight commands. */
  destroy(): void {
    // Snapshot and clear first to prevent re-entrant issues from reject callbacks
    const pendingSnapshot = [...this.pending.values()];
    this.pending.clear();
    this.eventHandlers.clear();
    this.targetSessionId = undefined;

    for (const pending of pendingSnapshot) {
      clearTimeout(pending.timer);
      pending.reject(new Error('session destroyed'));
    }
  }

  private extractEvalValue(resp: CDPResponse): unknown {
    if (resp.error) {
      throw new ProtocolError(`CDP error: ${resp.error.message}`);
    }
    const result = resp.result as any;
    return result?.result?.value;
  }
}

/** Navigation errors that are retryable by closing the connection and reconnecting. */
const RETRYABLE_NAV_ERRORS = [
  'net::ERR_ABORTED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_TIMED_OUT',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_SOCKET_NOT_CONNECTED',
  'net::ERR_NETWORK_CHANGED',
];

function isRetryableNavError(errorText: string): boolean {
  return RETRYABLE_NAV_ERRORS.some((e) => errorText.includes(e));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
