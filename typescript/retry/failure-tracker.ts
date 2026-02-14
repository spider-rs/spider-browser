
/** Mirrors hints.rs FAILURE_TTL (10 minutes). */
const FAILURE_TTL_MS = 10 * 60 * 1000;

/** Mirrors hints.rs ROTATE_AFTER_FAILURES. */
export const ROTATE_AFTER_FAILURES = 2;

interface FailureRecord {
  count: number;
  lastFailure: number;
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
  recordFailure(domain: string, browser: string): void {
    const k = this.key(domain, browser);
    const existing = this.failures.get(k);
    if (existing) {
      existing.count++;
      existing.lastFailure = Date.now();
    } else {
      this.failures.set(k, { count: 1, lastFailure: Date.now() });
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

  /** Clear all failure records for a domain (used on stealth escalation). */
  clear(domain: string): void {
    for (const key of this.failures.keys()) {
      if (key.startsWith(`${domain}::`)) {
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
