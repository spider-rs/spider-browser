import type { Transport } from './transport.js';
import type { BiDiResponse } from './types.js';
import { ProtocolError, TimeoutError } from '../utils/errors.js';

type PendingResolver = {
  resolve: (value: BiDiResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (params: Record<string, unknown>) => void;

/**
 * WebDriver BiDi session over the Spider WebSocket transport.
 *
 * Used for Firefox browser connections. Mirrors CDPSession's interface
 * but speaks the BiDi protocol.
 */
export class BiDiSession {
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private transport: Transport;
  private browsingContext: string | undefined;
  private commandTimeoutMs: number;

  constructor(transport: Transport, opts?: { commandTimeoutMs?: number }) {
    this.transport = transport;
    this.commandTimeoutMs = opts?.commandTimeoutMs ?? 30_000;
  }

  get context(): string | undefined {
    return this.browsingContext;
  }

  /** Process a raw message from the transport. Returns true if handled. */
  handleMessage(data: string): boolean {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return false;
    }

    // Response (has "id" and "type")
    if (typeof msg.id === 'number' && typeof msg.type === 'string') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg as BiDiResponse);
        return true;
      }
      return false;
    }

    // Event (has "type": "event" and "method")
    if (msg.type === 'event' && typeof msg.method === 'string') {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        const params = msg.params ?? {};
        for (const h of handlers) {
          try {
            h(params);
          } catch {
            // ignore
          }
        }
      }
      return true;
    }

    return false;
  }

  /** Send a BiDi command and wait for the response. */
  async send(method: string, params: Record<string, unknown>): Promise<BiDiResponse> {
    const id = this.nextId++;
    const cmd = { id, method, params };

    return new Promise<BiDiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`BiDi command timeout: ${method} (${this.commandTimeoutMs}ms)`));
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

  /** Subscribe to a BiDi event. */
  on(method: string, handler: EventHandler): void {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
  }

  /** Unsubscribe from a BiDi event. */
  off(method: string, handler: EventHandler): void {
    this.eventHandlers.get(method)?.delete(handler);
  }

  // -------------------------------------------------------------------
  // High-level BiDi commands
  // -------------------------------------------------------------------

  /**
   * Get or create a browsing context.
   *
   * The server's Firefox relay proxies to geckodriver which already has
   * a session with a browsing context. We try multiple strategies:
   * 1. browsingContext.getTree (standard BiDi)
   * 2. session.status (to get session info, then extract context)
   * 3. browsingContext.create as last resort
   *
   * If all discovery fails, we set a placeholder context that gets replaced
   * on the first successful navigate response.
   */
  async getOrCreateContext(): Promise<string> {
    if (this.browsingContext) return this.browsingContext;

    // Strategy 1: Try browsingContext.getTree with a short timeout
    try {
      const savedTimeout = this.commandTimeoutMs;
      try {
        this.commandTimeoutMs = 5000;
        const resp = await this.send('browsingContext.getTree', {});
        const contexts = (resp.result as any)?.contexts;
        if (Array.isArray(contexts) && contexts.length > 0) {
          this.browsingContext = contexts[0].context;
          return this.browsingContext!;
        }
      } finally {
        this.commandTimeoutMs = savedTimeout;
      }
    } catch {
      // getTree not supported or timed out — try other strategies
    }

    // Strategy 2: Try creating a new context
    try {
      const savedTimeout = this.commandTimeoutMs;
      try {
        this.commandTimeoutMs = 5000;
        const createResp = await this.send('browsingContext.create', { type: 'tab' });
        const ctx = (createResp.result as any)?.context;
        if (ctx) {
          this.browsingContext = ctx;
          return this.browsingContext!;
        }
      } finally {
        this.commandTimeoutMs = savedTimeout;
      }
    } catch {
      // create not supported either
    }

    // Strategy 3: Use a placeholder — the geckodriver session already has a context,
    // and browsingContext.navigate/script.evaluate commands will use it implicitly.
    // We'll extract the real context ID from the first navigation response.
    this.browsingContext = '__default__';
    return this.browsingContext;
  }

  /** Set the browsing context (called when we discover it from a response). */
  setContext(contextId: string): void {
    this.browsingContext = contextId;
  }

  /** Navigate to a URL. */
  async navigate(url: string): Promise<void> {
    const ctx = await this.getOrCreateContext();
    const resp = await this.send('browsingContext.navigate', {
      context: ctx,
      url,
      wait: 'complete',
    });
    // Extract real context from response if we used a placeholder
    if (this.browsingContext === '__default__') {
      const realCtx = (resp.result as any)?.navigation
        ? (resp as any)?.params?.context
        : undefined;
      if (realCtx) {
        this.browsingContext = realCtx;
      }
    }
  }

  /** Capture a screenshot as base64 PNG. */
  async captureScreenshot(): Promise<string> {
    const ctx = await this.getOrCreateContext();
    const resp = await this.send('browsingContext.captureScreenshot', { context: ctx });
    const data = (resp.result as any)?.data;
    if (typeof data !== 'string') {
      throw new ProtocolError('captureScreenshot: missing result.data');
    }
    return data;
  }

  /**
   * Evaluate JavaScript and return the value.
   *
   * BiDi script.evaluate returns results in this format:
   *   { result: { type: "string", value: "..." } }
   *   { result: { type: "number", value: 42 } }
   *   { result: { type: "boolean", value: true } }
   *   { result: { type: "object", value: [...entries...] } }
   *   { result: { type: "null" } }
   *   { result: { type: "undefined" } }
   *   { result: { type: "array", value: [...] } }
   */
  async evaluate(expression: string): Promise<unknown> {
    const ctx = await this.getOrCreateContext();
    const resp = await this.send('script.evaluate', {
      expression,
      target: { context: ctx },
      awaitPromise: false,
      resultOwnership: 'none',
    });
    if (resp.type === 'error') {
      throw new ProtocolError(`BiDi script error: ${resp.message ?? resp.error}`);
    }
    // BiDi result is nested: result.result.value or result.value depending on spec version
    const resultObj = (resp.result as any)?.result ?? resp.result;
    return this.extractBiDiValue(resultObj);
  }

  /** Extract a JS value from a BiDi remote value object. */
  private extractBiDiValue(remoteValue: any): unknown {
    if (!remoteValue) return undefined;
    const type = remoteValue.type;
    switch (type) {
      case 'undefined':
        return undefined;
      case 'null':
        return null;
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
        return remoteValue.value;
      case 'array':
        if (Array.isArray(remoteValue.value)) {
          return remoteValue.value.map((v: any) => this.extractBiDiValue(v));
        }
        return remoteValue.value;
      case 'object':
        if (Array.isArray(remoteValue.value)) {
          // BiDi objects come as [[key, valueObj], ...] pairs
          const obj: Record<string, unknown> = {};
          for (const entry of remoteValue.value) {
            if (Array.isArray(entry) && entry.length === 2) {
              const key = typeof entry[0] === 'string' ? entry[0] : entry[0]?.value ?? String(entry[0]);
              obj[key] = this.extractBiDiValue(entry[1]);
            }
          }
          return obj;
        }
        return remoteValue.value;
      default:
        // Fallback — return value directly if present
        return remoteValue.value ?? remoteValue;
    }
  }

  /** Get full page HTML. */
  async getHTML(): Promise<string> {
    return (await this.evaluate('document.documentElement.outerHTML')) as string;
  }

  /**
   * Perform actions (BiDi input.performActions).
   * This is the BiDi way to do mouse/keyboard events.
   */
  async performActions(actions: unknown[]): Promise<void> {
    const ctx = await this.getOrCreateContext();
    await this.send('input.performActions', {
      context: ctx,
      actions,
    });
  }

  /** Click at coordinates via BiDi input actions. */
  async clickPoint(x: number, y: number): Promise<void> {
    await this.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        actions: [
          { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  }

  /** Insert text via BiDi input actions. */
  async insertText(text: string): Promise<void> {
    const actions = text.split('').map((ch) => [
      { type: 'keyDown', value: ch },
      { type: 'keyUp', value: ch },
    ]).flat();
    await this.performActions([{ type: 'key', id: 'keyboard', actions }]);
  }

  /** Clean up all pending commands and event handlers. Rejects in-flight commands. */
  destroy(): void {
    // Snapshot and clear first to prevent re-entrant issues from reject callbacks
    const pendingSnapshot = [...this.pending.values()];
    this.pending.clear();
    this.eventHandlers.clear();
    this.browsingContext = undefined;

    for (const pending of pendingSnapshot) {
      clearTimeout(pending.timer);
      pending.reject(new Error('session destroyed'));
    }
  }
}
