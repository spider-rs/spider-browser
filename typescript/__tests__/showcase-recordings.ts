/**
 * Showcase Recording Generator — High-Quality Browser Automation Recordings
 *
 * Produces screencast recordings stored in the `browser-recordings` R2 bucket.
 * Each scenario maximizes visual state changes for compelling video output.
 *
 * Usage:
 *   SPIDER_API_KEY=sk-xxx npx tsx __tests__/showcase-recordings.ts
 *   SPIDER_API_KEY=sk-xxx npx tsx __tests__/showcase-recordings.ts --only=cnn
 */

import { SpiderBrowser } from '../index.js';
import type { SpiderPage } from '../page.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

process.on('uncaughtException', (err) => {
  if (err && 'code' in err && typeof (err as any).code === 'string' && (err as any).code.startsWith('WS_ERR_')) {
    return;
  }
  console.error('[FATAL]', err);
  process.exit(1);
});

const API_KEY = process.env.SPIDER_API_KEY;
if (!API_KEY) {
  console.error('Set SPIDER_API_KEY env var');
  process.exit(1);
}

const args = process.argv.slice(2);
function getFlag(name: string, def: number): number {
  const f = args.find((a) => a.startsWith(`--${name}=`));
  return f ? parseInt(f.split('=')[1]!, 10) : def;
}
function getStringFlag(name: string): string | undefined {
  const f = args.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split('=')[1] : undefined;
}
const CONCURRENCY = getFlag('concurrency', 2);
const ONLY_FILTER = getStringFlag('only');

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

interface ShowcaseResult {
  scenario: string;
  domain: string;
  category: string;
  goal: string;
  actions_used: string;
  status: 'pass' | 'fail' | 'partial';
  session_id: string;
  extracted_data: string;
  time_ms: number;
  content_length: number;
  browser: string;
  stealth_level: number;
  credits_used: number;
  error: string;
}

const results: ShowcaseResult[] = [];

interface Scenario {
  name: string;
  domain: string;
  category: string;
  goal: string;
  actions: string;
  run: (browser: SpiderBrowser) => Promise<string>;
}

// -------------------------------------------------------------------
// Visual helpers — maximize screencast frames
// -------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Scroll down in small increments. Each step triggers a new screencast frame. */
async function smoothScroll(page: SpiderPage, totalPx: number, stepPx = 100, delayMs = 450): Promise<void> {
  const steps = Math.ceil(totalPx / stepPx);
  for (let i = 0; i < steps; i++) {
    await page.scrollY(stepPx);
    await sleep(delayMs);
  }
}

/** Scroll back up in small increments. */
async function smoothScrollUp(page: SpiderPage, totalPx: number, stepPx = 120, delayMs = 400): Promise<void> {
  const steps = Math.ceil(totalPx / stepPx);
  for (let i = 0; i < steps; i++) {
    await page.scrollY(-stepPx);
    await sleep(delayMs);
  }
}

// -------------------------------------------------------------------
// 8 Showcase Scenarios
//
// Design principles for good recordings:
//   1. IMAGE-HEAVY sites (photos, thumbnails, colorful layouts)
//   2. Multiple page transitions (list → click → detail)
//   3. Long scroll distances (2000px+) through visually distinct content
//   4. No cookie walls, no login prompts, no bot blocks
//   5. Recognizable brands
// -------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  // 1. nyt-headlines — proven winner, image-heavy news, stealth bypass
  {
    name: 'nyt-headlines',
    domain: 'nytimes.com',
    category: 'Stealth + News',
    goal: 'Bypass bot protection, scroll through headlines and photos',
    actions: 'goto, smoothScroll, evaluate',
    run: async (b) => {
      await b.page.goto('https://www.nytimes.com');
      await sleep(4000);
      // Long smooth scroll through the visually rich homepage
      await smoothScroll(b.page, 2500, 100, 450);
      await sleep(800);
      await smoothScrollUp(b.page, 1200, 120, 400);
      await sleep(500);
      const headlines = (await b.page.evaluate(`
        Array.from(document.querySelectorAll('h3, h2, [data-testid] p.indicate-hover'))
          .map(el => el.textContent.trim())
          .filter(t => t.length > 15 && t.length < 200)
          .slice(0, 5)
      `)) as string[];
      const html = await b.page.content(8000);
      if (!headlines?.length && html.length < 5000) throw new Error('NYT did not load');
      return headlines?.length ? headlines.join(' | ') : `Page loaded (${html.length} chars)`;
    },
  },

  // 2. stackoverflow-browse — proven winner, rich Q&A with page transition
  {
    name: 'stackoverflow-browse',
    domain: 'stackoverflow.com',
    category: 'Search & Navigate',
    goal: 'Browse questions list, click into a question, scroll answers',
    actions: 'goto, smoothScroll, click, evaluate',
    run: async (b) => {
      await b.page.goto('https://stackoverflow.com/questions');
      await sleep(3500);
      await smoothScroll(b.page, 800, 100, 450);
      await sleep(800);
      // Click into first question — page transition
      try {
        await b.page.evaluate(`document.querySelector('.s-post-summary--content h3 a')?.click()`);
        await sleep(4000);
      } catch {
        await b.page.goto('https://stackoverflow.com/questions/927358/how-do-i-undo-the-most-recent-local-commits-in-git');
        await sleep(3500);
      }
      // Scroll through the answers
      await smoothScroll(b.page, 1800, 100, 400);
      await sleep(600);
      await smoothScrollUp(b.page, 700, 120, 350);
      await sleep(500);
      const data = (await b.page.evaluate(`
        (function() {
          const title = document.querySelector('h1 a, h1')?.textContent?.trim();
          const votes = document.querySelector('.js-vote-count, [itemprop="upvoteCount"]')?.textContent?.trim();
          const answerCount = document.querySelectorAll('.answer, .js-answer').length;
          return { title: title?.slice(0, 80), votes, answerCount };
        })()
      `)) as { title: string; votes: string; answerCount: number };
      return `${data.title} | ${data.votes} votes, ${data.answerCount} answers`;
    },
  },

  // 3. cnn-article — image-heavy news, browse headlines then read an article
  {
    name: 'cnn-article',
    domain: 'cnn.com',
    category: 'News + Navigation',
    goal: 'Browse CNN homepage, click into an article, scroll through with photos',
    actions: 'goto, smoothScroll, click, evaluate',
    run: async (b) => {
      await b.page.goto('https://www.cnn.com');
      await sleep(4000);
      // Scroll the homepage — image-heavy cards
      await smoothScroll(b.page, 1500, 100, 450);
      await sleep(800);
      // Click the first article link
      try {
        await b.page.evaluate(`
          (document.querySelector('[data-link-type="article"] a') ||
           document.querySelector('.container__link') ||
           document.querySelector('a[href*="/202"]'))?.click()
        `);
        await sleep(4500);
      } catch {
        await smoothScrollUp(b.page, 800, 120, 400);
        await sleep(500);
        return 'CNN homepage loaded — article click failed';
      }
      // Scroll through the full article (photos, embeds, text)
      await smoothScroll(b.page, 3000, 100, 400);
      await sleep(600);
      await smoothScrollUp(b.page, 1000, 120, 350);
      await sleep(500);
      const title = (await b.page.evaluate(`document.querySelector('h1')?.textContent?.trim()`)) as string;
      return title?.slice(0, 100) || 'CNN article loaded';
    },
  },

  // 4. bbc-article — international news, clean layout, image-rich articles
  {
    name: 'bbc-article',
    domain: 'bbc.com',
    category: 'News + Navigation',
    goal: 'Browse BBC News, click into article, scroll through with images',
    actions: 'goto, smoothScroll, click, evaluate',
    run: async (b) => {
      await b.page.goto('https://www.bbc.com/news');
      await sleep(4000);
      // Scroll the news homepage — cards with images
      await smoothScroll(b.page, 1200, 100, 450);
      await sleep(800);
      // Click first article
      try {
        await b.page.evaluate(`
          (document.querySelector('[data-testid="internal-link"]') ||
           document.querySelector('a[href*="/news/articles"]') ||
           document.querySelector('.media__link') ||
           document.querySelector('a[class*="PromoLink"]'))?.click()
        `);
        await sleep(4500);
      } catch {
        await smoothScrollUp(b.page, 600, 120, 400);
        return 'BBC News homepage loaded — article click failed';
      }
      // Scroll through the article — photos, captions, text blocks
      await smoothScroll(b.page, 2500, 100, 400);
      await sleep(600);
      await smoothScrollUp(b.page, 800, 120, 350);
      await sleep(500);
      const title = (await b.page.evaluate(`document.querySelector('h1')?.textContent?.trim()`)) as string;
      return title?.slice(0, 100) || 'BBC article loaded';
    },
  },

  // 5. techcrunch-browse — tech news with large hero images, colorful cards
  {
    name: 'techcrunch-browse',
    domain: 'techcrunch.com',
    category: 'Tech News',
    goal: 'Browse TechCrunch homepage, scroll through image-heavy article previews',
    actions: 'goto, smoothScroll, click, evaluate',
    run: async (b) => {
      await b.page.goto('https://techcrunch.com');
      await sleep(4000);
      // Scroll through the TechCrunch homepage — hero images, article cards
      await smoothScroll(b.page, 2500, 100, 450);
      await sleep(800);
      // Click into an article
      try {
        await b.page.evaluate(`
          (document.querySelector('h2 a[href*="techcrunch.com/202"]') ||
           document.querySelector('h3 a[href*="techcrunch.com/202"]') ||
           document.querySelector('.post-block__title a'))?.click()
        `);
        await sleep(4500);
      } catch {
        await smoothScrollUp(b.page, 1200, 120, 400);
        return 'TechCrunch homepage loaded — article click failed';
      }
      // Scroll through the full article
      await smoothScroll(b.page, 2500, 100, 400);
      await sleep(600);
      await smoothScrollUp(b.page, 800, 120, 350);
      await sleep(500);
      const title = (await b.page.evaluate(`document.querySelector('h1')?.textContent?.trim()`)) as string;
      return title?.slice(0, 100) || 'TechCrunch article loaded';
    },
  },

  // 6. espn-scores — colorful sports page with team logos, scores, standings
  {
    name: 'espn-scores',
    domain: 'espn.com',
    category: 'Sports Data',
    goal: 'Browse ESPN scores and standings with team logos and stats',
    actions: 'goto, smoothScroll, click, evaluate',
    run: async (b) => {
      await b.page.goto('https://www.espn.com');
      await sleep(4000);
      // Scroll the homepage — scoreboard, top stories with images
      await smoothScroll(b.page, 2000, 100, 450);
      await sleep(800);
      // Navigate to NBA standings (colorful team logos/stats)
      try {
        await b.page.goto('https://www.espn.com/nba/standings');
        await sleep(4000);
      } catch {}
      // Scroll through standings table
      await smoothScroll(b.page, 2000, 100, 400);
      await sleep(600);
      await smoothScrollUp(b.page, 800, 120, 350);
      await sleep(500);
      const title = await b.page.title();
      return (title as string)?.slice(0, 80) || 'ESPN loaded';
    },
  },

  // 7. reddit-pics — image-heavy subreddit with thumbnails and comments
  {
    name: 'reddit-pics',
    domain: 'reddit.com',
    category: 'Social Media',
    goal: 'Browse r/pics image gallery, click post, scroll through comments',
    actions: 'goto, smoothScroll, click, evaluate',
    run: async (b) => {
      // Use old reddit for more reliable rendering
      await b.page.goto('https://old.reddit.com/r/pics/');
      await sleep(4000);
      // Scroll the image-heavy listing
      await smoothScroll(b.page, 1500, 100, 450);
      await sleep(800);
      // Click into top post
      try {
        await b.page.evaluate(`document.querySelector('.thing .title a.title')?.click()`);
        await sleep(4500);
      } catch {
        await smoothScrollUp(b.page, 800, 120, 400);
        return 'r/pics listing loaded — post click failed';
      }
      // Scroll through comments
      await smoothScroll(b.page, 2500, 100, 400);
      await sleep(600);
      await smoothScrollUp(b.page, 800, 120, 350);
      await sleep(500);
      const title = (await b.page.evaluate(`
        (document.querySelector('.title a.title') || document.querySelector('h1'))?.textContent?.trim()
      `)) as string;
      return title?.slice(0, 100) || 'Reddit post loaded';
    },
  },

  // 8. amazon-bestsellers — product images, ratings, prices in colorful grid
  {
    name: 'amazon-bestsellers',
    domain: 'amazon.com',
    category: 'E-Commerce',
    goal: 'Browse Amazon best sellers, scroll through product grid with images',
    actions: 'goto, smoothScroll, click, evaluate',
    run: async (b) => {
      await b.page.goto('https://www.amazon.com/gp/bestsellers/');
      await sleep(4500);
      // Scroll through the best sellers grid — product images, ratings, prices
      await smoothScroll(b.page, 2500, 100, 450);
      await sleep(800);
      // Click into a product
      try {
        await b.page.evaluate(`
          (document.querySelector('.a-link-normal[href*="/dp/"]') ||
           document.querySelector('.zg-grid-general-faceout a'))?.click()
        `);
        await sleep(4500);
      } catch {
        await smoothScrollUp(b.page, 1200, 120, 400);
        return 'Amazon best sellers loaded — product click failed';
      }
      // Scroll through the product page — images, reviews, specs
      await smoothScroll(b.page, 3000, 100, 400);
      await sleep(600);
      await smoothScrollUp(b.page, 1000, 120, 350);
      await sleep(500);
      const title = (await b.page.evaluate(`
        (document.querySelector('#productTitle') || document.querySelector('h1'))?.textContent?.trim()
      `)) as string;
      return title?.slice(0, 100) || 'Amazon product loaded';
    },
  },
];

// -------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------

async function runScenario(scenario: Scenario): Promise<ShowcaseResult> {
  const start = Date.now();

  const browser = new SpiderBrowser({
    apiKey: API_KEY!,
    record: true,
    browser: 'chrome-h' as any,
    logLevel: 'warn',
    connectTimeoutMs: 25000,
    commandTimeoutMs: 35000,
    maxRetries: 0,
    stealth: 0,
    smartRetry: false,
  });

  let sessionId = '';
  browser.on('recording.started', (e) => {
    sessionId = e.sessionId;
  });

  let status: 'pass' | 'fail' | 'partial' = 'fail';
  let error = '';
  let contentLength = 0;
  let extractedData = '';
  let creditsUsed = 0;

  try {
    await browser.init();
    extractedData = await scenario.run(browser);
    status = 'pass';
    try { contentLength = (await browser.page.rawContent()).length; } catch {}
    try { creditsUsed = await browser.getSessionCredits(); } catch {}
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    try {
      contentLength = (await browser.page.rawContent()).length;
      if (contentLength > 1000) status = 'partial';
    } catch {}
  } finally {
    if (!sessionId) await sleep(1000);
    await browser.close().catch(() => {});
  }

  const timeMs = Date.now() - start;
  const result: ShowcaseResult = {
    scenario: scenario.name,
    domain: scenario.domain,
    category: scenario.category,
    goal: scenario.goal,
    actions_used: scenario.actions,
    status,
    session_id: sessionId,
    extracted_data: extractedData.slice(0, 300),
    time_ms: timeMs,
    content_length: contentLength,
    error: error.slice(0, 200),
    browser: browser.browser,
    stealth_level: browser.stealthLevel,
    credits_used: creditsUsed,
  };

  const icon = status === 'pass' ? 'PASS' : status === 'partial' ? 'PART' : 'FAIL';
  const sid = sessionId ? ` [${sessionId.slice(0, 8)}]` : ' [no-sid]';
  console.log(
    `  [${icon}] ${scenario.name.padEnd(30)}${sid} ${String(timeMs).padStart(6)}ms  ${status === 'pass' ? extractedData.slice(0, 70) : error.slice(0, 70)}`,
  );

  return result;
}

async function runBatch(scenarios: Scenario[], concurrency: number): Promise<void> {
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (idx < scenarios.length) {
          const i = idx++;
          results.push(await runScenario(scenarios[i]!));
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function esc(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n'))
    return `"${val.replace(/"/g, '""')}"`;
  return val;
}

function writeCSV(filepath: string): void {
  const h = [
    'scenario', 'domain', 'category', 'goal', 'actions_used', 'status',
    'session_id', 'extracted_data', 'time_ms', 'content_length',
    'browser', 'stealth_level', 'credits_used', 'error',
  ];
  const rows = results.map((r) =>
    [
      esc(r.scenario), esc(r.domain), esc(r.category), esc(r.goal), esc(r.actions_used),
      r.status, esc(r.session_id), esc(r.extracted_data), r.time_ms, r.content_length,
      r.browser, r.stealth_level, r.credits_used, esc(r.error),
    ].join(','),
  );
  fs.writeFileSync(filepath, [h.join(','), ...rows].join('\n'), 'utf-8');
}

async function main() {
  console.log('Spider Browser — Showcase Recording Generator');
  console.log('='.repeat(70));

  let filtered = ONLY_FILTER
    ? SCENARIOS.filter(
        (s) =>
          s.name.includes(ONLY_FILTER) ||
          s.domain.includes(ONLY_FILTER) ||
          s.category.toLowerCase().includes(ONLY_FILTER.toLowerCase()),
      )
    : SCENARIOS;

  if (!filtered.length) {
    console.error(`No match: "${ONLY_FILTER}"`);
    process.exit(1);
  }

  console.log(
    `  ${filtered.length} scenarios | concurrency=${CONCURRENCY}${ONLY_FILTER ? ` | filter=${ONLY_FILTER}` : ''}`,
  );
  console.log(`  record=true | browser=chrome-h\n`);

  await runBatch(filtered, CONCURRENCY);

  const order = new Map(filtered.map((s, i) => [s.name, i]));
  results.sort((a, b) => (order.get(a.scenario) ?? 99) - (order.get(b.scenario) ?? 99));

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(path.dirname(new URL(import.meta.url).pathname), `showcase-recordings-${ts}.csv`);
  writeCSV(csvPath);

  const passed = results.filter((r) => r.status === 'pass').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const avg = Math.round(results.reduce((s, r) => s + r.time_ms, 0) / results.length);
  const credits = results.reduce((s, r) => s + r.credits_used, 0);
  const withSid = results.filter((r) => r.session_id).length;

  console.log('\n' + '='.repeat(70));
  console.log(`  Pass: ${passed}  Partial: ${partial}  Fail: ${failed}  Avg: ${avg}ms  Credits: ${credits.toFixed(2)}`);
  console.log(`  Recordings captured: ${withSid}/${results.length}`);

  if (withSid > 0) {
    console.log(`\n  Session IDs for review:`);
    for (const r of results) {
      if (r.session_id) console.log(`    ${r.scenario.padEnd(30)} ${r.session_id}`);
    }
  }

  console.log(`\n  CSV: ${csvPath}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
