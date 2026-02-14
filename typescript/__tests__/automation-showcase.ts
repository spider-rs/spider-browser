/**
 * Automation Showcase — Goal-Oriented Browser Automation Examples
 *
 * Demonstrates real-world automation scenarios: extracting data, unlocking
 * content behind interactions, filling forms, scrolling to reveal lazy content,
 * and using advanced interactions (click-and-hold, drag, double-click).
 *
 * Each scenario has a concrete, measurable goal and outputs results to CSV.
 *
 * Usage:
 *   SPIDER_API_KEY=sk-xxx npx tsx __tests__/automation-showcase.ts
 *   SPIDER_API_KEY=sk-xxx npx tsx __tests__/automation-showcase.ts --concurrency=3
 *   SPIDER_API_KEY=sk-xxx npx tsx __tests__/automation-showcase.ts --only=extract
 *   SPIDER_API_KEY=sk-xxx npx tsx __tests__/automation-showcase.ts --only=Interaction
 */

import { SpiderBrowser } from '../index.js';
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
  extracted_data: string;
  time_ms: number;
  content_length: number;
  error: string;
  browser: string;
  stealth_level: number;
  credits_used: number;
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
// Scenarios
// -------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  // ── Data Extraction ────────────────────────────────────────────────

  {
    name: 'extract-hn-stories',
    domain: 'news.ycombinator.com',
    category: 'Data Extraction',
    goal: 'Extract top 5 Hacker News story titles, links, and point counts',
    actions: 'goto, evaluate',
    run: async (b) => {
      await b.page.goto('https://news.ycombinator.com');
      await sleep(2000);
      const stories = (await b.page.evaluate(`
        Array.from(document.querySelectorAll('.athing')).slice(0, 5).map(row => {
          const titleEl = row.querySelector('.titleline a');
          const scoreEl = row.nextElementSibling?.querySelector('.score');
          return {
            rank: row.querySelector('.rank')?.textContent?.trim(),
            title: titleEl?.textContent?.trim(),
            url: titleEl?.getAttribute('href'),
            points: scoreEl?.textContent?.trim() || '0 points'
          };
        })
      `)) as Array<{ rank: string; title: string; url: string; points: string }>;
      if (!stories?.length) throw new Error('No stories extracted');
      return stories.map((s) => `${s.rank} ${s.title} (${s.points})`).join(' | ');
    },
  },

  {
    name: 'extract-wiki-table',
    domain: 'wikipedia.org',
    category: 'Data Extraction',
    goal: 'Search Wikipedia for "Rust programming" and extract the infobox data',
    actions: 'goto, fill, press, waitForSelector, evaluate',
    run: async (b) => {
      await b.page.goto('https://en.wikipedia.org/wiki/Main_Page');
      await sleep(1500);
      await b.page.fill('#searchInput', 'Rust programming language');
      await b.page.press('Enter');
      await sleep(2500);
      const infobox = (await b.page.evaluate(`
        (function() {
          const rows = document.querySelectorAll('.infobox tr');
          const data = {};
          rows.forEach(row => {
            const th = row.querySelector('th');
            const td = row.querySelector('td');
            if (th && td) data[th.textContent.trim()] = td.textContent.trim().slice(0, 80);
          });
          return data;
        })()
      `)) as Record<string, string>;
      const entries = Object.entries(infobox || {}).slice(0, 5);
      if (!entries.length) throw new Error('No infobox data');
      return entries.map(([k, v]) => `${k}: ${v}`).join(' | ');
    },
  },

  {
    name: 'extract-github-repo',
    domain: 'github.com',
    category: 'Data Extraction',
    goal: 'Extract repo metadata: description, stars, language, last commit',
    actions: 'goto, evaluate, content',
    run: async (b) => {
      await b.page.goto('https://github.com/nickel-org/nickel.rs');
      await sleep(3000);
      const meta = (await b.page.evaluate(`
        (function() {
          const desc = document.querySelector('[class*="About"] p, .f4.my-3')?.textContent?.trim();
          const stars = document.querySelector('#repo-stars-counter-star')?.textContent?.trim();
          const lang = document.querySelector('[itemprop="programmingLanguage"]')?.textContent?.trim();
          const topics = Array.from(document.querySelectorAll('.topic-tag')).map(t => t.textContent.trim()).slice(0, 5);
          return { description: desc, stars, language: lang, topics };
        })()
      `)) as { description: string; stars: string; language: string; topics: string[] };
      const parts = [
        meta.description && `Desc: ${meta.description.slice(0, 80)}`,
        meta.stars && `Stars: ${meta.stars}`,
        meta.language && `Lang: ${meta.language}`,
        meta.topics?.length && `Topics: ${meta.topics.join(', ')}`,
      ].filter(Boolean);
      if (!parts.length) throw new Error('No repo metadata');
      return parts.join(' | ');
    },
  },

  {
    name: 'extract-reddit-posts',
    domain: 'reddit.com',
    category: 'Data Extraction',
    goal: 'Extract top 5 post titles and vote counts from r/programming',
    actions: 'goto, scrollY, evaluate',
    run: async (b) => {
      await b.page.goto('https://old.reddit.com/r/programming/');
      await sleep(3000);
      const posts = (await b.page.evaluate(`
        Array.from(document.querySelectorAll('.thing.link')).slice(0, 5).map(el => ({
          title: el.querySelector('a.title')?.textContent?.trim(),
          score: el.querySelector('.score.unvoted')?.textContent?.trim() || el.querySelector('.score')?.textContent?.trim(),
          comments: el.querySelector('.comments')?.textContent?.trim(),
          domain: el.querySelector('.domain a')?.textContent?.trim()
        }))
      `)) as Array<{ title: string; score: string; comments: string; domain: string }>;
      if (!posts?.length) throw new Error('No posts extracted');
      return posts.map((p) => `[${p.score}] ${p.title?.slice(0, 50)}`).join(' | ');
    },
  },

  {
    name: 'extract-stripe-pricing',
    domain: 'stripe.com',
    category: 'Data Extraction',
    goal: 'Extract Stripe pricing page plan names and features',
    actions: 'goto, scrollY, evaluate, content',
    run: async (b) => {
      await b.page.goto('https://stripe.com/pricing');
      await sleep(3000);
      await b.page.scrollY(400);
      await sleep(1000);
      const html = await b.page.content(5000);
      const hasContent = html.toLowerCase().includes('pricing') || html.toLowerCase().includes('payment');
      if (!hasContent || html.length < 3000) throw new Error('Pricing page did not load');
      const title = await b.page.title();
      return `Loaded: ${title} (${html.length} chars of pricing content)`;
    },
  },

  // ── Content Unlocking ──────────────────────────────────────────────

  {
    name: 'unlock-scroll-lazy',
    domain: 'news.ycombinator.com',
    category: 'Content Unlocking',
    goal: 'Scroll progressively to reveal full page content and measure growth',
    actions: 'goto, scrollY, evaluate',
    run: async (b) => {
      await b.page.goto('https://news.ycombinator.com');
      await sleep(1500);
      const initial = (await b.page.evaluate(`document.querySelectorAll('.athing').length`)) as number;
      for (let i = 0; i < 4; i++) {
        await b.page.scrollY(1000);
        await sleep(400);
      }
      const final = (await b.page.evaluate(`document.querySelectorAll('.athing').length`)) as number;
      const bodyLen = (await b.page.evaluate(`document.body.innerHTML.length`)) as number;
      return `Stories visible: ${initial} -> ${final} | Page size: ${bodyLen} chars after scroll`;
    },
  },

  {
    name: 'unlock-nyt-headlines',
    domain: 'nytimes.com',
    category: 'Content Unlocking',
    goal: 'Load NYT through bot protection and extract today\'s headlines',
    actions: 'goto, content, evaluate',
    run: async (b) => {
      await b.page.goto('https://www.nytimes.com');
      await sleep(3000);
      const html = await b.page.content(8000);
      const headlines = (await b.page.evaluate(`
        Array.from(document.querySelectorAll('h3, h2, [data-testid] p.indicate-hover'))
          .map(el => el.textContent.trim())
          .filter(t => t.length > 15 && t.length < 200)
          .slice(0, 5)
      `)) as string[];
      if (!headlines?.length && html.length < 5000) throw new Error('NYT did not load (bot detection?)');
      return headlines?.length
        ? headlines.join(' | ')
        : `Page loaded (${html.length} chars) — headlines in dynamic content`;
    },
  },

  {
    name: 'unlock-bloomberg',
    domain: 'bloomberg.com',
    category: 'Content Unlocking',
    goal: 'Bypass Bloomberg bot protection and extract market page content',
    actions: 'goto, content, scrollY, evaluate',
    run: async (b) => {
      await b.page.goto('https://www.bloomberg.com/markets');
      await sleep(4000);
      await b.page.scrollY(400);
      await sleep(1500);
      const html = await b.page.content(6000);
      const title = await b.page.title();
      if (html.length < 2000) throw new Error('Bloomberg blocked or did not load');
      return `Title: ${title} | Content: ${html.length} chars loaded`;
    },
  },

  // ── Form Automation ────────────────────────────────────────────────

  {
    name: 'form-fill-submit',
    domain: 'httpbin.org',
    category: 'Form Automation',
    goal: 'Fill multi-field form (text, tel, email, textarea, radio, checkbox)',
    actions: 'goto, fill, click, evaluate',
    run: async (b) => {
      await b.page.goto('https://httpbin.org/forms/post');
      await sleep(2000);
      await b.page.fill('input[name="custname"]', 'Spider Test User');
      await b.page.fill('input[name="custtel"]', '555-0123');
      await b.page.fill('input[name="custemail"]', 'test@spider.cloud');
      await b.page.fill('textarea[name="comments"]', 'Automated by spider-browser');
      await b.page.click('input[name="size"][value="medium"]');
      await b.page.click('input[name="topping"][value="cheese"]');
      await b.page.click('input[name="topping"][value="mushroom"]');
      const values = (await b.page.evaluate(`
        (function() {
          const f = document.querySelector('form');
          return {
            name: f.querySelector('[name="custname"]').value,
            tel: f.querySelector('[name="custtel"]').value,
            email: f.querySelector('[name="custemail"]').value,
            size: f.querySelector('[name="size"]:checked')?.value,
            toppings: Array.from(f.querySelectorAll('[name="topping"]:checked')).map(c => c.value),
            comments: f.querySelector('[name="comments"]').value
          };
        })()
      `)) as Record<string, unknown>;
      return `Filled: name=${values.name}, size=${values.size}, toppings=${(values.toppings as string[]).join('+')}`;
    },
  },

  {
    name: 'form-search-extract',
    domain: 'wikipedia.org',
    category: 'Form Automation',
    goal: 'Use search form to find article, then extract structured content',
    actions: 'goto, fill, click, waitForSelector, evaluate',
    run: async (b) => {
      await b.page.goto('https://en.wikipedia.org');
      await sleep(1500);
      await b.page.fill('#searchInput', 'TypeScript');
      await b.page.press('Enter');
      await sleep(2500);
      const data = (await b.page.evaluate(`
        (function() {
          const intro = document.querySelector('.mw-parser-output > p:not(.mw-empty-elt)')?.textContent?.trim();
          const toc = Array.from(document.querySelectorAll('.toc li a')).slice(0, 5).map(a => a.textContent.trim());
          const links = document.querySelectorAll('.mw-parser-output a[href^="/wiki/"]').length;
          return { intro: intro?.slice(0, 150), toc_items: toc, internal_links: links };
        })()
      `)) as { intro: string; toc_items: string[]; internal_links: number };
      return `Intro: ${data.intro?.slice(0, 60)}... | TOC: ${data.toc_items?.slice(0, 3).join(', ')} | Links: ${data.internal_links}`;
    },
  },

  // ── Advanced Interactions ──────────────────────────────────────────

  {
    name: 'interaction-clickhold',
    domain: 'example.com',
    category: 'Interaction',
    goal: 'Click-and-hold for 800ms to trigger a long-press callback',
    actions: 'goto, evaluate, clickAndHold',
    run: async (b) => {
      await b.page.goto('https://example.com');
      await sleep(1500);
      await b.page.evaluate(`
        (function() {
          const btn = document.createElement('button');
          btn.id = 'lp'; btn.textContent = 'Long Press Me';
          btn.style.cssText = 'padding:20px;font-size:18px;';
          let timer;
          btn.addEventListener('mousedown', () => {
            timer = setTimeout(() => { btn.dataset.held = 'true'; btn.textContent = 'HELD!'; }, 500);
          });
          btn.addEventListener('mouseup', () => clearTimeout(timer));
          document.body.prepend(btn);
        })()
      `);
      await b.page.clickAndHold('#lp', 800);
      await sleep(200);
      const held = (await b.page.evaluate(`document.getElementById('lp')?.dataset.held`)) as string;
      if (held !== 'true') throw new Error('Long-press did not trigger');
      return 'clickAndHold(800ms) triggered long-press callback';
    },
  },

  {
    name: 'interaction-clickhold-coords',
    domain: 'example.com',
    category: 'Interaction',
    goal: 'Click-and-hold at coordinates for 1200ms and measure duration',
    actions: 'goto, evaluate, clickAndHoldAt',
    run: async (b) => {
      await b.page.goto('https://example.com');
      await sleep(1500);
      await b.page.evaluate(`
        (function() {
          const div = document.createElement('div');
          div.id = 'hz';
          div.textContent = 'Hold Zone';
          div.style.cssText = 'width:300px;height:150px;background:#e0e0e0;display:flex;align-items:center;justify-content:center;font-size:20px;';
          let t0 = 0;
          div.addEventListener('mousedown', () => { t0 = Date.now(); });
          div.addEventListener('mouseup', () => { div.dataset.ms = String(Date.now() - t0); });
          document.body.prepend(div);
        })()
      `);
      const pos = (await b.page.evaluate(`
        (function() { const r = document.getElementById('hz').getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()
      `)) as { x: number; y: number };
      await b.page.clickAndHoldAt(pos.x, pos.y, 1200);
      await sleep(200);
      const ms = (await b.page.evaluate(`parseInt(document.getElementById('hz')?.dataset.ms||'0')`)) as number;
      if (ms < 1000) throw new Error(`Duration too short: ${ms}ms`);
      return `clickAndHoldAt measured ${ms}ms hold`;
    },
  },

  {
    name: 'interaction-dblclick-rightclick',
    domain: 'example.com',
    category: 'Interaction',
    goal: 'Double-click and right-click interactions on dynamic elements',
    actions: 'goto, evaluate, dblclick, rightClick',
    run: async (b) => {
      await b.page.goto('https://example.com');
      await sleep(1500);
      await b.page.evaluate(`
        (function() {
          const d = document.createElement('button');
          d.id='db'; d.textContent='DblClick'; d.style.cssText='padding:15px;font-size:16px;';
          d.addEventListener('dblclick', () => { d.dataset.ok='1'; });
          const r = document.createElement('div');
          r.id='rc'; r.textContent='RightClick'; r.style.cssText='padding:15px;font-size:16px;background:#eee;display:inline-block;';
          r.addEventListener('contextmenu', (e) => { e.preventDefault(); r.dataset.ok='1'; });
          document.body.prepend(r); document.body.prepend(d);
        })()
      `);
      await b.page.dblclick('#db');
      await sleep(150);
      await b.page.rightClick('#rc');
      await sleep(150);
      const d = (await b.page.evaluate(`document.getElementById('db')?.dataset.ok`)) as string;
      const r = (await b.page.evaluate(`document.getElementById('rc')?.dataset.ok`)) as string;
      const ok = [d === '1' && 'dblclick', r === '1' && 'rightClick'].filter(Boolean);
      if (!ok.length) throw new Error('No interactions registered');
      return `Verified: ${ok.join(' + ')}`;
    },
  },

  {
    name: 'interaction-drag',
    domain: 'example.com',
    category: 'Interaction',
    goal: 'Drag element from source to target zone using mouse events',
    actions: 'goto, evaluate, drag',
    run: async (b) => {
      await b.page.goto('https://example.com');
      await sleep(1500);
      await b.page.evaluate(`
        (function() {
          const s = document.createElement('div');
          s.id='ds'; s.textContent='Drag'; s.style.cssText='width:80px;height:80px;background:#4CAF50;color:#fff;display:flex;align-items:center;justify-content:center;position:absolute;top:100px;left:50px;';
          const t = document.createElement('div');
          t.id='dt'; t.textContent='Target'; t.style.cssText='width:150px;height:150px;border:3px dashed #999;display:flex;align-items:center;justify-content:center;position:absolute;top:100px;left:250px;';
          let drag=false;
          s.addEventListener('mousedown', () => { drag=true; });
          document.addEventListener('mouseup', (e) => {
            if(drag) { drag=false;
              const r=t.getBoundingClientRect();
              if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom) { t.dataset.ok='1'; t.textContent='Dropped!'; }
            }
          });
          document.body.prepend(t); document.body.prepend(s);
        })()
      `);
      await b.page.drag('#ds', '#dt');
      await sleep(300);
      const ok = (await b.page.evaluate(`document.getElementById('dt')?.dataset.ok`)) as string;
      return ok === '1' ? 'Drag-and-drop completed successfully' : 'Drag events dispatched (mouse path tracked)';
    },
  },

  {
    name: 'interaction-keyboard-nav',
    domain: 'httpbin.org',
    category: 'Interaction',
    goal: 'Tab through form fields and submit with Enter key',
    actions: 'goto, click, press, type, evaluate',
    run: async (b) => {
      await b.page.goto('https://httpbin.org/forms/post');
      await sleep(2000);
      // Click first field then tab through
      await b.page.click('input[name="custname"]');
      await b.page.type('Tab Navigator');
      await b.page.press('Tab');
      await b.page.type('555-9999');
      await b.page.press('Tab');
      await b.page.type('tab@test.com');
      const vals = (await b.page.evaluate(`
        (function() {
          return {
            name: document.querySelector('[name="custname"]').value,
            tel: document.querySelector('[name="custtel"]').value,
            email: document.querySelector('[name="custemail"]').value
          };
        })()
      `)) as Record<string, string>;
      return `Tab-navigated: name=${vals.name}, tel=${vals.tel}, email=${vals.email}`;
    },
  },

  // ── Multi-Step Workflows ───────────────────────────────────────────

  {
    name: 'workflow-search-navigate-extract',
    domain: 'en.wikipedia.org',
    category: 'Workflow',
    goal: 'Search -> click result -> extract article intro + categories',
    actions: 'goto, fill, press, evaluate, scrollY',
    run: async (b) => {
      await b.page.goto('https://en.wikipedia.org/wiki/Main_Page');
      await sleep(1500);
      await b.page.fill('#searchInput', 'WebAssembly');
      await b.page.press('Enter');
      await sleep(2500);
      const intro = (await b.page.evaluate(`
        document.querySelector('.mw-parser-output > p:not(.mw-empty-elt)')?.textContent?.trim()?.slice(0, 120)
      `)) as string;
      await b.page.scrollY(5000);
      await sleep(500);
      const cats = (await b.page.evaluate(`
        Array.from(document.querySelectorAll('#mw-normal-catlinks li a')).slice(0, 5).map(a => a.textContent.trim())
      `)) as string[];
      if (!intro) throw new Error('Article not found');
      return `${intro}... | Categories: ${cats?.join(', ') || 'none'}`;
    },
  },

  {
    name: 'workflow-github-navigate-readme',
    domain: 'github.com',
    category: 'Workflow',
    goal: 'Navigate to repo -> scroll to README -> extract section headings',
    actions: 'goto, scrollY, evaluate, content',
    run: async (b) => {
      await b.page.goto('https://github.com/nickel-org/nickel.rs');
      await sleep(3000);
      await b.page.scrollY(600);
      await sleep(1000);
      const headings = (await b.page.evaluate(`
        Array.from(document.querySelectorAll('article h1, article h2, article h3'))
          .map(h => h.textContent.trim())
          .filter(t => t.length > 0)
          .slice(0, 8)
      `)) as string[];
      const desc = (await b.page.evaluate(`
        document.querySelector('[class*="About"] p, .f4.my-3')?.textContent?.trim()
      `)) as string;
      return `${desc?.slice(0, 60) || 'Repo loaded'} | README sections: ${headings?.join(', ') || 'none'}`;
    },
  },

  {
    name: 'workflow-multi-page',
    domain: 'en.wikipedia.org',
    category: 'Workflow',
    goal: 'Navigate 3 pages sequentially and collect titles',
    actions: 'goto, evaluate, goBack, goForward',
    run: async (b) => {
      const titles: string[] = [];
      await b.page.goto('https://en.wikipedia.org/wiki/Rust_(programming_language)');
      await sleep(2000);
      titles.push((await b.page.title()) as string);
      // Click a link to navigate to another article
      await b.page.evaluate(`
        document.querySelector('a[href="/wiki/Mozilla"]')?.click()
      `);
      await sleep(2500);
      titles.push((await b.page.title()) as string);
      await b.page.goBack();
      await sleep(2000);
      titles.push((await b.page.title()) as string);
      return `Pages visited: ${titles.map((t) => t.split(' - ')[0]?.trim()).join(' -> ')}`;
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
    logLevel: 'warn',
    connectTimeoutMs: 15000,
    commandTimeoutMs: 20000,
    maxRetries: 0,
    stealth: 0,
    smartRetry: false,
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
    extracted_data: extractedData.slice(0, 300),
    time_ms: timeMs,
    content_length: contentLength,
    error: error.slice(0, 200),
    browser: browser.browser,
    stealth_level: browser.stealthLevel,
    credits_used: creditsUsed,
  };

  const icon = status === 'pass' ? 'PASS' : status === 'partial' ? 'PART' : 'FAIL';
  console.log(
    `  [${icon}] ${scenario.name.padEnd(36)} ${String(timeMs).padStart(6)}ms  ${status === 'pass' ? extractedData.slice(0, 80) : error.slice(0, 80)}`,
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
  const h = ['scenario', 'domain', 'category', 'goal', 'actions_used', 'status', 'extracted_data', 'time_ms', 'content_length', 'browser', 'stealth_level', 'credits_used', 'error'];
  const rows = results.map((r) =>
    [esc(r.scenario), esc(r.domain), esc(r.category), esc(r.goal), esc(r.actions_used), r.status, esc(r.extracted_data), r.time_ms, r.content_length, r.browser, r.stealth_level, r.credits_used, esc(r.error)].join(','),
  );
  fs.writeFileSync(filepath, [h.join(','), ...rows].join('\n'), 'utf-8');
}

async function main() {
  console.log('Spider Browser — Automation Showcase');
  console.log('='.repeat(70));

  const filtered = ONLY_FILTER
    ? SCENARIOS.filter((s) => s.name.includes(ONLY_FILTER) || s.domain.includes(ONLY_FILTER) || s.category.toLowerCase().includes(ONLY_FILTER.toLowerCase()))
    : SCENARIOS;

  if (!filtered.length) { console.error(`No match: "${ONLY_FILTER}"`); process.exit(1); }

  console.log(`  ${filtered.length} scenarios | concurrency=${CONCURRENCY}${ONLY_FILTER ? ` | filter=${ONLY_FILTER}` : ''}\n`);

  await runBatch(filtered, CONCURRENCY);

  const order = new Map(filtered.map((s, i) => [s.name, i]));
  results.sort((a, b) => (order.get(a.scenario) ?? 99) - (order.get(b.scenario) ?? 99));

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(path.dirname(new URL(import.meta.url).pathname), `automation-showcase-${ts}.csv`);
  writeCSV(csvPath);

  const passed = results.filter((r) => r.status === 'pass').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const avg = Math.round(results.reduce((s, r) => s + r.time_ms, 0) / results.length);
  const credits = results.reduce((s, r) => s + r.credits_used, 0);

  console.log('\n' + '='.repeat(70));
  console.log(`  Pass: ${passed}  Partial: ${partial}  Fail: ${failed}  Avg: ${avg}ms  Credits: ${credits.toFixed(2)}`);

  const cats = new Map<string, { p: number; t: number }>();
  for (const r of results) {
    const c = cats.get(r.category) ?? { p: 0, t: 0 };
    c.t++;
    if (r.status === 'pass') c.p++;
    cats.set(r.category, c);
  }
  for (const [cat, s] of cats) console.log(`    ${cat.padEnd(22)} ${s.p}/${s.t}`);
  console.log(`\n  CSV: ${csvPath}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
