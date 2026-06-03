
/** Mirrors hints.rs FAILURE_TTL (10 minutes). */
const FAILURE_TTL_MS = 10 * 60 * 1000;

/** Mirrors hints.rs ROTATE_AFTER_FAILURES. */
export const ROTATE_AFTER_FAILURES = 2;

interface FailureRecord {
  count: number;
  lastFailure: number;
  /** Class of the most recent failure ("blocked", "transient", ...). Used by
   * clearClass() to selectively reset failures on stealth escalation. */
  errorClass: string;
}

/**
 * Per-domain failure tracking (mirrors server hints.rs FailureTracker).
 *
 * Tracks (domain, browser_type) failure counts with 10-minute TTL.
 * Used by BrowserSelector to decide when to rotate browsers.
 */
export class FailureTracker {
  private failures = new Map<string, FailureRecord>();

  private key(domain: string, browser: string): string {
    return `${domain}::${browser}`;
  }

  /** Record a failure for a domain + browser. */
  recordFailure(domain: string, browser: string, errorClass: string = 'transient'): void {
    const k = this.key(domain, browser);
    const existing = this.failures.get(k);
    if (existing) {
      existing.count++;
      existing.lastFailure = Date.now();
      existing.errorClass = errorClass;
    } else {
      this.failures.set(k, { count: 1, lastFailure: Date.now(), errorClass });
    }
  }

  /** Record a success — clears the failure counter. */
  recordSuccess(domain: string, browser: string): void {
    this.failures.delete(this.key(domain, browser));
  }

  /** Get failure count (0 if expired or not found). */
  failureCount(domain: string, browser: string): number {
    const record = this.failures.get(this.key(domain, browser));
    if (!record) return 0;
    if (Date.now() - record.lastFailure > FAILURE_TTL_MS) {
      this.failures.delete(this.key(domain, browser));
      return 0;
    }
    return record.count;
  }

  /** Get total failures across all browsers for a domain. */
  totalFailureCount(domain: string): number {
    let total = 0;
    for (const [key, record] of this.failures) {
      if (key.startsWith(`${domain}::`)) {
        if (Date.now() - record.lastFailure < FAILURE_TTL_MS) {
          total += record.count;
        }
      }
    }
    return total;
  }

  /** Clear all failure records for a domain (regardless of class). */
  clear(domain: string): void {
    for (const key of this.failures.keys()) {
      if (key.startsWith(`${domain}::`)) {
        this.failures.delete(key);
      }
    }
  }

  /**
   * Clear only failures of a given class for a domain.
   *
   * Used on stealth escalation: `blocked` failures are cleared (a higher stealth
   * tier can bypass the block), while `transient`/disconnect failures are
   * retained (escalating stealth won't fix flaky infra, so we keep skipping a
   * browser that keeps dropping on this domain).
   */
  clearClass(domain: string, errorClass: string): void {
    const prefix = `${domain}::`;
    for (const [key, record] of this.failures) {
      if (key.startsWith(prefix) && record.errorClass === errorClass) {
        this.failures.delete(key);
      }
    }
  }

  /** Clean expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.failures) {
      if (now - record.lastFailure > FAILURE_TTL_MS) {
        this.failures.delete(key);
      }
    }
  }
}
