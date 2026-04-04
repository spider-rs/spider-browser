import { FailureTracker, ROTATE_AFTER_FAILURES } from './failure-tracker.js';

/**
 * Primary browser rotation — most stable Chrome backends.
 * chrome-h (ChromeXvfb) is the most reliable (99%), followed by chrome-new (92%).
 * Shared chrome is excluded — only 35-65% reliable and drags overall pass rates.
 * @internal
 */
export const PRIMARY_ROTATION: string[] = [
  'chrome-h',
  'chrome-new',
  'navi',
];

/**
 * Extended browser rotation — non-Chrome engines tried at max stealth only.
 * @internal
 */
export const EXTENDED_ROTATION: string[] = ['firefox', 'lightpanda', 'servo'];

/**
 * Full browser rotation order for retry/failover.
 * @internal
 */
export const BROWSER_ROTATION: string[] = [
  ...PRIMARY_ROTATION,
  ...EXTENDED_ROTATION,
];

/**
 * BrowserSelector — picks the next browser in rotation based on failures.
 *
 * Follows the server's hints.rs logic:
 * 1. Try current browser until ROTATE_AFTER_FAILURES consecutive failures
 * 2. Then move to the next browser in BROWSER_ROTATION order
 * 3. Skip browsers that have also exceeded the failure threshold
 */
export class BrowserSelector {
  private tracker: FailureTracker;
  private rotationIndex = 0;

  constructor(tracker: FailureTracker) {
    this.tracker = tracker;
  }

  /** Get the current failure tracker. */
  get failureTracker(): FailureTracker {
    return this.tracker;
  }

  /**
   * Check if the current browser should be rotated for a domain.
   */
  shouldRotate(domain: string, currentBrowser: string): boolean {
    return this.tracker.failureCount(domain, currentBrowser) >= ROTATE_AFTER_FAILURES;
  }

  /**
   * Pick the next browser to try, given the current one has failed.
   * Returns the next browser in rotation that hasn't exceeded the failure threshold.
   * Returns null if all browsers have been exhausted.
   */
  nextBrowser(domain: string, currentBrowser: string): string | null {
    // Find current position in rotation
    const currentIdx = BROWSER_ROTATION.indexOf(currentBrowser);

    // Try each browser after the current one
    for (let offset = 1; offset < BROWSER_ROTATION.length; offset++) {
      const idx = (currentIdx + offset) % BROWSER_ROTATION.length;
      const candidate = BROWSER_ROTATION[idx]!;
      if (this.tracker.failureCount(domain, candidate) < ROTATE_AFTER_FAILURES) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Choose the best browser for a domain (mirrors hints.rs choose_browser_for_domain).
   * Uses failure history to skip browsers that have been failing.
   */
  chooseBrowser(domain: string, fallback: string): string {
    for (const browser of BROWSER_ROTATION) {
      if (this.tracker.failureCount(domain, browser) < ROTATE_AFTER_FAILURES) {
        return browser;
      }
    }
    return fallback;
  }
}
