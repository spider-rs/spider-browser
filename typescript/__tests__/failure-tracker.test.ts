import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FailureTracker, ROTATE_AFTER_FAILURES } from '../retry/failure-tracker.js';

describe('FailureTracker', () => {
  let tracker: FailureTracker;

  beforeEach(() => {
    tracker = new FailureTracker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordFailure / failureCount', () => {
    it('starts at zero for unknown domain+browser', () => {
      expect(tracker.failureCount('example.com', 'chrome')).toBe(0);
    });

    it('increments failure count', () => {
      tracker.recordFailure('example.com', 'chrome');
      expect(tracker.failureCount('example.com', 'chrome')).toBe(1);

      tracker.recordFailure('example.com', 'chrome');
      expect(tracker.failureCount('example.com', 'chrome')).toBe(2);
    });

    it('tracks different browsers independently', () => {
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'firefox');

      expect(tracker.failureCount('example.com', 'chrome')).toBe(2);
      expect(tracker.failureCount('example.com', 'firefox')).toBe(1);
    });

    it('tracks different domains independently', () => {
      tracker.recordFailure('a.com', 'chrome');
      tracker.recordFailure('b.com', 'chrome');
      tracker.recordFailure('b.com', 'chrome');

      expect(tracker.failureCount('a.com', 'chrome')).toBe(1);
      expect(tracker.failureCount('b.com', 'chrome')).toBe(2);
    });
  });

  describe('recordSuccess', () => {
    it('clears failure count for domain+browser', () => {
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'chrome');
      expect(tracker.failureCount('example.com', 'chrome')).toBe(2);

      tracker.recordSuccess('example.com', 'chrome');
      expect(tracker.failureCount('example.com', 'chrome')).toBe(0);
    });

    it('does not affect other browser counts', () => {
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'firefox');

      tracker.recordSuccess('example.com', 'chrome');
      expect(tracker.failureCount('example.com', 'chrome')).toBe(0);
      expect(tracker.failureCount('example.com', 'firefox')).toBe(1);
    });
  });

  describe('totalFailureCount', () => {
    it('sums failures across all browsers for a domain', () => {
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'firefox');
      tracker.recordFailure('example.com', 'servo');

      expect(tracker.totalFailureCount('example.com')).toBe(4);
    });

    it('returns 0 for unknown domain', () => {
      expect(tracker.totalFailureCount('unknown.com')).toBe(0);
    });

    it('does not include other domains', () => {
      tracker.recordFailure('a.com', 'chrome');
      tracker.recordFailure('b.com', 'chrome');

      expect(tracker.totalFailureCount('a.com')).toBe(1);
    });
  });

  describe('clear', () => {
    it('clears all failures for a domain', () => {
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'firefox');
      tracker.recordFailure('other.com', 'chrome');

      tracker.clear('example.com');

      expect(tracker.failureCount('example.com', 'chrome')).toBe(0);
      expect(tracker.failureCount('example.com', 'firefox')).toBe(0);
      expect(tracker.failureCount('other.com', 'chrome')).toBe(1);
    });
  });

  describe('clearClass', () => {
    it('clears only the matching class, retaining others', () => {
      tracker.recordFailure('example.com', 'chrome', 'blocked');
      tracker.recordFailure('example.com', 'chrome', 'blocked');
      tracker.recordFailure('example.com', 'firefox', 'transient');
      tracker.recordFailure('other.com', 'chrome', 'blocked');

      // stealth escalation: clear blocked, keep transient
      tracker.clearClass('example.com', 'blocked');

      expect(tracker.failureCount('example.com', 'chrome')).toBe(0); // blocked cleared
      expect(tracker.failureCount('example.com', 'firefox')).toBe(1); // transient retained
      expect(tracker.failureCount('other.com', 'chrome')).toBe(1); // other domain untouched
    });

    it('uses the most recent failure class', () => {
      tracker.recordFailure('example.com', 'chrome', 'blocked');
      tracker.recordFailure('example.com', 'chrome', 'transient'); // latest = transient

      tracker.clearClass('example.com', 'blocked');

      expect(tracker.failureCount('example.com', 'chrome')).toBe(2); // retained
    });

    it('defaults recordFailure class to transient (retained on blocked clear)', () => {
      tracker.recordFailure('example.com', 'chrome');
      tracker.clearClass('example.com', 'blocked');
      expect(tracker.failureCount('example.com', 'chrome')).toBe(1);
    });

    it('is a safe no-op for unknown domains', () => {
      expect(() => tracker.clearClass('nope.com', 'blocked')).not.toThrow();
    });
  });

  describe('TTL expiration', () => {
    it('returns 0 after TTL expires', () => {
      tracker.recordFailure('example.com', 'chrome');
      expect(tracker.failureCount('example.com', 'chrome')).toBe(1);

      // Advance time past 10-minute TTL
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
      expect(tracker.failureCount('example.com', 'chrome')).toBe(0);
    });

    it('excludes expired records from totalFailureCount', () => {
      tracker.recordFailure('example.com', 'chrome');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
      expect(tracker.totalFailureCount('example.com')).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('removes expired entries', () => {
      tracker.recordFailure('example.com', 'chrome');
      tracker.recordFailure('example.com', 'firefox');

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
      tracker.cleanup();

      // After cleanup + restoring time, entries should be gone
      vi.restoreAllMocks();
      expect(tracker.failureCount('example.com', 'chrome')).toBe(0);
      expect(tracker.failureCount('example.com', 'firefox')).toBe(0);
    });
  });

  describe('ROTATE_AFTER_FAILURES constant', () => {
    it('is set to 2', () => {
      expect(ROTATE_AFTER_FAILURES).toBe(2);
    });
  });
});
