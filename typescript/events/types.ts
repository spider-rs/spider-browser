/**
 * Browser selection for the public API.
 * - `'auto'` — server picks the best browser automatically.
 * - `'chrome'` — Chrome (multiple headless variants available server-side).
 * - `'firefox'` — Firefox via WebDriver BiDi protocol.
 */
export type Browser = 'auto' | 'chrome' | 'firefox';

/**
 * Internal browser backend identifiers.
 * @internal Not part of the public API — use {@link Browser} instead.
 */
export type BrowserType = 'chrome' | 'chrome-new' | 'chrome-h' | 'firefox' | 'servo' | 'lightpanda' | 'auto';

/** All events emitted by SpiderBrowser. */
export interface SpiderEvents {
  /** WebSocket connection opened. */
  'ws.open': {};
  /** WebSocket connection closed. */
  'ws.close': { code: number; reason: string };
  /** WebSocket error. */
  'ws.error': { error: Error };

  /** Captcha was detected on the page. */
  'captcha.detected': { types: string[]; url: string };
  /** Captcha solver is running. */
  'captcha.solving': { types: string[]; url: string; round: number };
  /** Captcha was solved. */
  'captcha.solved': { url: string };
  /** Captcha solving failed. */
  'captcha.failed': { url: string; reason: string };

  /** Smart retry is switching browsers. */
  'browser.switching': { from: string; to: string; reason: string };
  /** Browser switched successfully. */
  'browser.switched': { browser: string };
  /** Retry attempt. */
  'retry.attempt': { attempt: number; maxRetries: number; error: string };

  /** Stealth level escalated (proxy tier upgraded). */
  'stealth.escalated': { from: number; to: number; reason: string };

  /** Metering data from server (credits remaining, cost rate, session cost). */
  'metering': { credits: number; rate: number; session_credits_used?: number };

  /** Page navigation completed. */
  'page.navigated': { url: string };
  /** Page loaded (DOMContentLoaded or load). */
  'page.loaded': { url: string };

  /** Agent step executed. */
  'agent.step': { round: number; label: string; stepsCount: number };
  /** Agent completed. */
  'agent.done': { rounds: number; result?: unknown };
  /** Agent failed. */
  'agent.error': { error: string; round: number };

  /** A screencast frame captured during recording (CDP browsers). */
  'screencast.frame': {
    data: string;
    timestamp: number;
    frameIndex: number;
    metadata: { offsetTop: number; pageScaleFactor: number; width: number; height: number };
  };
  /** Interaction events captured during recording (mouse, click, scroll, input). */
  'screencast.interactionEvents': {
    events: Array<{ t: number; y: string; x?: number; z?: number; v?: string; b?: number }>;
  };
  /** rrweb DOM recording events (Firefox/Servo — PostHog-style full DOM replay). */
  'screencast.rrwebEvents': {
    events: Array<Record<string, unknown>>;
  };
  /** Recording has started on the server. */
  'recording.started': { sessionId: string };
  /** Recording has completed on the server. */
  'recording.completed': { sessionId: string; frameCount: number; durationMs: number };
}

export type SpiderEventName = keyof SpiderEvents;
