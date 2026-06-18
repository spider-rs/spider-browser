import type { ProtocolAdapter } from './protocol/protocol-adapter.js';
import { BlockedError, NavigationError, TimeoutError } from './utils/errors.js';

/** Options for `page.scrape()`. Provide one of `fields`, `domain`, or `slug`. */
export interface ScrapeOptions {
  /** Custom CSS selectors for extraction. */
  fields?: Record<string, string | { selector: string; attribute: string }>;
  /** Target domain for built-in pattern lookup (e.g. "amazon.com"). */
  domain?: string;
  /** Scraper slug for specific built-in pattern (e.g. "amazon-scraper"). */
  slug?: string;
  /** Enable AI fallback for fields CSS can't resolve (default: true). */
  aiFallback?: boolean;
}

/**
 * SpiderPage — deterministic browser tab abstraction.
 *
 * All standard browser automation methods (no LLM required).
 * Works over both CDP (Chrome/Servo/LightPanda) and BiDi (Firefox)
 * through the ProtocolAdapter.
 */
export class SpiderPage {
  /** @internal */
  constructor(private adapter: ProtocolAdapter) {}

  // -------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------

  /** Navigate to a URL and wait for load. */
  async goto(url: string): Promise<void> {
    await this.adapter.navigate(url);
  }

  /**
   * Navigate without waiting for full page load (5s max wait).
   * Use with contentWithEarlyReturn() for SPAs that never fire loadEventFired.
   */
  async gotoFast(url: string): Promise<void> {
    await this.adapter.navigateFast(url);
  }

  /**
   * Navigate and return as soon as DOMContentLoaded fires (3s max).
   * Fastest option — the DOM shell is ready but subresources may still load.
   * Pair with contentWithEarlyReturn() or contentWithNetworkIdle() for best results.
   */
  async gotoDom(url: string): Promise<void> {
    await this.adapter.navigateDom(url);
  }

  /** Go back in browser history. */
  async goBack(): Promise<void> {
    await this.adapter.evaluate('window.history.back()');
  }

  /** Go forward in browser history. */
  async goForward(): Promise<void> {
    await this.adapter.evaluate('window.history.forward()');
  }

  /** Reload the page. */
  async reload(): Promise<void> {
    await this.adapter.evaluate('window.location.reload()');
  }

  // -------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------

  /**
   * Get the full page HTML, ensuring the page is ready first.
   *
   * Waits for network idle + DOM stability, then checks content quality.
   * If the content seems incomplete (too short or looks like a loading state),
   * does incremental waits with exponential backoff before returning.
   *
   * @param waitMs Max time to wait for readiness (default: 8000ms).
   *               Pass 0 to skip readiness checks and return immediately.
   * @param minLength Minimum content length to consider "good" (default: 1000).
   */
  async content(waitMs: number = 8000, minLength: number = 1000): Promise<string> {
    // Fast path: check if content is already sufficient before waiting for
    // network idle. SSR pages have full HTML available immediately after
    // navigation, so this skips the expensive networkIdle wait entirely.
    if (waitMs > 0) {
      const earlyHtml = (await this.adapter.getHTML()) ?? '';
      // Chrome error pages won't auto-resolve — fail fast so retry engine rotates browser
      const earlyErrCode = this.isChromeErrorPage(earlyHtml);
      if (earlyErrCode) {
        throw new NavigationError(`Chrome error page: ${earlyErrCode}`);
      }
      if (
        earlyHtml.length >= minLength &&
        !this.isInterstitialContent(earlyHtml) &&
        !this.isRateLimitContent(earlyHtml)
      ) {
        return earlyHtml;
      }
      await this.waitForNetworkIdle(waitMs);
    }

    let html = (await this.adapter.getHTML()) ?? '';

    // Chrome error pages — fail fast, no point waiting for interstitial resolution
    const errCode = this.isChromeErrorPage(html);
    if (errCode) {
      throw new NavigationError(`Chrome error page: ${errCode}`);
    }

    // Interstitial detection — wait for challenge pages to resolve before failing.
    // Cloudflare "Just a moment...", PerimeterX "Verifying the device...", and similar
    // interstitials auto-resolve after a few seconds. PerimeterX can take 30-45s.
    // Graduated waits: 2+2+3+4+5+7+7 = 30s max.
    // No no-growth early exit: PerimeterX pages stay identical during JS verification
    // then suddenly redirect when challenge passes. Must wait the full budget.
    if (waitMs > 0 && this.isInterstitialContent(html)) {
      const interstitialWaits = [2000, 2000, 3000, 4000, 5000, 7000, 7000];
      for (const wait of interstitialWaits) {
        await sleep(wait);
        html = (await this.adapter.getHTML()) ?? '';
        if (!this.isInterstitialContent(html)) break;
        // Content-growth early exit: real page rendered
        if (html.length > 15_000) break;
      }
      // If still an interstitial after all waits, throw BlockedError so retry engine rotates browser
      if (this.isInterstitialContent(html)) {
        throw new BlockedError('Page stuck on interstitial challenge');
      }
    }

    // Site-level rate limiting — throw BlockedError so retry engine rotates browser (new profile)
    if (waitMs > 0 && this.isRateLimitContent(html)) {
      throw new BlockedError('Rate limit exceeded (site-level)');
    }

    // Incremental quality check — if content seems incomplete, wait progressively.
    // After incremental waits, fall back to polling (catches SPAs that never fire load
    // but have content available via client-side rendering).
    if (waitMs > 0 && html.length < minLength) {
      const increments = [300, 500, 800, 1200];
      for (const extra of increments) {
        await sleep(extra);
        const updated = await this.adapter.getHTML();
        if (updated.length > html.length) {
          html = updated;
        }
        if (html.length >= minLength) break;
      }
      // If still short after incremental waits, do a brief polling phase.
      // This catches SPAs that render content asynchronously after page load.
      if (html.length < minLength) {
        const pollDeadline = Date.now() + 3000;
        while (Date.now() < pollDeadline) {
          await sleep(1000);
          const polled = (await this.adapter.getHTML()) ?? '';
          if (polled.length > html.length) html = polled;
          if (html.length >= minLength) break;
        }
      }
    }

    return html;
  }

  /**
   * Get the raw page HTML without any readiness waiting.
   * Use this when you need immediate access or have already waited.
   */
  async rawContent(): Promise<string> {
    return this.adapter.getHTML();
  }

  /**
   * Poll for content with early return — for SPAs that never fire loadEventFired.
   *
   * Instead of waiting for a full page load event, this polls for HTML content
   * at regular intervals and returns as soon as sufficient content is available.
   * Useful for timeout retries where the page loads data asynchronously.
   *
   * @param maxWaitMs Max time to poll (default 15s)
   * @param minContentLength Minimum HTML length to accept (default 500)
   * @param pollIntervalMs Interval between polls (default 2s)
   */
  async contentWithEarlyReturn(
    maxWaitMs: number = 15000,
    minContentLength: number = 500,
    pollIntervalMs: number = 2000,
  ): Promise<string> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const html = (await this.adapter.getHTML()) ?? '';
      const pollErrCode = this.isChromeErrorPage(html);
      if (pollErrCode) throw new NavigationError(`Chrome error page: ${pollErrCode}`);
      if (
        html.length >= minContentLength &&
        !this.isInterstitialContent(html) &&
        !this.isRateLimitContent(html)
      ) {
        return html;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    // Final attempt — return whatever we have
    return (await this.adapter.getHTML()) ?? '';
  }

  /**
   * Get content using network idle detection + polling hybrid approach.
   * Best for heavy SPAs: uses PerformanceObserver + MutationObserver to detect
   * when the page stops loading, combined with content-length thresholds.
   *
   * Strategy:
   * 1. Wait for readyState=interactive (DOM parsed)
   * 2. Start network+DOM idle monitoring (400ms silence threshold)
   * 3. Poll HTML length — return early if sufficient + idle
   * 4. Interstitial detection with configurable wait budget
   *
   * @param maxWaitMs Max total time to wait (default 20s)
   * @param minContentLength Minimum HTML length to accept (default 1000)
   * @param interstitialBudgetMs Max time to wait for interstitials to resolve (default 16s, use 30s for retries)
   */
  async contentWithNetworkIdle(
    maxWaitMs: number = 20000,
    minContentLength: number = 1000,
    interstitialBudgetMs: number = 16000,
  ): Promise<string> {
    const deadline = Date.now() + maxWaitMs;

    // Phase 1: Quick check — SSR pages have content immediately
    let html = (await this.adapter.getHTML()) ?? '';
    const phase1ErrCode = this.isChromeErrorPage(html);
    if (phase1ErrCode) throw new NavigationError(`Chrome error page: ${phase1ErrCode}`);
    if (html.length >= minContentLength && !this.isInterstitialContent(html) && !this.isRateLimitContent(html)) {
      return html;
    }

    // Phase 2: Wait for readyState=interactive or complete (DOM parsed)
    const domDeadline = Math.min(deadline, Date.now() + 5000);
    while (Date.now() < domDeadline) {
      const state = await this.adapter.evaluate('document.readyState') as string;
      if (state === 'interactive' || state === 'complete') break;
      await sleep(200);
    }

    // Phase 3: Network + DOM idle monitoring with content polling
    // Inject a combined observer that tracks resource loads and DOM mutations.
    const idleMs = 400;
    const idleCheckMs = Math.min(8000, deadline - Date.now());
    if (idleCheckMs > 500) {
      try {
        await this.adapter.evaluate(`
          new Promise((resolve) => {
            let lastActivity = Date.now();
            const idleThreshold = ${idleMs};
            const deadline = Date.now() + ${idleCheckMs};
            const perfObs = new PerformanceObserver(() => { lastActivity = Date.now(); });
            try { perfObs.observe({ entryTypes: ['resource'] }); } catch(e) {}
            const mutObs = new MutationObserver(() => { lastActivity = Date.now(); });
            mutObs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
            const check = () => {
              const now = Date.now();
              if (now >= deadline || (now - lastActivity >= idleThreshold)) {
                perfObs.disconnect(); mutObs.disconnect(); resolve(true); return;
              }
              setTimeout(check, 100);
            };
            setTimeout(check, idleThreshold);
          })
        `);
      } catch {
        await sleep(500);
      }
    }

    // Check content after idle
    html = (await this.adapter.getHTML()) ?? '';
    const idleErrCode = this.isChromeErrorPage(html);
    if (idleErrCode) throw new NavigationError(`Chrome error page: ${idleErrCode}`);
    if (html.length >= minContentLength && !this.isInterstitialContent(html) && !this.isRateLimitContent(html)) {
      return html;
    }

    // Phase 4: Interstitial handling with configurable budget
    // No no-growth early exit: PerimeterX/Akamai pages stay identical during JS
    // verification then suddenly redirect. Must wait the full budget.
    if (this.isInterstitialContent(html)) {
      const iDeadline = Math.min(deadline, Date.now() + interstitialBudgetMs);
      const waits = [2000, 2000, 3000, 4000, 5000, 7000, 10000];
      for (const wait of waits) {
        if (Date.now() >= iDeadline) break;
        await sleep(Math.min(wait, iDeadline - Date.now()));
        html = (await this.adapter.getHTML()) ?? '';
        if (!this.isInterstitialContent(html)) break;
        if (html.length > 15_000) break;
      }
      if (this.isInterstitialContent(html)) {
        throw new BlockedError('Page stuck on interstitial challenge');
      }
    }

    if (this.isRateLimitContent(html)) {
      throw new BlockedError('Rate limit exceeded (site-level)');
    }

    // Phase 5: Final polling for async content
    if (html.length < minContentLength) {
      while (Date.now() < deadline) {
        await sleep(1000);
        const polled = (await this.adapter.getHTML()) ?? '';
        if (polled.length > html.length) html = polled;
        if (html.length >= minContentLength) break;
      }
    }

    return html;
  }

  /** Get the page title. */
  async title(): Promise<string> {
    return (await this.adapter.evaluate('document.title')) as string;
  }

  /** Get the current page URL. */
  async url(): Promise<string> {
    return (await this.adapter.evaluate('window.location.href')) as string;
  }

  /** Capture a screenshot as base64 PNG. */
  async screenshot(): Promise<string> {
    return this.adapter.captureScreenshot();
  }

  /** Evaluate arbitrary JavaScript and return the result. */
  async evaluate(expression: string): Promise<unknown> {
    return this.adapter.evaluate(expression);
  }

  // -------------------------------------------------------------------
  // Click Actions
  // -------------------------------------------------------------------

  /** Click an element by CSS selector. */
  async click(selector: string): Promise<void> {
    const { x, y } = await this.getElementCenter(selector);
    await this.adapter.clickPoint(x, y);
  }

  /** Click at specific viewport coordinates. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.adapter.clickPoint(x, y);
  }

  /** Double-click an element by CSS selector. */
  async dblclick(selector: string): Promise<void> {
    const { x, y } = await this.getElementCenter(selector);
    await this.adapter.doubleClickPoint(x, y);
  }

  /** Right-click an element by CSS selector. */
  async rightClick(selector: string): Promise<void> {
    const { x, y } = await this.getElementCenter(selector);
    await this.adapter.rightClickPoint(x, y);
  }

  /**
   * Click and hold an element for a duration.
   * Useful for long-press interactions, drag initiation, and mobile-style gestures.
   *
   * @param selector CSS selector of the element to click and hold.
   * @param holdMs Duration in milliseconds to hold the click (default: 1000).
   */
  async clickAndHold(selector: string, holdMs: number = 1000): Promise<void> {
    const { x, y } = await this.getElementCenter(selector);
    await this.adapter.clickHoldPoint(x, y, holdMs);
  }

  /**
   * Click and hold at specific viewport coordinates for a duration.
   *
   * @param x X coordinate (CSS pixels).
   * @param y Y coordinate (CSS pixels).
   * @param holdMs Duration in milliseconds to hold the click (default: 1000).
   */
  async clickAndHoldAt(x: number, y: number, holdMs: number = 1000): Promise<void> {
    await this.adapter.clickHoldPoint(x, y, holdMs);
  }

  /** Click all elements matching a selector. */
  async clickAll(selector: string): Promise<void> {
    const points = (await this.adapter.evaluate(`
      (function() {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        return Array.from(els).map(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
      })()
    `)) as Array<{ x: number; y: number }>;
    if (Array.isArray(points)) {
      for (const pt of points) {
        await this.adapter.clickPoint(pt.x, pt.y);
        await sleep(100);
      }
    }
  }

  // -------------------------------------------------------------------
  // Input Actions
  // -------------------------------------------------------------------

  /** Fill a form field — focus, clear existing value, type new value. */
  async fill(selector: string, value: string): Promise<void> {
    // Clear via JS
    await this.adapter.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) { el.focus(); el.value = ''; }
      })()
    `);
    // Click to ensure focus with real browser event
    try {
      const { x, y } = await this.getElementCenter(selector);
      await this.adapter.clickPoint(x, y);
    } catch {
      // element may not be clickable, continue anyway
    }
    // Insert text
    await this.adapter.insertText(value);
    // Dispatch input + change events
    await this.adapter.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
  }

  /** Type text into the currently focused element. */
  async type(value: string): Promise<void> {
    await this.adapter.insertText(value);
  }

  /** Press a named key (e.g. "Enter", "Tab", "Escape"). */
  async press(key: string): Promise<void> {
    await this.adapter.pressKey(key);
  }

  /** Clear an input field. */
  async clear(selector: string): Promise<void> {
    await this.adapter.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).value = ''`,
    );
  }

  /** Select an option in a <select> element. */
  async select(selector: string, value: string): Promise<void> {
    await this.adapter.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
  }

  // -------------------------------------------------------------------
  // Focus & Hover
  // -------------------------------------------------------------------

  /** Focus an element. */
  async focus(selector: string): Promise<void> {
    await this.adapter.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.focus()`,
    );
  }

  /** Blur (unfocus) an element. */
  async blur(selector: string): Promise<void> {
    await this.adapter.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.blur()`,
    );
  }

  /** Hover over an element. */
  async hover(selector: string): Promise<void> {
    const { x, y } = await this.getElementCenter(selector);
    await this.adapter.hoverPoint(x, y);
  }

  // -------------------------------------------------------------------
  // Drag
  // -------------------------------------------------------------------

  /** Drag from one element to another. */
  async drag(fromSelector: string, toSelector: string): Promise<void> {
    const from = await this.getElementCenter(fromSelector);
    const to = await this.getElementCenter(toSelector);
    await this.adapter.dragPoint(from.x, from.y, to.x, to.y);
  }

  // -------------------------------------------------------------------
  // Scroll
  // -------------------------------------------------------------------

  /** Scroll vertically by pixels (positive = down). */
  async scrollY(pixels: number): Promise<void> {
    await this.adapter.evaluate(`window.scrollBy(0, ${pixels})`);
  }

  /** Scroll horizontally by pixels (positive = right). */
  async scrollX(pixels: number): Promise<void> {
    await this.adapter.evaluate(`window.scrollBy(${pixels}, 0)`);
  }

  /** Scroll an element into view. */
  async scrollTo(selector: string): Promise<void> {
    await this.adapter.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ behavior: 'smooth', block: 'center' })`,
    );
  }

  /** Scroll to absolute page coordinates. */
  async scrollToPoint(x: number, y: number): Promise<void> {
    await this.adapter.evaluate(`window.scrollTo(${x}, ${y})`);
  }

  // -------------------------------------------------------------------
  // Wait
  // -------------------------------------------------------------------

  /** Wait for a CSS selector to appear in the DOM. */
  async waitForSelector(selector: string, timeoutMs: number = 5000): Promise<void> {
    const interval = 100;
    const maxIter = Math.ceil(timeoutMs / interval);
    const checkJs = `!!document.querySelector(${JSON.stringify(selector)})`;
    for (let i = 0; i < maxIter; i++) {
      const found = await this.adapter.evaluate(checkJs);
      if (found) return;
      await sleep(interval);
    }
    throw new TimeoutError(`Timeout waiting for selector: ${selector}`);
  }

  /** Wait for navigation/page load (simple delay). */
  async waitForNavigation(timeoutMs: number = 5000): Promise<void> {
    await sleep(Math.min(timeoutMs, 1000));
  }

  /**
   * Wait until the page is fully loaded and DOM is stable.
   *
   * Checks:
   * 1. document.readyState === 'complete'
   * 2. DOM content length stabilizes (no changes for 500ms)
   *
   * Use after goto() for SPAs and dynamic pages to ensure all
   * content is rendered before extracting HTML.
   */
  async waitForReady(timeoutMs: number = 10000): Promise<void> {
    const start = Date.now();
    const pollInterval = 200;
    const stableThreshold = 500; // content must be stable for this long

    // Phase 1: wait for document.readyState === 'complete'
    while (Date.now() - start < timeoutMs) {
      const state = await this.adapter.evaluate('document.readyState') as string;
      if (state === 'complete') break;
      await sleep(pollInterval);
    }

    // Phase 2: wait for DOM content length to stabilize
    let lastLength = 0;
    let stableSince = Date.now();

    while (Date.now() - start < timeoutMs) {
      const length = await this.adapter.evaluate(
        'document.documentElement.innerHTML.length',
      ) as number;

      if (length !== lastLength) {
        lastLength = length;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableThreshold) {
        return; // Stable
      }

      await sleep(pollInterval);
    }
  }

  /**
   * Wait until page content exceeds a minimum length.
   * Useful for SPAs where content loads asynchronously.
   */
  async waitForContent(minLength: number = 500, timeoutMs: number = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const length = await this.adapter.evaluate(
        'document.documentElement.innerHTML.length',
      ) as number;
      if (length >= minLength) return;
      await sleep(200);
    }
  }

  /**
   * Wait for network idle + DOM stability (cross-platform).
   *
   * Uses the Performance/Resource Timing API and MutationObserver
   * (works in both Chrome/CDP and Firefox/BiDi) to detect when:
   * 1. document.readyState === 'complete'
   * 2. No new network resources loading (PerformanceObserver)
   * 3. DOM mutations have settled
   *
   * This is more comprehensive than waitForReady() — it also
   * catches lazy-loaded images, XHR/fetch requests, and script-injected content.
   */
  async waitForNetworkIdle(timeoutMs: number = 8000): Promise<void> {
    const start = Date.now();
    const pollInterval = 250;

    // Phase 1: wait for document.readyState === 'complete'
    while (Date.now() - start < timeoutMs) {
      const state = await this.adapter.evaluate('document.readyState') as string;
      if (state === 'complete') break;
      await sleep(pollInterval);
    }

    // Phase 2: inject a combined network + DOM stability checker
    // Uses PerformanceObserver for resource timing + MutationObserver for DOM changes.
    // Returns a promise that resolves when both are quiet for `idleMs`.
    const idleMs = 400;
    const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
    try {
      await this.adapter.evaluate(`
        new Promise((resolve) => {
          let lastActivity = Date.now();
          const idleThreshold = ${idleMs};
          const deadline = Date.now() + ${remaining};

          // Track resource loads
          const perfObs = new PerformanceObserver(() => { lastActivity = Date.now(); });
          try { perfObs.observe({ entryTypes: ['resource'] }); } catch(e) {}

          // Track DOM mutations
          const mutObs = new MutationObserver(() => { lastActivity = Date.now(); });
          mutObs.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true
          });

          const check = () => {
            const now = Date.now();
            if (now >= deadline || (now - lastActivity >= idleThreshold)) {
              perfObs.disconnect();
              mutObs.disconnect();
              resolve(true);
              return;
            }
            setTimeout(check, 100);
          };
          setTimeout(check, idleThreshold);
        })
      `);
    } catch {
      // If the evaluate fails (e.g. page navigated away), just continue
      await sleep(500);
    }
  }

  // -------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------

  /** Set the viewport dimensions. */
  async setViewport(
    width: number,
    height: number,
    deviceScaleFactor: number = 2,
    mobile: boolean = false,
  ): Promise<void> {
    await this.adapter.setViewport(width, height, deviceScaleFactor, mobile);
  }

  // -------------------------------------------------------------------
  // DOM Queries
  // -------------------------------------------------------------------

  /** Query a single element and return its outer HTML. */
  async querySelector(selector: string): Promise<string | null> {
    return (await this.adapter.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? null`,
    )) as string | null;
  }

  /** Query all matching elements and return their outer HTML. */
  async querySelectorAll(selector: string): Promise<string[]> {
    return (await this.adapter.evaluate(`
      Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => el.outerHTML)
    `)) as string[];
  }

  /** Get text content of an element. */
  async textContent(selector: string): Promise<string | null> {
    return (await this.adapter.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`,
    )) as string | null;
  }

  /**
   * Extract multiple fields from the page in a single call.
   *
   * Each key maps to a CSS selector (returns trimmed textContent) or
   * an object `{ selector, attribute }` (returns the attribute value).
   *
   * @example
   * ```ts
   * const data = await page.extractFields({
   *   title: "#productTitle",
   *   price: ".a-price .a-offscreen",
   *   rating: "#acrPopover .a-icon-alt",
   *   image: { selector: "#main-image", attribute: "src" },
   * });
   * // { title: "MacBook Pro", price: "$2,499", rating: "4.7 out of 5", image: "https://..." }
   * ```
   */
  async extractFields(
    fields: Record<string, string | { selector: string; attribute: string }>,
  ): Promise<Record<string, string | null>> {
    const fieldMap = Object.entries(fields).map(([key, val]) => ({
      key,
      selector: typeof val === 'string' ? val : val.selector,
      attribute: typeof val === 'string' ? null : val.attribute,
    }));

    const result = await this.adapter.evaluate(`
      (() => {
        const fields = ${JSON.stringify(fieldMap)};
        const result = {};
        for (const f of fields) {
          const el = document.querySelector(f.selector);
          result[f.key] = el
            ? (f.attribute ? el.getAttribute(f.attribute) : el.textContent?.trim()) ?? null
            : null;
        }
        return JSON.stringify(result);
      })()
    `);

    return typeof result === 'string' ? JSON.parse(result) : {};
  }

  /**
   * Scrape structured data from the current page.
   *
   * Uses server-side CSS extraction with automatic AI fallback for fields
   * that selectors can't resolve. Supports three modes:
   *
   * 1. **Custom selectors** - pass `fields` with CSS selectors
   * 2. **By domain** - pass `domain` (e.g. "amazon.com") to use built-in patterns
   * 3. **By slug** - pass `slug` (e.g. "amazon-scraper") for a specific pattern
   *
   * Falls back to client-side extraction if the server doesn't support
   * `Spider.scrape` (e.g. direct CDP connection without browser_server).
   *
   * @example
   * ```ts
   * // Custom selectors
   * const data = await page.scrape({
   *   fields: {
   *     title: "#productTitle",
   *     price: ".a-price .a-offscreen",
   *     image: { selector: "#main-image", attribute: "src" },
   *   },
   * });
   *
   * // Auto-detect from domain (uses 1194 built-in patterns)
   * const data = await page.scrape({ domain: "amazon.com" });
   *
   * // By scraper slug
   * const data = await page.scrape({ slug: "amazon-scraper" });
   * ```
   */
  async scrape(options: ScrapeOptions): Promise<Record<string, string | null>> {
    const params: Record<string, unknown> = {};

    if (options.fields) params.fields = options.fields;
    if (options.domain) params.domain = options.domain;
    if (options.slug) params.slug = options.slug;
    if (options.aiFallback !== undefined) params.aiFallback = options.aiFallback;

    // Try server-side Spider.scrape first (browser_server with extract crate)
    try {
      const resp = await this.adapter.sendCommand('Spider.scrape', params);
      if (resp && typeof resp === 'object' && !('error' in resp)) {
        return resp as Record<string, string | null>;
      }
    } catch {
      // Server doesn't support Spider.scrape, fall back to client-side
    }

    // Fallback: client-side extractFields (only works with custom fields)
    if (options.fields) {
      return this.extractFields(options.fields);
    }

    return {};
  }

  // -------------------------------------------------------------------
  // Session snapshots — persist a session and resume it later
  // -------------------------------------------------------------------

  /**
   * Save the current session as a portable snapshot you can persist and
   * restore later — cookies, localStorage/sessionStorage, the current URL,
   * extra request headers, and the viewport. Returns the snapshot blob; store
   * it (your DB, a file, object storage) and pass it back to
   * {@link restoreSnapshot} to pick up exactly where you left off.
   *
   * @param snapshotId Optional id to key the snapshot by on the server.
   *
   * @example
   * ```typescript
   * const snapshot = await page.saveSnapshot();
   * // ...persist `snapshot` somewhere...
   * await otherPage.restoreSnapshot(snapshot);
   * ```
   */
  async saveSnapshot(snapshotId?: string): Promise<unknown> {
    const params: Record<string, unknown> = {};
    if (snapshotId !== undefined) params.id = snapshotId;
    const resp = await this.adapter.sendCommand('Snapshot.capture', params);
    // Return the blob directly for ergonomic round-tripping; fall back to the
    // full result if the server shape differs.
    if (resp && typeof resp === 'object' && 'snapshot' in (resp as Record<string, unknown>)) {
      return (resp as Record<string, unknown>).snapshot;
    }
    return resp;
  }

  /**
   * Restore a previously saved session snapshot into this page. Accepts either
   * the blob returned by {@link saveSnapshot} or the full capture result.
   */
  async restoreSnapshot(snapshot: unknown): Promise<unknown> {
    const blob =
      snapshot && typeof snapshot === 'object' && 'snapshot' in (snapshot as Record<string, unknown>)
        ? (snapshot as Record<string, unknown>).snapshot
        : snapshot;
    return this.adapter.sendCommand('Snapshot.restore', { snapshot: blob });
  }

  /** Delete a saved snapshot by id from the browser's local cache. */
  async deleteSnapshot(snapshotId: string): Promise<unknown> {
    return this.adapter.sendCommand('Snapshot.delete', { id: snapshotId });
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /** Get the center coordinates of a DOM element (scrolls into view first). */
  private async getElementCenter(selector: string): Promise<{ x: number; y: number }> {
    const result = (await this.adapter.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `)) as { x: number; y: number } | null;

    if (!result) {
      throw new Error(`Element not found: ${selector}`);
    }
    return result;
  }

  /** @internal Replace the adapter (used during browser switching). */
  _setAdapter(adapter: ProtocolAdapter): void {
    this.adapter = adapter;
  }

  /**
   * Detect challenge interstitials that may auto-resolve (e.g. Cloudflare "Just a moment...").
   * These pages show briefly before redirecting to the real content.
   */
  private isInterstitialContent(html: string): boolean {
    if (html.length > 15_000) return false; // Real pages are larger
    const lower = html.toLowerCase();
    // Challenge/WAF interstitials
    if (
      lower.includes('just a moment') ||
      lower.includes('checking your browser') ||
      lower.includes('please wait while we verify') ||
      lower.includes('verifying the device') ||
      lower.includes('available after verification') ||
      lower.includes('ddos-guard') ||
      lower.includes('challenge-platform') ||
      lower.includes('px-captcha') ||
      lower.includes('_cf_chl_opt') ||
      lower.includes('managed_challenge') ||
      lower.includes('datadome') ||
      lower.includes('ak_bmsc') ||
      lower.includes('please enable cookies')
    ) return true;
    // SPA loading states — page shell rendered but content still loading.
    // These auto-resolve once JS fetches actual data. Only match on very small pages
    // to avoid false positives on real pages that mention "loading".
    if (html.length < 5_000) {
      if (lower.includes('loading...') || lower.includes('loading results')) return true;
      if (lower.includes('please wait') && !lower.includes('article')) return true;
    }
    return false;
  }

  /**
   * Detect site-level rate limiting in page content.
   * Browser rotation gives a new profile which bypasses per-session rate limits.
   */
  private isRateLimitContent(html: string): boolean {
    if (html.length > 20_000) return false; // Real pages won't be just a rate limit message
    const lower = html.toLowerCase();
    return (
      lower.includes('rate limit exceeded') ||
      lower.includes('too many requests') ||
      (lower.includes('rate limit') && lower.includes('please try again'))
    );
  }

  /**
   * Detect Chrome/Edge native error pages rendered as HTML.
   * These appear when navigation "succeeds" at CDP level but Chrome renders
   * its built-in error page (e.g. "This site can't be reached").
   * Small pages only to avoid false positives on real content.
   */
  private isChromeErrorPage(html: string): string | null {
    if (html.length > 10_000) return null;
    const lower = html.toLowerCase();
    // Chrome error codes embedded in the rendered error page
    const errorCodes = [
      'err_connection_reset', 'err_connection_refused', 'err_connection_timed_out',
      'err_name_not_resolved', 'err_internet_disconnected', 'err_timed_out',
      'err_empty_response', 'err_ssl_protocol_error', 'err_network_changed',
      'err_connection_closed',
    ];
    for (const code of errorCodes) {
      if (lower.includes(code)) return code;
    }
    // Chrome/Edge error page title patterns (smart quotes and plain)
    if (
      (lower.includes("site can\u2019t be reached") || lower.includes("site can't be reached") ||
       lower.includes("page isn\u2019t working") || lower.includes("page isn't working") ||
       lower.includes("can\u2019t reach this page") || lower.includes("can't reach this page")) &&
      lower.includes('check')
    ) return 'chrome_error_page';
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
