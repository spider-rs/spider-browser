import { describe, it, expect, beforeEach } from 'vitest';
import {
  BrowserSelector,
  BROWSER_ROTATION,
  PRIMARY_ROTATION,
  EXTENDED_ROTATION,
} from '../retry/browser-selector.js';
import { FailureTracker, ROTATE_AFTER_FAILURES } from '../retry/failure-tracker.js';

describe('BrowserSelector', () => {
  let tracker: FailureTracker;
  let selector: BrowserSelector;

  beforeEach(() => {
    tracker = new FailureTracker();
    selector = new BrowserSelector(tracker);
  });

  describe('rotation constants', () => {
    it('PRIMARY_ROTATION contains stable Chrome backends and navi', () => {
      expect(PRIMARY_ROTATION).toEqual(['chrome-h', 'chrome-new', 'navi']);
    });

    it('EXTENDED_ROTATION contains non-Chrome engines', () => {
      expect(EXTENDED_ROTATION).toEqual(['firefox', 'lightpanda', 'servo']);
    });

    it('BROWSER_ROTATION is PRIMARY + EXTENDED', () => {
      expect(BROWSER_ROTATION).toEqual([...PRIMARY_ROTATION, ...EXTENDED_ROTATION]);
    });

    it('chrome-h is in PRIMARY_ROTATION', () => {
      expect(PRIMARY_ROTATION).toContain('chrome-h');
    });
  });

  describe('shouldRotate', () => {
    it('returns false when failures are below threshold', () => {
      tracker.recordFailure('example.com', 'chrome-h');
      expect(selector.shouldRotate('example.com', 'chrome-h')).toBe(false);
    });

    it('returns true when failures reach threshold', () => {
      for (let i = 0; i < ROTATE_AFTER_FAILURES; i++) {
        tracker.recordFailure('example.com', 'chrome-h');
      }
      expect(selector.shouldRotate('example.com', 'chrome-h')).toBe(true);
    });

    it('returns false for different browser with no failures', () => {
      for (let i = 0; i < ROTATE_AFTER_FAILURES; i++) {
        tracker.recordFailure('example.com', 'chrome-h');
      }
      expect(selector.shouldRotate('example.com', 'firefox')).toBe(false);
    });
  });

  describe('nextBrowser', () => {
    it('returns next browser in rotation', () => {
      expect(selector.nextBrowser('example.com', 'chrome-h')).toBe('chrome-new');
    });

    it('cycles through all browsers', () => {
      expect(selector.nextBrowser('example.com', 'chrome-h')).toBe('chrome-new');
      expect(selector.nextBrowser('example.com', 'chrome-new')).toBe('navi');
      expect(selector.nextBrowser('example.com', 'navi')).toBe('firefox');
      expect(selector.nextBrowser('example.com', 'firefox')).toBe('lightpanda');
    });

    it('skips browsers that have exceeded failure threshold', () => {
      // Exhaust chrome-new
      for (let i = 0; i < ROTATE_AFTER_FAILURES; i++) {
        tracker.recordFailure('example.com', 'chrome-new');
      }
      // chrome-h should skip chrome-new, try navi next
      expect(selector.nextBrowser('example.com', 'chrome-h')).toBe('navi');
    });

    it('returns null when all browsers are exhausted', () => {
      for (const browser of BROWSER_ROTATION) {
        for (let i = 0; i < ROTATE_AFTER_FAILURES; i++) {
          tracker.recordFailure('example.com', browser);
        }
      }
      expect(selector.nextBrowser('example.com', 'chrome-h')).toBeNull();
    });
  });

  describe('chooseBrowser', () => {
    it('returns first available browser from rotation', () => {
      expect(selector.chooseBrowser('example.com', 'chrome-h')).toBe('chrome-h');
    });

    it('skips exhausted browsers', () => {
      for (let i = 0; i < ROTATE_AFTER_FAILURES; i++) {
        tracker.recordFailure('example.com', 'chrome-h');
      }
      expect(selector.chooseBrowser('example.com', 'chrome-h')).toBe('chrome-new');
    });

    it('falls through to extended browsers when primaries exhausted', () => {
      for (const browser of PRIMARY_ROTATION) {
        for (let i = 0; i < ROTATE_AFTER_FAILURES; i++) {
          tracker.recordFailure('example.com', browser);
        }
      }
      expect(selector.chooseBrowser('example.com', 'chrome-h')).toBe('firefox');
    });

    it('returns fallback when all browsers exhausted', () => {
      for (const browser of BROWSER_ROTATION) {
        for (let i = 0; i < ROTATE_AFTER_FAILURES; i++) {
          tracker.recordFailure('example.com', browser);
        }
      }
      expect(selector.chooseBrowser('example.com', 'servo')).toBe('servo');
    });
  });

  describe('failureTracker accessor', () => {
    it('exposes the failure tracker', () => {
      expect(selector.failureTracker).toBe(tracker);
    });
  });
});
