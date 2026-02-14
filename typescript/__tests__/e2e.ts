/**
 * E2E test for spider-browser.
 *
 * Tests against the live browser.spider.cloud backend.
 * Usage: SPIDER_API_KEY=sk-xxx npx tsx src/__tests__/e2e.ts
 */

import { SpiderBrowser } from '../index.js';

const API_KEY = process.env.SPIDER_API_KEY;
if (!API_KEY) {
  console.error('Set SPIDER_API_KEY env var to run E2E tests');
  process.exit(1);
}

async function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    return true;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  console.log('spider-browser E2E tests\n');
  let passed = 0;
  let failed = 0;

  // ---------------------------------------------------------------
  // Test 1: Connect, navigate, get title and screenshot (Chrome)
  // ---------------------------------------------------------------
  {
    const browser = new SpiderBrowser({
      apiKey: API_KEY,
      browser: 'chrome',
      logLevel: 'warn',
    });

    const ok1 = await test('Chrome: connect and init', async () => {
      await browser.init();
      if (!browser.connected) throw new Error('Not connected');
    });
    ok1 ? passed++ : failed++;

    const ok2 = await test('Chrome: navigate to example.com', async () => {
      await browser.page.goto('https://example.com');
      // Wait for page load
      await sleep(2000);
      const title = await browser.page.title();
      if (!title || !title.toLowerCase().includes('example')) {
        throw new Error(`Unexpected title: ${title}`);
      }
    });
    ok2 ? passed++ : failed++;

    const ok3 = await test('Chrome: get page content', async () => {
      const html = await browser.page.content();
      if (!html.includes('Example Domain')) {
        throw new Error('Page content missing expected text');
      }
    });
    ok3 ? passed++ : failed++;

    const ok4 = await test('Chrome: screenshot', async () => {
      const screenshot = await browser.page.screenshot();
      if (!screenshot || screenshot.length < 100) {
        throw new Error('Screenshot too small or empty');
      }
      // Verify it's base64
      const decoded = Buffer.from(screenshot, 'base64');
      if (decoded.length < 100) {
        throw new Error('Screenshot decoded too small');
      }
    });
    ok4 ? passed++ : failed++;

    const ok5 = await test('Chrome: evaluate JS', async () => {
      const result = await browser.page.evaluate('1 + 1');
      if (result !== 2) throw new Error(`Expected 2, got ${result}`);
    });
    ok5 ? passed++ : failed++;

    const ok6 = await test('Chrome: get URL', async () => {
      const url = await browser.page.url();
      if (!url.includes('example.com')) {
        throw new Error(`Unexpected URL: ${url}`);
      }
    });
    ok6 ? passed++ : failed++;

    const ok7 = await test('Chrome: observe (no LLM)', async () => {
      const elements = await browser.observe();
      if (!Array.isArray(elements)) throw new Error('Expected array');
      // example.com has at least one link
      const links = elements.filter((e) => e.tag === 'a');
      if (links.length === 0) throw new Error('No links found on example.com');
    });
    ok7 ? passed++ : failed++;

    await browser.close();
  }

  // ---------------------------------------------------------------
  // Test 2: Firefox connection (BiDi protocol)
  // ---------------------------------------------------------------
  {
    const browser = new SpiderBrowser({
      apiKey: API_KEY,
      browser: 'firefox',
      logLevel: 'warn',
    });

    const ok1 = await test('Firefox: connect and init', async () => {
      await browser.init();
      if (!browser.connected) throw new Error('Not connected');
    });
    ok1 ? passed++ : failed++;

    const ok2 = await test('Firefox: navigate and get title', async () => {
      await browser.page.goto('https://example.com');
      await sleep(2000);
      const title = await browser.page.title();
      if (!title || !title.toLowerCase().includes('example')) {
        throw new Error(`Unexpected title: ${title}`);
      }
    });
    ok2 ? passed++ : failed++;

    await browser.close();
  }

  // ---------------------------------------------------------------
  // Test 3: Event system
  // ---------------------------------------------------------------
  {
    const browser = new SpiderBrowser({
      apiKey: API_KEY,
      browser: 'chrome',
      logLevel: 'warn',
    });

    let wsOpenFired = false;
    browser.on('ws.open', () => {
      wsOpenFired = true;
    });

    const ok1 = await test('Events: ws.open fires on connect', async () => {
      await browser.init();
      if (!wsOpenFired) throw new Error('ws.open event did not fire');
    });
    ok1 ? passed++ : failed++;

    await browser.close();
  }

  // ---------------------------------------------------------------
  // Test 4: Multiple navigations
  // ---------------------------------------------------------------
  {
    const browser = new SpiderBrowser({
      apiKey: API_KEY,
      browser: 'chrome',
      logLevel: 'warn',
    });

    await browser.init();

    const ok1 = await test('Chrome: navigate to httpbin.org/html', async () => {
      await browser.page.goto('https://httpbin.org/html');
      await sleep(2000);
      const html = await browser.page.content();
      if (!html.includes('Herman Melville')) {
        throw new Error('httpbin.org/html content not found');
      }
    });
    ok1 ? passed++ : failed++;

    const ok2 = await test('Chrome: navigate to second page', async () => {
      await browser.page.goto('https://example.com');
      await sleep(2000);
      const title = await browser.page.title();
      if (!title.toLowerCase().includes('example')) {
        throw new Error(`Unexpected title: ${title}`);
      }
    });
    ok2 ? passed++ : failed++;

    await browser.close();
  }

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('E2E test runner failed:', err);
  process.exit(1);
});
