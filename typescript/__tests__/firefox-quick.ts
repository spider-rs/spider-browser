/**
 * Quick Firefox E2E test for spider-browser.
 *
 * Verifies Firefox BiDi sessions work end-to-end through the browser backend.
 *
 * Usage:
 *   SPIDER_BROWSER_URL="https://browser.spider.cloud" \
 *   SPIDER_API_KEY="sk-xxx" \
 *   npx tsx __tests__/firefox-quick.ts
 */

import { SpiderBrowser } from '../index.js';

const API_KEY = process.env.SPIDER_API_KEY;
const SERVER_URL = process.env.SPIDER_BROWSER_URL;

if (!API_KEY) {
  console.error('Set SPIDER_API_KEY env var');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Firefox Quick E2E Test');
  console.log('======================\n');

  const serverUrl = SERVER_URL
    ? SERVER_URL.replace(/^https?:\/\//, 'wss://')
    : undefined;

  const browser = new SpiderBrowser({
    apiKey: API_KEY,
    ...(serverUrl ? { serverUrl } : {}),
    browser: 'firefox',
    smartRetry: false,
    logLevel: 'debug',
    connectTimeoutMs: 30000,
    commandTimeoutMs: 30000,
  });

  try {
    // Step 1: Connect
    console.log('[1/5] Connecting to Firefox session...');
    const t0 = Date.now();
    await browser.init();
    console.log(`  Connected in ${Date.now() - t0}ms`);
    console.log(`  browser.connected = ${browser.connected}`);

    // Step 2: Navigate
    console.log('\n[2/5] Navigating to https://example.com...');
    const t1 = Date.now();
    await browser.page.goto('https://example.com');
    await sleep(2000);
    console.log(`  Navigation completed in ${Date.now() - t1}ms`);

    // Step 3: Get page title
    console.log('\n[3/5] Getting page title...');
    const title = await browser.page.title();
    console.log(`  Title: "${title}"`);

    // Step 4: Get page content
    console.log('\n[4/5] Getting page content...');
    const content = await browser.page.content();
    const hasExpectedText = content.includes('Example Domain');
    console.log(`  Content length: ${content.length} chars`);
    console.log(`  Contains "Example Domain": ${hasExpectedText}`);

    // Step 5: Close
    console.log('\n[5/5] Closing session...');
    await browser.close();
    console.log('  Session closed.');

    // Summary
    const success = title.toLowerCase().includes('example') && hasExpectedText;
    console.log('\n======================');
    console.log(success ? 'RESULT: PASS - Firefox session works end-to-end' : 'RESULT: FAIL - Unexpected content');
    process.exit(success ? 0 : 1);
  } catch (err: any) {
    console.error('\n======================');
    console.error('RESULT: FAIL - Error during test');
    console.error(`  ${err.message}`);
    if (err.stack) {
      console.error(`  Stack: ${err.stack.split('\n').slice(1, 4).join('\n  ')}`);
    }
    try {
      await browser.close();
    } catch {}
    process.exit(1);
  }
}

main();
