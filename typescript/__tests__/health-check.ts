import { SpiderBrowser } from '../index.js';
async function main() {
  for (const browser of ['chrome', 'chrome-h', 'chrome-new', 'lightpanda', 'servo', 'firefox'] as const) {
    console.log(`--- Testing ${browser} ---`);
    const b = new SpiderBrowser({ apiKey: process.env.SPIDER_API_KEY!, browser, stealth: 1, connectTimeoutMs: 30000, commandTimeoutMs: 30000, smartRetry: false, logLevel: 'error' });
    try { 
      await b.init(); 
      await b.page.goto('https://example.com'); 
      const t = await b.page.title();
      console.log(`PASS: ${t}`); 
    }
    catch(e: any) { console.error(`FAIL: ${e.message}`); }
    finally { await b.close().catch(()=>{}); }
  }
  process.exit(0);
}
main();
