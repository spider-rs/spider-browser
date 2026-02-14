import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpiderPage } from '../page.js';
import type { ProtocolAdapter } from '../protocol/protocol-adapter.js';

// Access private methods for testing
function isInterstitialContent(page: SpiderPage, html: string): boolean {
  return (page as any).isInterstitialContent(html);
}

function isRateLimitContent(page: SpiderPage, html: string): boolean {
  return (page as any).isRateLimitContent(html);
}

function createMockPage(): SpiderPage {
  const adapter = {
    getHTML: vi.fn().mockResolvedValue('<html><body>Real content</body></html>'),
    evaluate: vi.fn().mockResolvedValue('complete'),
    navigate: vi.fn().mockResolvedValue(undefined),
    captureScreenshot: vi.fn().mockResolvedValue(''),
    clickPoint: vi.fn().mockResolvedValue(undefined),
    doubleClickPoint: vi.fn().mockResolvedValue(undefined),
    rightClickPoint: vi.fn().mockResolvedValue(undefined),
    hoverPoint: vi.fn().mockResolvedValue(undefined),
    dragPoint: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  } as unknown as ProtocolAdapter;
  return new SpiderPage(adapter);
}

describe('SpiderPage interstitial detection', () => {
  let page: SpiderPage;

  beforeEach(() => {
    page = createMockPage();
  });

  describe('isInterstitialContent', () => {
    it('detects "Just a moment..." Cloudflare page', () => {
      const html = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
      expect(isInterstitialContent(page, html)).toBe(true);
    });

    it('detects "checking your browser" pattern', () => {
      const html = '<html><body>Checking your browser before accessing the site.</body></html>';
      expect(isInterstitialContent(page, html)).toBe(true);
    });

    it('detects "please wait while we verify"', () => {
      const html = '<html><body>Please wait while we verify your request.</body></html>';
      expect(isInterstitialContent(page, html)).toBe(true);
    });

    it('detects DDoS-Guard', () => {
      const html = '<html><body>DDoS-Guard protection</body></html>';
      expect(isInterstitialContent(page, html)).toBe(true);
    });

    it('detects Cloudflare challenge-platform', () => {
      const html = '<html><body><div id="challenge-platform"></div></body></html>';
      expect(isInterstitialContent(page, html)).toBe(true);
    });

    it('does NOT flag large real pages', () => {
      const html = 'x'.repeat(20000) + 'Just a moment'; // Large page with incidental match
      expect(isInterstitialContent(page, html)).toBe(false);
    });

    it('does NOT flag normal content', () => {
      const html = '<html><body><h1>Welcome to our site</h1><p>Lorem ipsum dolor sit amet</p></body></html>';
      expect(isInterstitialContent(page, html)).toBe(false);
    });
  });

  describe('isRateLimitContent', () => {
    it('detects "Rate limit exceeded"', () => {
      const html = '<html><body><h1>Rate limit exceeded. Rate limit exceeded.</h1></body></html>';
      expect(isRateLimitContent(page, html)).toBe(true);
    });

    it('detects "too many requests"', () => {
      const html = '<html><body>Too many requests from your IP address.</body></html>';
      expect(isRateLimitContent(page, html)).toBe(true);
    });

    it('detects "rate limit" + "please try again"', () => {
      const html = '<html><body>You have hit a rate limit. Please try again later.</body></html>';
      expect(isRateLimitContent(page, html)).toBe(true);
    });

    it('does NOT flag large real pages', () => {
      const html = 'x'.repeat(25000) + 'rate limit exceeded'; // Large page
      expect(isRateLimitContent(page, html)).toBe(false);
    });

    it('does NOT flag normal content', () => {
      const html = '<html><body><p>Our API has a rate limit of 100 requests per minute.</p></body></html>';
      // Contains "rate limit" but NOT "rate limit exceeded" or "too many requests"
      // and doesn't have "please try again"
      expect(isRateLimitContent(page, html)).toBe(false);
    });
  });
});
