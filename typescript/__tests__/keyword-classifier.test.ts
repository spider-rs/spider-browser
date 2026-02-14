import { describe, it, expect } from 'vitest';
import { KeywordClassifier } from '../retry/keyword-classifier.js';

describe('KeywordClassifier (Aho-Corasick)', () => {
  const classifier = new KeywordClassifier<string>([
    [['blocked', 'captcha', 'bot detect'], 'blocked'],
    [['401', 'unauthorized'], 'auth'],
    [['timeout', 'websocket closed'], 'transient'],
  ]);

  describe('basic matching', () => {
    it('matches keyword at start of string', () => {
      expect(classifier.classify('blocked by WAF')).toBe('blocked');
    });

    it('matches keyword in middle of string', () => {
      expect(classifier.classify('Site returned 401 Unauthorized')).toBe('auth');
    });

    it('matches keyword at end of string', () => {
      expect(classifier.classify('Request timeout')).toBe('transient');
    });

    it('returns undefined for no match', () => {
      expect(classifier.classify('Everything is fine')).toBeUndefined();
    });
  });

  describe('case insensitivity', () => {
    it('matches uppercase', () => {
      expect(classifier.classify('BLOCKED BY FIREWALL')).toBe('blocked');
    });

    it('matches mixed case', () => {
      expect(classifier.classify('Bot Detection Triggered')).toBe('blocked');
    });

    it('matches CamelCase', () => {
      expect(classifier.classify('WebSocket Closed unexpectedly')).toBe('transient');
    });
  });

  describe('priority ordering', () => {
    it('returns first rule when multiple match', () => {
      // 'blocked' and 'unauthorized' both present — blocked comes first in rules
      expect(classifier.classify('blocked and unauthorized')).toBe('blocked');
    });
  });

  describe('overlapping keywords', () => {
    it('matches shortest keyword at same position (Aho-Corasick semantics)', () => {
      // "bot" completes at position 3 before "bot detect" completes at position 10
      const overlap = new KeywordClassifier<string>([
        [['bot detect'], 'specific'],
        [['bot'], 'generic'],
      ]);
      expect(overlap.classify('bot detected')).toBe('generic');
    });

    it('same-rule overlaps work correctly', () => {
      // In practice, overlapping keywords are in the same rule (same classification)
      const sameRule = new KeywordClassifier<string>([
        [['bot', 'bot detect', 'bot detected'], 'blocked'],
      ]);
      expect(sameRule.classify('bot detected on page')).toBe('blocked');
      expect(sameRule.classify('a bot was found')).toBe('blocked');
    });
  });

  describe('empty and edge cases', () => {
    it('handles empty string', () => {
      expect(classifier.classify('')).toBeUndefined();
    });

    it('handles very short string', () => {
      expect(classifier.classify('ok')).toBeUndefined();
    });

    it('handles keyword that is the entire string', () => {
      expect(classifier.classify('blocked')).toBe('blocked');
    });
  });

  describe('performance characteristics', () => {
    const large = new KeywordClassifier<string>([
      [['pattern1', 'pattern2', 'pattern3', 'pattern4', 'pattern5',
        'pattern6', 'pattern7', 'pattern8', 'pattern9', 'pattern10',
        'longpatternwithmanychars', 'anotherlongpattern',
        'verylongpatternindeed', 'shortpat',
      ], 'found'],
    ]);

    it('handles long input strings efficiently', () => {
      const input = 'x'.repeat(10000) + 'pattern5' + 'y'.repeat(10000);
      expect(large.classify(input)).toBe('found');
    });

    it('returns undefined for long string with no match', () => {
      const input = 'x'.repeat(10000);
      expect(large.classify(input)).toBeUndefined();
    });
  });
});
