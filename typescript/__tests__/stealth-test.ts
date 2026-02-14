/**
 * Stealth & reliability test against top domains.
 *
 * Uses Spider's search API (site: filter) to discover real interior pages,
 * then tests each with the browser client. This gives realistic test coverage
 * — not just landing pages but actual article, product, and content pages.
 *
 * Outputs results to a CSV file with per-page speed and pass/fail.
 *
 * Usage:
 *   SPIDER_API_KEY=sk-xxx npx tsx typescript/__tests__/stealth-test.ts
 *   SPIDER_API_KEY=sk-xxx npx tsx typescript/__tests__/stealth-test.ts --target=10000
 *   SPIDER_API_KEY=sk-xxx npx tsx typescript/__tests__/stealth-test.ts --target=500 --concurrency=50
 */

import { SpiderBrowser, BlockedError, TimeoutError } from '../index.js';
import type { BrowserType } from '../events/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Prevent unhandled WebSocket errors from crashing the process.
// The `ws` library can emit 'error' events during connection teardown
// (e.g., malformed frames with invalid control payload lengths) that
// escape normal error handling in rare race conditions.
process.on('uncaughtException', (err) => {
  // WS protocol errors during teardown — log and continue
  if (err && 'code' in err && typeof (err as any).code === 'string' && (err as any).code.startsWith('WS_ERR_')) {
    console.error(`[WARN] Suppressed ws library error: ${err.message}`);
    return;
  }
  // Everything else — crash as normal
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

const API_KEY = process.env.SPIDER_API_KEY;
if (!API_KEY) {
  console.error('Set SPIDER_API_KEY env var to run stealth tests');
  process.exit(1);
}

// -------------------------------------------------------------------
// CLI flags
// -------------------------------------------------------------------
const args = process.argv.slice(2);
function getFlag(name: string, defaultValue: number): number {
  const flag = args.find((a) => a.startsWith(`--${name}=`));
  return flag ? parseInt(flag.split('=')[1]!, 10) : defaultValue;
}
function getStringFlag(name: string): string | undefined {
  const flag = args.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split('=').slice(1).join('=') : undefined;
}
/** Path to a previous results CSV. Re-runs only failed URLs and patches the CSV in-place. */
const RETRY_CSV = getStringFlag('retry-csv');
const TARGET_URLS = getFlag('target', 10000);
const CLI_CONCURRENCY = getFlag('concurrency', 25);
const CLI_MAX_RETRIES = getFlag('retries', 6);
const CLI_CONNECT_TIMEOUT = getFlag('connect-timeout', 10000);
const CLI_COMMAND_TIMEOUT = getFlag('command-timeout', 35000);
const CLI_FAST_MODE = args.includes('--fast');
/** Hard per-page timeout. 90s allows hedge + navigation + content wait + 2-3 retry attempts. */
const PAGE_TIMEOUT_MS = getFlag('page-timeout', 90000);
/** Hedging: start a parallel attempt after this delay. */
const HEDGE_DELAY_MS = getFlag('hedge-delay', 3000);
/** Retry pass timeout — per-profile attempt budget. */
const RETRY_TIMEOUT_MS = getFlag('retry-timeout', 75000);
const RETRY_CONCURRENCY = getFlag('retry-concurrency', 15);
const RETRY_MAX_RETRIES = getFlag('retry-retries', 3);
/** Content wait time (ms) for page.content() network idle check. Lower = faster but riskier. */
const CONTENT_WAIT_MS = getFlag('content-wait', CLI_FAST_MODE ? 2000 : 4000);

// -------------------------------------------------------------------
// Test domain configuration
// -------------------------------------------------------------------

interface DomainConfig {
  domain: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  /** Number of interior pages to discover via search (1-3). */
  searchPages: number;
  /** Extra keywords to append to `site:domain` for discovering interior pages. */
  keywords: string;
}

// Curated list: domains by category with difficulty, search depth, and keywords
const TEST_DOMAINS: DomainConfig[] = [
  // E-Commerce — product/category pages (16)
  { domain: 'amazon.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 15, keywords: 'best sellers electronics deals home kitchen' },
  { domain: 'ebay.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 12, keywords: 'deals electronics collectibles vintage auction' },
  { domain: 'walmart.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 12, keywords: 'grocery deals weekly ad electronics toys' },
  { domain: 'target.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'home decor furniture clothing baby' },
  { domain: 'bestbuy.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'laptop deals computers monitors gaming' },
  { domain: 'etsy.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 10, keywords: 'handmade gifts jewelry vintage art' },
  { domain: 'shopify.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'blog ecommerce guide dropshipping store' },
  { domain: 'nike.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'running shoes air max jordan apparel' },
  { domain: 'costco.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'membership deals wholesale electronics grocery' },
  { domain: 'nordstrom.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'sale shoes designer clothing accessories' },
  { domain: 'wayfair.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'furniture living room bedroom kitchen rugs' },
  { domain: 'homedepot.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'power tools appliances kitchen bathroom paint' },
  { domain: 'lowes.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'bathroom vanity flooring appliances tools' },
  { domain: 'macys.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'clothing sale handbags shoes jewelry' },
  { domain: 'sephora.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'skincare makeup bestsellers fragrance' },
  { domain: 'overstock.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'rugs furniture clearance bedding lighting' },

  // Social Media — profile/content pages (11)
  { domain: 'linkedin.com', category: 'Social', difficulty: 'hard', searchPages: 8, keywords: 'company jobs hiring engineering' },
  { domain: 'instagram.com', category: 'Social', difficulty: 'hard', searchPages: 5, keywords: 'explore trending reels' },
  { domain: 'reddit.com', category: 'Social', difficulty: 'medium', searchPages: 15, keywords: 'subreddit popular community explore programming technology' },
  { domain: 'tiktok.com', category: 'Social', difficulty: 'hard', searchPages: 5, keywords: 'trending videos discover creators' },
  { domain: 'facebook.com', category: 'Social', difficulty: 'hard', searchPages: 5, keywords: 'marketplace community groups pages' },
  { domain: 'youtube.com', category: 'Social', difficulty: 'medium', searchPages: 10, keywords: 'tutorial programming learn music technology' },
  { domain: 'medium.com', category: 'Social', difficulty: 'medium', searchPages: 15, keywords: 'software engineering architecture guide programming startup' },
  { domain: 'pinterest.com', category: 'Social', difficulty: 'hard', searchPages: 8, keywords: 'home decor ideas recipes fashion DIY' },
  { domain: 'snapchat.com', category: 'Social', difficulty: 'hard', searchPages: 5, keywords: 'features stories spotlight safety' },
  { domain: 'discord.com', category: 'Social', difficulty: 'medium', searchPages: 5, keywords: 'blog safety community servers developers' },
  { domain: 'threads.net', category: 'Social', difficulty: 'hard', searchPages: 5, keywords: 'trending posts explore' },

  // News — article pages (12)
  { domain: 'nytimes.com', category: 'News', difficulty: 'hard', searchPages: 15, keywords: 'technology business 2026 science health politics' },
  { domain: 'bbc.com', category: 'News', difficulty: 'medium', searchPages: 15, keywords: 'world news technology science health business' },
  { domain: 'cnn.com', category: 'News', difficulty: 'medium', searchPages: 12, keywords: 'politics business technology health world' },
  { domain: 'reuters.com', category: 'News', difficulty: 'medium', searchPages: 12, keywords: 'markets technology business world economy' },
  { domain: 'bloomberg.com', category: 'News', difficulty: 'hard', searchPages: 10, keywords: 'markets economy finance technology AI' },
  { domain: 'wikipedia.org', category: 'News', difficulty: 'easy', searchPages: 20, keywords: 'artificial intelligence machine learning programming history science' },
  { domain: 'wsj.com', category: 'News', difficulty: 'hard', searchPages: 10, keywords: 'business technology economy markets' },
  { domain: 'washingtonpost.com', category: 'News', difficulty: 'hard', searchPages: 10, keywords: 'politics technology climate health business' },
  { domain: 'apnews.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'breaking news world politics technology' },
  { domain: 'nbcnews.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'health science technology business' },
  { domain: 'usatoday.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'money tech travel sports entertainment' },
  { domain: 'theguardian.com', category: 'News', difficulty: 'medium', searchPages: 12, keywords: 'technology environment opinion science world' },

  // Technology — docs/blog pages (12)
  { domain: 'github.com', category: 'Technology', difficulty: 'medium', searchPages: 15, keywords: 'trending repositories rust typescript python javascript' },
  { domain: 'stackoverflow.com', category: 'Technology', difficulty: 'medium', searchPages: 15, keywords: 'javascript async await error handling react python' },
  { domain: 'cloudflare.com', category: 'Technology', difficulty: 'hard', searchPages: 8, keywords: 'blog workers performance security DNS' },
  { domain: 'openai.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'research blog api documentation models' },
  { domain: 'apple.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'iphone macbook pro specs vision watch' },
  { domain: 'google.com', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'about products cloud AI search' },
  { domain: 'figma.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'blog design system resources community' },
  { domain: 'canva.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'templates design features business education' },
  { domain: 'vercel.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'documentation next.js deployment blog' },
  { domain: 'aws.amazon.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'services lambda s3 documentation pricing' },
  { domain: 'azure.microsoft.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'services documentation pricing AI' },
  { domain: 'digitalocean.com', category: 'Technology', difficulty: 'easy', searchPages: 12, keywords: 'tutorials community kubernetes docker nginx' },

  // Finance — info/help pages (9)
  { domain: 'chase.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'credit card checking account mortgage savings' },
  { domain: 'bankofamerica.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'savings account online banking loans credit' },
  { domain: 'coinbase.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'learn crypto bitcoin ethereum defi' },
  { domain: 'paypal.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'business payments send money features' },
  { domain: 'stripe.com', category: 'Finance', difficulty: 'medium', searchPages: 10, keywords: 'documentation payments api connect billing' },
  { domain: 'fidelity.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'retirement investing 401k stocks funds' },
  { domain: 'schwab.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'brokerage accounts trading ETF retirement' },
  { domain: 'robinhood.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'stocks crypto investing learn options' },
  { domain: 'venmo.com', category: 'Finance', difficulty: 'medium', searchPages: 5, keywords: 'send money business features security' },

  // Travel — destination/listing pages (7)
  { domain: 'booking.com', category: 'Travel', difficulty: 'hard', searchPages: 10, keywords: 'hotels new york deals london paris' },
  { domain: 'airbnb.com', category: 'Travel', difficulty: 'hard', searchPages: 10, keywords: 'experiences stays unique homes luxury' },
  { domain: 'expedia.com', category: 'Travel', difficulty: 'hard', searchPages: 10, keywords: 'flights hotels vacation packages cruise' },
  { domain: 'uber.com', category: 'Travel', difficulty: 'medium', searchPages: 8, keywords: 'ride cities pricing eats business' },
  { domain: 'tripadvisor.com', category: 'Travel', difficulty: 'hard', searchPages: 10, keywords: 'restaurants things to do reviews hotels' },
  { domain: 'hotels.com', category: 'Travel', difficulty: 'hard', searchPages: 8, keywords: 'deals last minute bookings rewards' },
  { domain: 'kayak.com', category: 'Travel', difficulty: 'hard', searchPages: 8, keywords: 'cheap flights compare hotels rental cars' },

  // Jobs — career pages (4)
  { domain: 'indeed.com', category: 'Jobs', difficulty: 'hard', searchPages: 10, keywords: 'software engineer remote jobs data science' },
  { domain: 'glassdoor.com', category: 'Jobs', difficulty: 'hard', searchPages: 10, keywords: 'company reviews salaries tech interviews' },
  { domain: 'ziprecruiter.com', category: 'Jobs', difficulty: 'hard', searchPages: 8, keywords: 'remote jobs hiring now engineering' },
  { domain: 'monster.com', category: 'Jobs', difficulty: 'medium', searchPages: 8, keywords: 'career advice resume jobs interview' },

  // Food & Dining (5)
  { domain: 'doordash.com', category: 'Food', difficulty: 'hard', searchPages: 8, keywords: 'restaurants delivery near me grocery' },
  { domain: 'yelp.com', category: 'Food', difficulty: 'medium', searchPages: 10, keywords: 'best restaurants reviews near me bars coffee' },
  { domain: 'grubhub.com', category: 'Food', difficulty: 'hard', searchPages: 8, keywords: 'food delivery restaurants order deals' },
  { domain: 'allrecipes.com', category: 'Food', difficulty: 'easy', searchPages: 12, keywords: 'dinner recipes chicken pasta soup dessert' },
  { domain: 'foodnetwork.com', category: 'Food', difficulty: 'easy', searchPages: 10, keywords: 'recipes shows chefs baking grilling' },

  // Streaming & Entertainment (5)
  { domain: 'twitch.tv', category: 'Streaming', difficulty: 'hard', searchPages: 8, keywords: 'streams gaming popular esports' },
  { domain: 'netflix.com', category: 'Streaming', difficulty: 'hard', searchPages: 5, keywords: 'browse movies series trending' },
  { domain: 'disneyplus.com', category: 'Streaming', difficulty: 'hard', searchPages: 5, keywords: 'movies originals series marvel' },
  { domain: 'hulu.com', category: 'Streaming', difficulty: 'hard', searchPages: 5, keywords: 'shows movies live tv plans' },
  { domain: 'spotify.com', category: 'Streaming', difficulty: 'medium', searchPages: 8, keywords: 'playlists podcasts premium artists' },

  // Education (7)
  { domain: 'coursera.org', category: 'Education', difficulty: 'medium', searchPages: 10, keywords: 'courses machine learning data science AI' },
  { domain: 'edx.org', category: 'Education', difficulty: 'medium', searchPages: 8, keywords: 'courses computer science free certificates' },
  { domain: 'khanacademy.org', category: 'Education', difficulty: 'easy', searchPages: 10, keywords: 'math science computing economics' },
  { domain: 'udemy.com', category: 'Education', difficulty: 'medium', searchPages: 10, keywords: 'programming web development courses python' },
  { domain: 'mit.edu', category: 'Education', difficulty: 'easy', searchPages: 10, keywords: 'research departments admissions courses labs' },
  { domain: 'harvard.edu', category: 'Education', difficulty: 'easy', searchPages: 10, keywords: 'programs research admissions schools' },
  { domain: 'duolingo.com', category: 'Education', difficulty: 'medium', searchPages: 5, keywords: 'language learning courses app' },

  // Health & Medical (5)
  { domain: 'webmd.com', category: 'Health', difficulty: 'medium', searchPages: 12, keywords: 'symptoms conditions treatment drugs vitamins' },
  { domain: 'mayoclinic.org', category: 'Health', difficulty: 'easy', searchPages: 12, keywords: 'diseases conditions healthy lifestyle symptoms treatment' },
  { domain: 'healthline.com', category: 'Health', difficulty: 'medium', searchPages: 10, keywords: 'nutrition fitness wellness mental health' },
  { domain: 'nih.gov', category: 'Health', difficulty: 'easy', searchPages: 10, keywords: 'research clinical trials health grants' },
  { domain: 'clevelandclinic.org', category: 'Health', difficulty: 'easy', searchPages: 10, keywords: 'health library diseases treatments symptoms' },

  // Real Estate (5)
  { domain: 'zillow.com', category: 'Real Estate', difficulty: 'hard', searchPages: 10, keywords: 'homes for sale rent estimate mortgage' },
  { domain: 'realtor.com', category: 'Real Estate', difficulty: 'hard', searchPages: 8, keywords: 'houses for sale listings agents' },
  { domain: 'redfin.com', category: 'Real Estate', difficulty: 'hard', searchPages: 8, keywords: 'homes for sale market data agents' },
  { domain: 'trulia.com', category: 'Real Estate', difficulty: 'hard', searchPages: 8, keywords: 'neighborhoods homes rent schools' },
  { domain: 'apartments.com', category: 'Real Estate', difficulty: 'medium', searchPages: 8, keywords: 'apartments for rent listings studio' },

  // Sports (5)
  { domain: 'espn.com', category: 'Sports', difficulty: 'medium', searchPages: 12, keywords: 'scores nba nfl highlights analysis' },
  { domain: 'nba.com', category: 'Sports', difficulty: 'medium', searchPages: 10, keywords: 'standings players stats schedule news' },
  { domain: 'nfl.com', category: 'Sports', difficulty: 'medium', searchPages: 10, keywords: 'scores standings schedule teams stats' },
  { domain: 'mlb.com', category: 'Sports', difficulty: 'medium', searchPages: 10, keywords: 'scores standings stats news schedule' },
  { domain: 'bleacherreport.com', category: 'Sports', difficulty: 'medium', searchPages: 10, keywords: 'nba nfl rumors analysis trades' },

  // Entertainment (3)
  { domain: 'imdb.com', category: 'Entertainment', difficulty: 'medium', searchPages: 12, keywords: 'top movies 2026 ratings actors TV' },
  { domain: 'rottentomatoes.com', category: 'Entertainment', difficulty: 'medium', searchPages: 10, keywords: 'best movies reviews critics scores' },
  { domain: 'fandom.com', category: 'Entertainment', difficulty: 'easy', searchPages: 12, keywords: 'wiki movies tv shows games anime' },

  // Government (5)
  { domain: 'irs.gov', category: 'Government', difficulty: 'easy', searchPages: 10, keywords: 'tax forms filing refund credits' },
  { domain: 'usa.gov', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'benefits services agencies housing' },
  { domain: 'cdc.gov', category: 'Government', difficulty: 'easy', searchPages: 10, keywords: 'diseases prevention health data vaccines' },
  { domain: 'nasa.gov', category: 'Government', difficulty: 'easy', searchPages: 12, keywords: 'missions mars space exploration images gallery' },
  { domain: 'whitehouse.gov', category: 'Government', difficulty: 'medium', searchPages: 8, keywords: 'briefings administration policies executive' },

  // Reference (3)
  { domain: 'britannica.com', category: 'Reference', difficulty: 'easy', searchPages: 12, keywords: 'encyclopedia history science technology art' },
  { domain: 'dictionary.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'word definitions synonyms grammar' },
  { domain: 'merriam-webster.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'dictionary thesaurus word of the day' },

  // Automotive (4)
  { domain: 'cars.com', category: 'Automotive', difficulty: 'medium', searchPages: 10, keywords: 'used cars for sale reviews comparison' },
  { domain: 'autotrader.com', category: 'Automotive', difficulty: 'medium', searchPages: 8, keywords: 'cars for sale new used trucks SUV' },
  { domain: 'kbb.com', category: 'Automotive', difficulty: 'medium', searchPages: 8, keywords: 'car values pricing reviews best' },
  { domain: 'carvana.com', category: 'Automotive', difficulty: 'hard', searchPages: 8, keywords: 'buy used cars online financing' },

  // Classifieds
  { domain: 'craigslist.org', category: 'Classifieds', difficulty: 'easy', searchPages: 8, keywords: 'for sale furniture electronics housing jobs' },

  // --- Additional domains to reach 1000+ URL target ---

  // News / Media (additional)
  { domain: 'npr.org', category: 'News', difficulty: 'easy', searchPages: 10, keywords: 'news podcast politics science culture music' },
  { domain: 'abcnews.go.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'politics health technology world entertainment' },
  { domain: 'cbsnews.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'news politics health science technology' },
  { domain: 'foxnews.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'politics opinion health science tech' },
  { domain: 'time.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'politics health science technology business' },
  { domain: 'wired.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'science technology gear business culture' },
  { domain: 'arstechnica.com', category: 'News', difficulty: 'easy', searchPages: 10, keywords: 'tech science policy gaming hardware' },
  { domain: 'theatlantic.com', category: 'News', difficulty: 'medium', searchPages: 8, keywords: 'ideas politics culture technology science' },

  // Technology / Developer (additional)
  { domain: 'docs.python.org', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'tutorial library reference functions modules' },
  { domain: 'developer.mozilla.org', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'javascript css html web api reference' },
  { domain: 'rust-lang.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'learn documentation tools community' },
  { domain: 'nodejs.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation api guides download' },
  { domain: 'learn.microsoft.com', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'documentation azure dotnet windows powershell' },
  { domain: 'docs.github.com', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'actions codespaces repositories pull requests' },
  { domain: 'hashicorp.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'terraform vault consul nomad blog' },

  // Education / Reference (additional)
  { domain: 'stanford.edu', category: 'Education', difficulty: 'easy', searchPages: 10, keywords: 'research departments news academics admissions' },
  { domain: 'yale.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research programs news admissions campus' },
  { domain: 'berkeley.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research news campus admissions departments' },
  { domain: 'nature.com', category: 'Reference', difficulty: 'medium', searchPages: 10, keywords: 'articles research biology physics chemistry' },
  { domain: 'sciencedirect.com', category: 'Reference', difficulty: 'medium', searchPages: 8, keywords: 'journal articles research science engineering' },
  { domain: 'arxiv.org', category: 'Reference', difficulty: 'easy', searchPages: 10, keywords: 'papers machine learning AI physics math' },

  // Lifestyle / How-to
  { domain: 'wikihow.com', category: 'Reference', difficulty: 'easy', searchPages: 10, keywords: 'how to guide tips tutorial DIY' },
  { domain: 'instructables.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'projects DIY woodworking electronics crafts' },
  { domain: 'thespruce.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'home garden cooking cleaning organizing' },

  // Business / SaaS
  { domain: 'salesforce.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'products CRM cloud solutions blog' },
  { domain: 'hubspot.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'blog marketing sales CRM tools resources' },
  { domain: 'atlassian.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'jira confluence products agile blog' },
  { domain: 'notion.so', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'templates guides help documentation' },
  { domain: 'slack.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'features solutions resources integrations' },

  // Government / Org (additional)
  { domain: 'who.int', category: 'Government', difficulty: 'easy', searchPages: 10, keywords: 'health diseases publications data news' },
  { domain: 'un.org', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'peace climate development goals news' },
  { domain: 'state.gov', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'travel countries policy diplomacy' },
  { domain: 'sec.gov', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'filings regulations investor education enforcement' },
  { domain: 'energy.gov', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'renewable solar nuclear science research' },

  // Sports (additional)
  { domain: 'cbssports.com', category: 'Sports', difficulty: 'medium', searchPages: 10, keywords: 'scores fantasy nba nfl news picks' },
  { domain: 'sportsillustrated.com', category: 'Sports', difficulty: 'medium', searchPages: 8, keywords: 'nba nfl rankings analysis news' },

  // --- Additional domains to reach 500+ for 10k URL target ---

  // International News
  { domain: 'bbc.co.uk', category: 'News', difficulty: 'medium', searchPages: 12, keywords: 'news sport weather business technology' },
  { domain: 'dw.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'world news europe asia politics culture' },
  { domain: 'aljazeera.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'news middle east world politics economy' },
  { domain: 'france24.com', category: 'News', difficulty: 'medium', searchPages: 8, keywords: 'news europe africa asia americas' },
  { domain: 'japantimes.co.jp', category: 'News', difficulty: 'medium', searchPages: 8, keywords: 'news japan business culture technology' },
  { domain: 'scmp.com', category: 'News', difficulty: 'hard', searchPages: 8, keywords: 'news china asia tech business' },
  { domain: 'thehindu.com', category: 'News', difficulty: 'medium', searchPages: 8, keywords: 'india news politics economy technology' },
  { domain: 'smh.com.au', category: 'News', difficulty: 'medium', searchPages: 8, keywords: 'news australia politics business technology' },
  { domain: 'independent.co.uk', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'news politics uk world science tech' },
  { domain: 'telegraph.co.uk', category: 'News', difficulty: 'hard', searchPages: 8, keywords: 'news world business technology opinion' },
  { domain: 'politico.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'politics policy congress election economy' },
  { domain: 'axios.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'technology business politics economy AI' },
  { domain: 'vox.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'technology culture politics science economy' },
  { domain: 'slate.com', category: 'News', difficulty: 'medium', searchPages: 8, keywords: 'culture politics technology business' },
  { domain: 'businessinsider.com', category: 'News', difficulty: 'hard', searchPages: 10, keywords: 'tech finance economy startup markets' },
  { domain: 'techcrunch.com', category: 'News', difficulty: 'medium', searchPages: 12, keywords: 'startup AI funding tech company venture' },
  { domain: 'theverge.com', category: 'News', difficulty: 'medium', searchPages: 12, keywords: 'tech review gadgets science AI apps' },
  { domain: 'engadget.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'tech gadgets review deals gaming' },
  { domain: 'mashable.com', category: 'News', difficulty: 'medium', searchPages: 8, keywords: 'tech science social media culture' },
  { domain: 'zdnet.com', category: 'News', difficulty: 'medium', searchPages: 10, keywords: 'technology security cloud AI enterprise' },

  // SaaS / Developer Tools
  { domain: 'datadog.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'monitoring infrastructure cloud observability blog' },
  { domain: 'grafana.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'dashboards monitoring observability blog' },
  { domain: 'mongodb.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'database documentation atlas blog' },
  { domain: 'elastic.co', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'elasticsearch search observability security' },
  { domain: 'redis.io', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation commands data structures caching' },
  { domain: 'supabase.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'database auth storage edge functions docs' },
  { domain: 'planetscale.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'database mysql serverless branching blog' },
  { domain: 'fly.io', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'deploy documentation blog apps machines' },
  { domain: 'render.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'deploy services documentation pricing blog' },
  { domain: 'railway.app', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'deploy documentation templates blog' },
  { domain: 'cloudflare.com', category: 'Technology', difficulty: 'hard', searchPages: 10, keywords: 'workers pages r2 zero trust blog' },
  { domain: 'sentry.io', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'error monitoring documentation blog' },
  { domain: 'postman.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'api testing documentation blog' },
  { domain: 'twilio.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'api sms voice messaging documentation' },
  { domain: 'auth0.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'authentication authorization documentation blog' },
  { domain: 'okta.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'identity security authentication workforce' },
  { domain: 'pagerduty.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'incident management automation blog' },
  { domain: 'circleci.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'ci cd pipeline documentation blog' },
  { domain: 'gitlab.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'devops ci cd documentation blog' },
  { domain: 'bitbucket.org', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'git repositories pipelines documentation' },

  // Developer Docs & Package Registries
  { domain: 'pkg.go.dev', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'package documentation standard library modules' },
  { domain: 'crates.io', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'rust crate library package' },
  { domain: 'pypi.org', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'python package library project' },
  { domain: 'npmjs.com', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'javascript package library typescript' },
  { domain: 'rubygems.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'ruby gem library package' },
  { domain: 'hex.pm', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'elixir erlang package library' },
  { domain: 'typescriptlang.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation handbook playground' },
  { domain: 'reactjs.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation tutorial hooks components' },
  { domain: 'vuejs.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'guide documentation api ecosystem' },
  { domain: 'angular.io', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation guide tutorial cli' },
  { domain: 'svelte.dev', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation tutorial examples blog' },
  { domain: 'nextjs.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation app router pages api' },
  { domain: 'tailwindcss.com', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'documentation utility classes components' },
  { domain: 'docs.rs', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'rust documentation crate library' },

  // E-Commerce (additional — Shopify stores, niche retailers)
  { domain: 'rei.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'outdoor gear camping hiking climbing' },
  { domain: 'chewy.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'pet food supplies dog cat' },
  { domain: 'zappos.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 10, keywords: 'shoes boots sneakers sandals' },
  { domain: 'newegg.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'computer parts GPU monitor SSD' },
  { domain: 'bhphotovideo.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'camera lens photography video' },
  { domain: 'ikea.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'furniture storage kitchen bedroom living room' },
  { domain: 'gap.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'clothing jeans sale kids women men' },
  { domain: 'hm.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'clothing fashion sustainability women men' },
  { domain: 'zara.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'clothing women men shoes bags' },
  { domain: 'uniqlo.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'clothing essentials outerwear basics' },
  { domain: 'adidas.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'shoes ultraboost running originals' },
  { domain: 'puma.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'shoes running motorsport training' },
  { domain: 'underarmour.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'shoes apparel running training' },
  { domain: 'lululemon.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'yoga running training women men' },
  { domain: 'williams-sonoma.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'kitchen cookware appliances furniture' },
  { domain: 'crateandbarrel.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'furniture home decor kitchen' },
  { domain: 'potterybarn.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'furniture bedroom living room decor' },
  { domain: 'anthropologie.com', category: 'E-Commerce', difficulty: 'medium', searchPages: 8, keywords: 'clothing home furniture gifts' },
  { domain: 'asos.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 10, keywords: 'clothing shoes accessories sale' },
  { domain: 'shein.com', category: 'E-Commerce', difficulty: 'hard', searchPages: 8, keywords: 'clothing women dresses shoes' },

  // More Government / .edu
  { domain: 'epa.gov', category: 'Government', difficulty: 'easy', searchPages: 10, keywords: 'environment water air regulations climate' },
  { domain: 'fda.gov', category: 'Government', difficulty: 'easy', searchPages: 10, keywords: 'drugs food safety medical devices recalls' },
  { domain: 'census.gov', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'population data demographics statistics' },
  { domain: 'noaa.gov', category: 'Government', difficulty: 'easy', searchPages: 10, keywords: 'weather climate ocean forecasts data' },
  { domain: 'usgs.gov', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'earthquakes volcanoes maps science water' },
  { domain: 'loc.gov', category: 'Government', difficulty: 'easy', searchPages: 10, keywords: 'library collections digital exhibitions' },
  { domain: 'caltech.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research faculty departments campus' },
  { domain: 'columbia.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'programs research campus admissions' },
  { domain: 'princeton.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research departments admissions campus' },
  { domain: 'cornell.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research programs campus admissions' },
  { domain: 'upenn.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research programs schools campus' },
  { domain: 'uchicago.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research programs admissions academics' },
  { domain: 'duke.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research programs admissions campus' },
  { domain: 'northwestern.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research programs schools campus' },
  { domain: 'cmu.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research computer science robotics AI' },
  { domain: 'gatech.edu', category: 'Education', difficulty: 'easy', searchPages: 8, keywords: 'research engineering computing campus' },

  // Entertainment / Media
  { domain: 'variety.com', category: 'Entertainment', difficulty: 'medium', searchPages: 10, keywords: 'movies tv music awards box office' },
  { domain: 'hollywoodreporter.com', category: 'Entertainment', difficulty: 'medium', searchPages: 8, keywords: 'movies tv industry business awards' },
  { domain: 'deadline.com', category: 'Entertainment', difficulty: 'medium', searchPages: 8, keywords: 'movies tv deals casting news' },
  { domain: 'rollingstone.com', category: 'Entertainment', difficulty: 'medium', searchPages: 8, keywords: 'music culture movies tv politics' },
  { domain: 'pitchfork.com', category: 'Entertainment', difficulty: 'medium', searchPages: 8, keywords: 'music reviews albums artists news' },
  { domain: 'gamespot.com', category: 'Entertainment', difficulty: 'medium', searchPages: 10, keywords: 'games reviews news guides' },
  { domain: 'ign.com', category: 'Entertainment', difficulty: 'medium', searchPages: 10, keywords: 'games reviews movies tv guides' },
  { domain: 'polygon.com', category: 'Entertainment', difficulty: 'medium', searchPages: 8, keywords: 'games reviews news culture' },
  { domain: 'kotaku.com', category: 'Entertainment', difficulty: 'medium', searchPages: 8, keywords: 'games culture reviews news' },
  { domain: 'pcgamer.com', category: 'Entertainment', difficulty: 'medium', searchPages: 8, keywords: 'pc gaming hardware reviews news' },

  // Health / Wellness (additional)
  { domain: 'medicalnewstoday.com', category: 'Health', difficulty: 'medium', searchPages: 10, keywords: 'health conditions nutrition wellness drugs' },
  { domain: 'drugs.com', category: 'Health', difficulty: 'medium', searchPages: 10, keywords: 'medications pill identifier interactions dosage' },
  { domain: 'everydayhealth.com', category: 'Health', difficulty: 'medium', searchPages: 8, keywords: 'conditions wellness nutrition diet fitness' },
  { domain: 'verywellhealth.com', category: 'Health', difficulty: 'medium', searchPages: 8, keywords: 'conditions treatments symptoms wellness' },
  { domain: 'psych.org', category: 'Health', difficulty: 'easy', searchPages: 8, keywords: 'psychiatry mental health conditions research' },

  // Finance (additional)
  { domain: 'nerdwallet.com', category: 'Finance', difficulty: 'medium', searchPages: 10, keywords: 'credit cards loans banking investing' },
  { domain: 'investopedia.com', category: 'Finance', difficulty: 'easy', searchPages: 12, keywords: 'investing trading stocks terms definitions' },
  { domain: 'bankrate.com', category: 'Finance', difficulty: 'medium', searchPages: 10, keywords: 'mortgage rates savings loans credit' },
  { domain: 'fool.com', category: 'Finance', difficulty: 'medium', searchPages: 10, keywords: 'investing stocks portfolio retirement' },
  { domain: 'cnbc.com', category: 'Finance', difficulty: 'medium', searchPages: 12, keywords: 'markets economy business investing technology' },
  { domain: 'marketwatch.com', category: 'Finance', difficulty: 'medium', searchPages: 10, keywords: 'stocks markets investing news economy' },
  { domain: 'seekingalpha.com', category: 'Finance', difficulty: 'hard', searchPages: 8, keywords: 'stocks analysis dividends earnings' },
  { domain: 'mint.com', category: 'Finance', difficulty: 'medium', searchPages: 8, keywords: 'budgeting credit score finance tools' },

  // Food / Recipe (additional)
  { domain: 'epicurious.com', category: 'Food', difficulty: 'easy', searchPages: 10, keywords: 'recipes cooking dinner dessert chicken' },
  { domain: 'seriouseats.com', category: 'Food', difficulty: 'easy', searchPages: 10, keywords: 'recipes technique guide equipment science' },
  { domain: 'bonappetit.com', category: 'Food', difficulty: 'medium', searchPages: 10, keywords: 'recipes cooking restaurant culture' },
  { domain: 'tasty.co', category: 'Food', difficulty: 'easy', searchPages: 8, keywords: 'recipes easy quick dinner dessert' },
  { domain: 'simplyrecipes.com', category: 'Food', difficulty: 'easy', searchPages: 8, keywords: 'recipes dinner chicken pasta soup' },

  // Travel (additional)
  { domain: 'vrbo.com', category: 'Travel', difficulty: 'hard', searchPages: 8, keywords: 'vacation rentals beach mountain cabin' },
  { domain: 'hostelworld.com', category: 'Travel', difficulty: 'medium', searchPages: 8, keywords: 'hostels europe asia budget travel' },
  { domain: 'skyscanner.com', category: 'Travel', difficulty: 'hard', searchPages: 8, keywords: 'cheap flights compare airlines hotels' },
  { domain: 'lonelyplanet.com', category: 'Travel', difficulty: 'medium', searchPages: 10, keywords: 'destinations guides tips best places' },
  { domain: 'viator.com', category: 'Travel', difficulty: 'medium', searchPages: 8, keywords: 'tours experiences activities attractions' },

  // Real Estate (additional)
  { domain: 'compass.com', category: 'Real Estate', difficulty: 'hard', searchPages: 8, keywords: 'homes for sale listings luxury' },
  { domain: 'movoto.com', category: 'Real Estate', difficulty: 'medium', searchPages: 8, keywords: 'homes for sale neighborhoods' },
  { domain: 'opendoor.com', category: 'Real Estate', difficulty: 'medium', searchPages: 8, keywords: 'buy sell homes instant offers' },

  // Automotive (additional)
  { domain: 'edmunds.com', category: 'Automotive', difficulty: 'medium', searchPages: 10, keywords: 'car reviews pricing comparison deals' },
  { domain: 'motortrend.com', category: 'Automotive', difficulty: 'medium', searchPages: 8, keywords: 'car reviews news comparisons' },
  { domain: 'caranddriver.com', category: 'Automotive', difficulty: 'medium', searchPages: 8, keywords: 'reviews comparisons news road tests' },
  { domain: 'tesla.com', category: 'Automotive', difficulty: 'hard', searchPages: 8, keywords: 'model s y x cybertruck energy' },

  // Lifestyle / Home / DIY
  { domain: 'bhg.com', category: 'Reference', difficulty: 'easy', searchPages: 10, keywords: 'home garden recipes decorating ideas' },
  { domain: 'hgtv.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'home renovation shows decorating' },
  { domain: 'diy.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'projects home improvement garden' },
  { domain: 'bobvila.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'home improvement repair DIY tips' },

  // Legal / Professional
  { domain: 'law.cornell.edu', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'law legal code constitution supreme court' },
  { domain: 'findlaw.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'legal advice attorney law articles' },
  { domain: 'justia.com', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'law cases statutes regulations' },

  // Nonprofit / International Org
  { domain: 'worldbank.org', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'development data research countries' },
  { domain: 'imf.org', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'economy data reports countries' },
  { domain: 'redcross.org', category: 'Government', difficulty: 'easy', searchPages: 8, keywords: 'disaster relief blood donate' },

  // Misc high-traffic
  { domain: 'quora.com', category: 'Social', difficulty: 'medium', searchPages: 10, keywords: 'questions answers programming technology science' },
  { domain: 'tumblr.com', category: 'Social', difficulty: 'medium', searchPages: 8, keywords: 'blogs art photography culture' },
  { domain: 'wordpress.com', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'blog themes plugins hosting' },
  { domain: 'wix.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'website builder templates design' },
  { domain: 'squarespace.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'website templates design portfolio' },
  { domain: 'medium.com', category: 'Social', difficulty: 'medium', searchPages: 10, keywords: 'technology programming AI startup culture' },
  { domain: 'substack.com', category: 'Social', difficulty: 'medium', searchPages: 8, keywords: 'newsletter writing culture technology' },
  { domain: 'archive.org', category: 'Reference', difficulty: 'easy', searchPages: 10, keywords: 'wayback machine books audio movies' },
  { domain: 'gutenberg.org', category: 'Reference', difficulty: 'easy', searchPages: 8, keywords: 'free books ebooks literature classics' },

  // Weather / Maps
  { domain: 'weather.com', category: 'Reference', difficulty: 'medium', searchPages: 8, keywords: 'forecast radar maps severe alerts' },
  { domain: 'accuweather.com', category: 'Reference', difficulty: 'medium', searchPages: 8, keywords: 'forecast radar hourly daily' },

  // Telecom / ISP
  { domain: 'verizon.com', category: 'Technology', difficulty: 'hard', searchPages: 8, keywords: 'phones plans wireless internet' },
  { domain: 'att.com', category: 'Technology', difficulty: 'hard', searchPages: 8, keywords: 'wireless internet tv plans' },
  { domain: 'tmobile.com', category: 'Technology', difficulty: 'hard', searchPages: 8, keywords: 'phones plans wireless 5g' },

  // Crypto / Web3
  { domain: 'coingecko.com', category: 'Finance', difficulty: 'medium', searchPages: 8, keywords: 'cryptocurrency prices bitcoin ethereum' },
  { domain: 'coinmarketcap.com', category: 'Finance', difficulty: 'medium', searchPages: 8, keywords: 'crypto prices market cap rankings' },
  { domain: 'etherscan.io', category: 'Finance', difficulty: 'medium', searchPages: 8, keywords: 'ethereum transactions blocks addresses' },

  // AI / ML
  { domain: 'huggingface.co', category: 'Technology', difficulty: 'easy', searchPages: 12, keywords: 'models datasets transformers spaces' },
  { domain: 'kaggle.com', category: 'Technology', difficulty: 'medium', searchPages: 10, keywords: 'datasets competitions notebooks models' },
  { domain: 'paperswithcode.com', category: 'Technology', difficulty: 'easy', searchPages: 10, keywords: 'machine learning papers methods benchmarks' },
  { domain: 'anthropic.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'research blog claude safety' },
  { domain: 'deepmind.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'research blog publications AI' },

  // Productivity / Tools
  { domain: 'dropbox.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'features business plans blog' },
  { domain: 'evernote.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'features templates blog organization' },
  { domain: 'todoist.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'features productivity blog tips' },
  { domain: 'asana.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'project management features resources' },
  { domain: 'monday.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'project management CRM features' },
  { domain: 'airtable.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'templates guides blog features' },
  { domain: 'miro.com', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'templates whiteboard collaboration features' },
  { domain: 'linear.app', category: 'Technology', difficulty: 'medium', searchPages: 8, keywords: 'features documentation changelog blog' },

  // Security
  { domain: 'hackernews.com', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'news discussions submissions best' },
  { domain: 'owasp.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'top ten security testing guides' },
  { domain: 'cve.org', category: 'Technology', difficulty: 'easy', searchPages: 8, keywords: 'vulnerabilities database search records' },
];

// -------------------------------------------------------------------
// Spider Search API — discover real interior pages
// -------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

async function discoverPages(domain: string, limit: number, keywords: string): Promise<string[]> {
  // Detect if domain already has a subdomain (e.g. docs.github.com, blog.cloudflare.com)
  // — don't prepend www. to subdomains (www.docs.github.com has no valid SSL cert)
  const parts = domain.split('.');
  const hasSubdomain = parts.length > 2;
  const queries = hasSubdomain
    ? [`site:${domain} ${keywords}`.trim()]
    : [
        `site:${domain} ${keywords}`.trim(),
        `site:www.${domain} ${keywords}`.trim(),
      ];

  for (const query of queries) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch('https://api.spider.cloud/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          search: query,
          search_limit: limit + 3,
          num: limit + 3,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) continue;

      const raw = await resp.json() as { content?: SearchResult[] } | SearchResult[];
      const data: SearchResult[] = Array.isArray(raw) ? raw : (raw?.content ?? []);
      if (data.length === 0) continue;

      // Deduplicate, filter non-HTML URLs, prefer interior pages over root
      const allUrls = [...new Set(data.map((r) => r.url).filter(Boolean))].filter((u) => {
        // Skip PDFs, images, and other non-HTML resources
        try {
          const pathname = new URL(u).pathname.toLowerCase();
          return !/\.(pdf|png|jpg|jpeg|gif|svg|webp|zip|tar|gz|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/.test(pathname);
        } catch { return true; }
      });
      const interior = allUrls.filter((u) => {
        try { const p = new URL(u).pathname; return p !== '/' && p !== ''; } catch { return false; }
      });
      const root = allUrls.filter((u) => !interior.includes(u));
      const sorted = [...interior, ...root];
      if (sorted.length > 0) return sorted.slice(0, limit);
    } catch {
      // Try next query
    }
  }

  return [hasSubdomain ? `https://${domain}` : `https://www.${domain}`];
}

// -------------------------------------------------------------------
// Blocked content detection
// -------------------------------------------------------------------

/**
 * Detect bot-detection / blocked pages from HTML content.
 *
 * Uses a two-phase approach for world-class detection:
 *  1. **Strong signals**: Patterns that are always blocked regardless of page size
 *     (e.g., "verify you are human", "captcha", challenge platform IDs)
 *  2. **Contextual signals**: Keywords that only indicate blocking when the page
 *     is small (< 5-10KB). A real page about "access denied" concepts won't
 *     match because it'll have substantial content.
 *
 * @param html   Raw HTML string
 * @param title  Page title (for cross-checking — a real article about "bots"
 *               will have a descriptive title, not "Access Denied")
 */
function isBlockedContent(html: string, title: string = ''): boolean {
  const h = html.toLowerCase();
  const t = title.toLowerCase();
  const len = html.length;

  // Phase 1: Strong signals — always indicate blocking
  if (h.includes('please verify you are a human')) return true;
  if (h.includes('unusual traffic from your')) return true;
  if (h.includes('challenge-platform')) return true;
  if (h.includes('cf-challenge') && h.includes('cloudflare')) return true;
  if (h.includes('ddos-guard')) return true;
  if (h.includes('show us your human side')) return true;
  if (h.includes("can't tell if you're a human or a bot")) return true;
  if (h.includes('sorry, you have been blocked')) return true;
  if (h.includes('px-captcha')) return true;
  if (h.includes('_cf_chl_opt')) return true;
  if (h.includes('managed_challenge')) return true;
  if (h.includes('datadome') && h.includes('captcha')) return true;
  if (h.includes('verifying the device')) return true;
  if (h.includes('available after verification')) return true;

  // Phase 2: Title-based detection — blocked pages have telltale titles
  if (t === 'just a moment...' || t === 'attention required') return true;
  if (t === 'access denied' || t === 'blocked') return true;
  if (t === 'are you a robot?' || t === 'robot check') return true;
  if (t === 'security check' || t === 'human verification') return true;
  if (t.includes('bot or not')) return true;
  if (t === 'you have been blocked') return true;

  // Phase 3: Contextual signals — only for small pages (real content is bigger)
  if (len < 5000) {
    if (h.includes('captcha')) return true;
    if (h.includes('are you a robot')) return true;
    if (h.includes('bot or not')) return true;
    if (h.includes('just a moment')) return true;
    if (h.includes('one more step')) return true;
    if (h.includes('security check')) return true;
    if (h.includes('verify you are human')) return true;
    if (h.includes('checking your browser')) return true;
    if (h.includes('please turn javascript on')) return true;
    if (h.includes('pardon our interruption')) return true;
    if (h.includes('automated access')) return true;
    if (h.includes('bot protection')) return true;
    if (h.includes('human verification')) return true;
    if (h.includes('powered and protected by')) return true;
    if (h.includes('request could not be processed')) return true;
    if (h.includes('please complete the security check')) return true;
    if (h.includes('browser check')) return true;
    if (h.includes('rate limit exceeded')) return true;
    if (h.includes('too many requests')) return true;
    if (h.includes('blocked') && h.includes('request')) return true;
    if (h.includes('enable javascript') && len < 3000) return true;
    if (h.includes("prove you're not a robot")) return true;
    if (h.includes('suspected automated')) return true;
    if (h.includes('_abck')) return true;
    if (h.includes('ak_bmsc')) return true;
    if (h.includes('please enable cookies')) return true;
  }

  // Phase 4: Medium pages (< 10KB) — compound signals only
  if (len < 10000) {
    if (h.includes('access denied') && !t.includes('article')) return true;
    if (h.includes('access to this page has been denied')) return true;
    if (h.includes('blocked by network security')) return true;
    if (h.includes('ray id') && h.includes('cloudflare')) return true;
    if (h.includes('reference id') && h.includes('could not be processed')) return true;
  }

  return false;
}

/** Detect 404/not-found error pages. */
function is404Content(html: string, title: string): boolean {
  const h = html.toLowerCase();
  const t = title.toLowerCase();
  const len = html.length;
  return (
    (t.includes('404') && len < 10000) ||
    (t.includes('not found') && len < 10000) ||
    (t.includes('page not found') && len < 10000) ||
    (h.includes('404') && h.includes('not found') && len < 5000) ||
    (h.includes('this page doesn') && len < 5000) ||
    (h.includes('page you requested') && h.includes('not found') && len < 10000)
  );
}

/**
 * Extract the registrable base name from a hostname.
 * Handles subdomains: blog.cloudflare.com → "cloudflare", docs.rs → "docs",
 * ads.tiktok.com → "tiktok", amazon.com → "amazon".
 *
 * Strategy: find the matching TEST_DOMAIN for the hostname first (handles
 * subdomains like blog.cloudflare.com → cloudflare.com → "cloudflare").
 * Falls back to second-to-last part for 3+ segment domains.
 */
function extractDomainBase(hostname: string): string {
  const h = hostname.toLowerCase();
  // Match against TEST_DOMAINS (handles subdomains)
  const match = TEST_DOMAINS.find(
    (d) => h === d.domain || h.endsWith('.' + d.domain),
  );
  if (match) {
    const parts = match.domain.split('.');
    return parts[0]!;
  }
  // Fallback: for 3+ part domains (sub.example.com), use second-to-last part
  const parts = h.split('.');
  if (parts.length >= 3) return parts[parts.length - 2]!;
  return parts[0]!;
}

/**
 * Detect cross-session content contamination.
 * When multiple CDP sessions share a Chrome process, content from one session
 * can leak into another. Detect this by checking if the title explicitly
 * mentions a different well-known domain.
 */
// Domain base names that are common English words — these cause false positives
// in contamination detection because they appear naturally in page titles.
const COMMON_WORD_DOMAINS = new Set([
  'cars', 'target', 'medium', 'time', 'monster', 'nature', 'slate',
  'dictionary', 'indeed', 'docs', 'learn', 'developer', 'notion',
  'square', 'linear', 'render', 'fly', 'railway', 'sentry', 'elastic',
  'stripe', 'chase', 'fidelity', 'fortune', 'variety', 'deadline',
  'polygon', 'pitch', 'threads', 'discord', 'snap', 'uber', 'kayak',
  'booking', 'compass', 'redfin', 'trulia', 'overstock', 'gap',
  'canva', 'figma', 'vercel', 'grafana', 'postman', 'auth0',
  'okta', 'datadog', 'supabase', 'redis', 'hex', 'anthropic',
]);

function isContaminatedContent(html: string, title: string, expectedDomain: string): boolean {
  if (!title || title.length < 5) return false;
  const t = title.toLowerCase();

  // Extract the base domain name, handling subdomains correctly
  // e.g. blog.cloudflare.com → "cloudflare", docs.rs → "docs", amazon.com → "amazon"
  const expectedBase = extractDomainBase(expectedDomain);

  // Check for well-known domain names in the title that don't match expected.
  // Only consider distinctive brand names (not common English words) and
  // require whole-word matches to avoid false positives like "learning" matching "learn".
  const domainPatterns = TEST_DOMAINS.map((d) => d.domain.split('.')[0]!.toLowerCase());
  for (const pattern of domainPatterns) {
    if (pattern.length < 5) continue; // Skip short names (ambiguous, e.g. noaa, yelp)
    if (pattern === expectedBase) continue; // Skip the expected domain
    if (COMMON_WORD_DOMAINS.has(pattern)) continue; // Skip common English words
    // Whole-word match only — "amazon" matches "amazon" but not "amazonian"
    const wordRegex = new RegExp(`\\b${pattern}\\b`);
    if (wordRegex.test(t) && !t.includes(expectedBase)) {
      // Double-check: the HTML should also contain the domain URL pattern
      // to confirm it's truly contaminated (not just a coincidental word match)
      const htmlLower = html.toLowerCase();
      if (htmlLower.includes(`${pattern}.com`) || htmlLower.includes(`${pattern}.org`) || htmlLower.includes(`${pattern}.io`)) {
        return true; // Title + HTML both mention another domain
      }
    }
  }
  return false;
}

// No client-side domain tracking — server handles stealth/proxy decisions.

// -------------------------------------------------------------------
// Test runner
// -------------------------------------------------------------------

interface TestResult {
  url: string;
  domain: string;
  category: string;
  difficulty: string;
  pageType: 'landing' | 'interior';
  passed: boolean;
  title: string;
  contentLength: number;
  hasScreenshot: boolean;
  error: string;
  durationMs: number;
  blocked: boolean;
  connectMs: number;
  navigateMs: number;
  contentMs: number;
  screenshotMs: number;
  browserUsed: string;
  /** First ~200 chars of visible text for manual quality verification. */
  contentPreview: string;
  /** Credits used for this page (from metering). */
  creditsUsed: number;
  /** Cost in USD (10,000 credits = $1). */
  costUsd: number;
}

/** Strip HTML tags and collapse whitespace to extract visible text preview. */
function extractTextPreview(html: string, maxLen: number = 200): string {
  // Remove script/style blocks, then strip tags, collapse whitespace
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen);
}

/** Shared abort controller for hedge cancellation — prevents zombie sessions. */
interface HedgeController {
  aborted: boolean;
  browsers: SpiderBrowser[];
}

interface TestPageOpts {
  /** Stealth level: 0=auto (server hedges), 1=basic proxy, 2=residential, 3=enterprise. */
  stealth?: number;
  commandTimeoutMs?: number;
  retryTimeoutMs?: number;
  contentMinChars?: number;
  /** Use polling-based content extraction (for timeout retries where SPAs never fire load). */
  usePolling?: boolean;
  /** Use fast navigation (gotoFast) — skips full load wait, best for SPAs that never fire loadEventFired. */
  useFastNav?: boolean;
  /** Browser backend hint — server routes to this backend. Use 'chrome-h' for reliability. */
  browser?: 'chrome' | 'chrome-new' | 'chrome-h' | 'firefox' | 'lightpanda' | 'auto';
  /** Mark as hedge session — bypasses per-user session limits on server. */
  hedge?: boolean;
  /** Override smartRetry maxRetries (default 1). Set to 0 for single-shot attempts. */
  maxRetries?: number;
  /** Use DOMContentLoaded navigation + network idle content detection. Best for heavy SPAs. */
  useDomNav?: boolean;
  /** Extended interstitial wait budget in ms (default 16000, use 30000 for retries). */
  interstitialBudgetMs?: number;
}

async function testPage(
  url: string,
  config: DomainConfig,
  pageType: 'landing' | 'interior',
  hedgeCtrl?: HedgeController,
  timeoutMs: number = PAGE_TIMEOUT_MS,
  opts?: TestPageOpts,
): Promise<TestResult> {
  const start = Date.now();
  const minChars = opts?.contentMinChars ?? 200;
  const result: TestResult = {
    url,
    domain: config.domain,
    category: config.category,
    difficulty: config.difficulty,
    pageType,
    passed: false,
    title: '',
    contentLength: 0,
    hasScreenshot: false,
    error: '',
    durationMs: 0,
    blocked: false,
    connectMs: 0,
    navigateMs: 0,
    contentMs: 0,
    screenshotMs: 0,
    browserUsed: opts?.browser || 'unknown',
    contentPreview: '',
    creditsUsed: 0,
    costUsd: 0,
  };

  // Init with retries — handles 429 rate limits and connection failures.
  // 429 from server means this proxy/session slot is full — backoff and retry.
  // 3 attempts gives 429s enough time to clear (proxies rotate on each attempt).
  const MAX_INIT_RETRIES = 3;
  // Simplified client: fixed stealth levels (no per-domain tracking).
  // stealth≥1 disables server-side hedge (which has session conflict bugs).
  // chrome-h for reliability (server auto-routes to unreliable backends).
  // maxRetries=2: inner library retry recovers transient WS disconnects.
  // The library may rotate browsers on retry (servo/lightpanda/firefox)
  // which occasionally fails, but the WS recovery value outweighs that.
  const browserOpts = {
    apiKey: API_KEY!,
    url,
    smartRetry: true,
    maxRetries: opts?.maxRetries ?? 2,
    stealth: opts?.stealth ?? 1,
    connectTimeoutMs: CLI_CONNECT_TIMEOUT,
    commandTimeoutMs: opts?.commandTimeoutMs ?? CLI_COMMAND_TIMEOUT,
    retryTimeoutMs: opts?.retryTimeoutMs ?? 10000,
    logLevel: 'error' as const,
    ...(opts?.browser ? { browser: opts.browser } : {}),
    ...(opts?.hedge ? { hedge: true } : {}),
  };
  let browser = new SpiderBrowser(browserOpts);
  if (hedgeCtrl) hedgeCtrl.browsers.push(browser);

  try {
    if (hedgeCtrl?.aborted) throw new Error('Aborted by hedge controller');

    const t0 = Date.now();
    for (let attempt = 0; attempt < MAX_INIT_RETRIES; attempt++) {
      try {
        if (hedgeCtrl?.aborted) throw new Error('Aborted by hedge controller');
        await browser.init();
        break;
      } catch (initErr) {
        if (hedgeCtrl?.aborted) throw new Error('Aborted by hedge controller');
        if (attempt >= MAX_INIT_RETRIES - 1) throw initErr;
        await browser.close().catch(() => {});
        // 429 = server rate limit → longer backoff. Other errors → shorter backoff.
        // Server picks new proxy/browser on reconnect — no client-side rotation needed.
        const is429 = initErr instanceof Error && initErr.message.includes('429');
        const backoffMs = is429
          ? 3000 + 2000 * attempt + Math.floor(Math.random() * 2000)
          : 1000 * (attempt + 1);
        await sleep(backoffMs);
        browser = new SpiderBrowser(browserOpts);
        if (hedgeCtrl) hedgeCtrl.browsers.push(browser);
      }
    }
    result.connectMs = Date.now() - t0;

    // Per-attempt timeout: each retry attempt gets its own budget (not shared).
    // This ensures Firefox/Phase 2 browsers get a real chance even if Chrome
    // burned most of the page timeout. The outer testPageWithHedge hard timeout
    // still caps total wall time.
    const perAttemptBudgetMs = Math.min(timeoutMs, 60_000);

    // Track remaining budget — when tight on time, switch to fast-nav to save 10-18s.
    const data = await browser.withRetry(async () => {
      // Check if hedge/timeout has resolved — abort to free server resources
      if (hedgeCtrl?.aborted) throw new Error('Aborted by hedge controller');

      // Per-attempt deadline: each attempt gets its own fair time slice.
      const attemptDeadline = Date.now() + perAttemptBudgetMs;

      // Use fast-nav when: explicitly requested, or remaining budget is tight (<35s).
      // Standard nav burns 18s on SPAs; if we don't have budget, fast-nav saves time.
      const budgetLeft = perAttemptBudgetMs;
      const useFast = opts?.useFastNav || budgetLeft < 35_000;
      const useDom = opts?.useDomNav;
      const useEarlyReturn = opts?.usePolling || budgetLeft < 35_000;
      const interstitialBudget = opts?.interstitialBudgetMs ?? 30000;

      const tNav = Date.now();
      if (useDom) {
        await browser.page.gotoDom(url);
      } else if (useFast) {
        await browser.page.gotoFast(url);
      } else {
        await browser.page.goto(url);
      }
      const navMs = Date.now() - tNav;

      const tContent = Date.now();
      const title = (await browser.page.title()) ?? '';
      // Recalculate budget after navigation — nav can take 5-25s.
      const contentBudget = attemptDeadline - Date.now();
      if (contentBudget < 3000) {
        throw new TimeoutError(`Attempt budget exhausted after navigation`);
      }
      // Strategy selection:
      // 1. useEarlyReturn → contentWithEarlyReturn (simple polling, budget-tight)
      // 2. default → contentWithNetworkIdle (PerformanceObserver + MutationObserver idle
      //    detection with configurable interstitial budget — handles SPAs, interstitials,
      //    and infinite-loading pages better than plain content())
      let html: string;
      if (useEarlyReturn) {
        // When budget is tight, use polling-based extraction capped by remaining budget.
        // Poll interval 1s for faster detection; max wait = min(10s, remaining budget - 5s safety).
        html = await browser.page.contentWithEarlyReturn(
          Math.min(10000, Math.max(3000, contentBudget - 3000)),
          Math.max(minChars, 500),
          1000,
        );
      } else {
        html = await browser.page.contentWithNetworkIdle(
          Math.min(20000, Math.max(5000, contentBudget - 3000)),
          Math.max(minChars, 500),
          Math.min(interstitialBudget, contentBudget - 5000),
        );
      }
      const contentMs = Date.now() - tContent;

      if (!html || html.length < minChars) {
        // Insufficient content is usually a session/timing issue, not bot detection.
        // Use a regular Error so retry engine classifies as transient+disconnection → reconnect.
        throw new Error(`Page has insufficient content (< ${minChars} chars)`);
      }
      if (isBlockedContent(html, title)) {
        throw new BlockedError('Bot detection triggered');
      }

      // Content contamination detection — shared Chrome sessions can leak
      // content from other sessions. Check that the page content plausibly
      // belongs to the requested or actual (redirected) domain.
      // Use the browser's actual URL after navigation — legitimate redirects
      // (e.g., mint.com → intuit.com) are NOT contamination.
      const actualUrl = await browser.page.url().catch(() => url);
      const actualDomain = new URL(actualUrl || url).hostname.replace(/^www\./, '');
      const requestedDomain = new URL(url).hostname.replace(/^www\./, '');
      // Only flag contamination if title doesn't match EITHER domain
      if (isContaminatedContent(html, title, actualDomain) && isContaminatedContent(html, title, requestedDomain)) {
        throw new Error(`Content contamination: got "${title}" (expected ${requestedDomain}, actual ${actualDomain})`);
      }

      return { title, html, navMs, contentMs };
    });

    result.title = data.title || '';
    result.contentLength = data.html.length;
    result.contentPreview = extractTextPreview(data.html);
    result.navigateMs = data.navMs;
    result.contentMs = data.contentMs;
    result.browserUsed = browser.browser;

    // Filter out 404 pages — don't count as passed
    if (is404Content(data.html, data.title)) {
      result.error = '404: page not found';
      result.passed = false;
    } else {
      // Screenshot (best-effort, outside retry)
      try {
        const tShot = Date.now();
        const screenshotB64 = await browser.page.screenshot();
        result.screenshotMs = Date.now() - tShot;
        result.hasScreenshot = screenshotB64.length > 100;
      } catch {}

      result.passed = true;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errLower = errMsg.toLowerCase();

    // SSL/DNS errors with www. subdomain — retry without www.
    // e.g. www.docs.github.com → docs.github.com (invalid cert on www. prefix)
    if ((errLower.includes('err_ssl') || errLower.includes('err_cert') || errLower.includes('err_name_not_resolved')) && url.includes('://www.')) {
      await browser.close().catch(() => {});
      const altUrl = url.replace('://www.', '://');
      try {
        browser = new SpiderBrowser({ ...browserOpts, url: altUrl });
        await browser.init();
        const data = await browser.withRetry(async () => {
          await browser.page.goto(altUrl);
          const title = (await browser.page.title()) ?? '';
          const html = (await browser.page.content(CONTENT_WAIT_MS, 500)) ?? '';
          if (!html || html.length < minChars) throw new Error(`Page has insufficient content (< ${minChars} chars)`);
          if (isBlockedContent(html, title)) throw new BlockedError('Bot detection triggered');
          return { title, html };
        });
        result.url = altUrl;
        result.title = data.title || '';
        result.contentLength = data.html.length;
        result.contentPreview = extractTextPreview(data.html);
        result.browserUsed = browser.browser;
        if (is404Content(data.html, data.title)) {
          result.error = '404: page not found';
        } else {
          result.passed = true;
        }
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        result.error = retryMsg;
        result.blocked = retryErr instanceof BlockedError ||
          retryMsg.toLowerCase().includes('blocked') ||
          retryMsg.toLowerCase().includes('bot detection');
        result.browserUsed = browser.browser;
      }
    } else {
      result.error = errMsg;
      result.blocked = err instanceof BlockedError ||
        errLower.includes('blocked') ||
        errLower.includes('bot detection');
      result.browserUsed = browser.browser;
    }
  } finally {
    // Request exact session cost from the server (synchronous CDP request/response).
    // Unlike the passive sessionCreditsUsed getter (which relies on async event delivery),
    // this explicitly asks the server and waits for the response.
    const sessionCredits = await browser.getSessionCredits().catch(() => 0);
    if (sessionCredits > 0) {
      result.creditsUsed = Math.round(sessionCredits * 10000) / 10000;
      result.costUsd = result.creditsUsed / 10000;
    }
    await browser.close().catch(() => {});
  }

  result.durationMs = Date.now() - start;
  return result;
}

/**
 * Wrapper around testPage with a hard per-page timeout.
 *
 * The retry engine already handles smart retries (stealth escalation,
 * browser switching, reconnects) — we just need to cap total duration
 * to prevent retry storms from running for minutes.
 *
 * Uses HedgeController for clean abort: when timeout fires, all browsers
 * are immediately closed and the abort flag prevents new retry attempts.
 *
 * With concurrency 30 + HedgeController abort, the parallel attempt is safe:
 * the losing attempt's browser is immediately closed (no zombie sessions).
 */
/**
 * Progressive hedged execution — each wave uses a different stealth/proxy tier.
 *
 * Waves are spaced by HEDGE_DELAY_MS. Each wave creates a new session with
 * a different stealth level (= different proxy tier + browser profile).
 * First success wins — all other attempts are immediately cancelled.
 *
 * Timeline (HEDGE_DELAY_MS=3s):
 *   t=0s:   Wave 0 — primary (stealth 0→3, normal escalation via retry engine)
 *   t=3s:   Wave 1 — hedge (stealth 2, chrome-h, different TLS/IP fingerprint)
 *   t=6s:   Wave 2 — hedge (stealth 3, polling mode, enterprise proxy)
 *   t=9s:   Wave 3 — hedge (stealth 3, firefox, completely different fingerprint)
 *
 * For retry passes (timeout ≤ 60s): single attempt only (no hedging).
 * For short retries (timeout ≤ 45s): single attempt, short timeout.
 *
 * 429 from server is expected — it means this proxy/session is rate-limited.
 * The hedge on a DIFFERENT stealth level uses a different proxy, bypassing it.
 */
async function testPageWithHedge(
  url: string,
  config: DomainConfig,
  pageType: 'landing' | 'interior',
  timeoutMs: number = PAGE_TIMEOUT_MS,
  opts?: TestPageOpts,
  hedgeOpts?: TestPageOpts,
): Promise<TestResult> {
  const ctrl: HedgeController = { aborted: false, browsers: [] };

  const timeoutResult: TestResult = {
    url, domain: config.domain, category: config.category, difficulty: config.difficulty,
    pageType, passed: false, title: '', contentLength: 0, hasScreenshot: false,
    error: `page timeout (${timeoutMs / 1000}s total)`, durationMs: timeoutMs,
    blocked: false, connectMs: 0, navigateMs: 0, contentMs: 0, screenshotMs: 0,
    browserUsed: opts?.browser || 'unknown', contentPreview: '', creditsUsed: 0, costUsd: 0,
  };

  // Fast mode or no hedgeOpts: single attempt only
  if (CLI_FAST_MODE || !hedgeOpts) {
    return Promise.race([
      testPage(url, config, pageType, ctrl, timeoutMs, opts),
      new Promise<TestResult>((resolve) => setTimeout(() => {
        ctrl.aborted = true;
        for (const b of ctrl.browsers) b.close().catch(() => {});
        resolve(timeoutResult);
      }, timeoutMs + 5_000)),
    ]);
  }

  // 2 hedge waves: primary + hedge with different browser/proxy for diversity.
  // Used in both pass 1 and retry phase when hedgeOpts is provided.
  // Hedge wave starts after HEDGE_DELAY_MS — doesn't double load if primary succeeds fast.
  // Hedge uses `hedge: true` — server skips per-user session limits for these.
  const waves: { delayMs: number; waveOpts: TestPageOpts | undefined }[] = [
    // Wave 0: primary (immediate) — server picks backend
    { delayMs: 0, waveOpts: opts },
    // Wave 1: +HEDGE_DELAY_MS — hedgeOpts browser for fingerprint diversity
    { delayMs: HEDGE_DELAY_MS, waveOpts: hedgeOpts },
  ];

  return new Promise<TestResult>((resolve) => {
    let resolved = false;
    let firstFailure: TestResult | null = null;
    let pending = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = (result: TestResult) => {
      if (resolved) return;
      if (result.passed) {
        resolved = true;
        ctrl.aborted = true;
        for (const t of timers) clearTimeout(t);
        for (const b of ctrl.browsers) b.close().catch(() => {});
        resolve(result);
        return;
      }
      if (!firstFailure) firstFailure = result;
      pending--;
      if (pending <= 0) {
        resolved = true;
        ctrl.aborted = true;
        for (const t of timers) clearTimeout(t);
        for (const b of ctrl.browsers) b.close().catch(() => {});
        resolve(firstFailure!);
      }
    };

    // Launch waves with staggered delays + micro-jitter.
    // Jitter prevents concurrent tests from firing hedge waves at the exact same instant,
    // which can cause thundering-herd spikes on the server.
    for (const wave of waves) {
      const jitter = Math.random() * 200; // 0-200ms jitter
      if (wave.delayMs === 0) {
        pending++;
        testPage(url, config, pageType, ctrl, timeoutMs, wave.waveOpts).then(finish);
      } else {
        timers.push(setTimeout(() => {
          if (resolved) return;
          pending++;
          testPage(url, config, pageType, ctrl, timeoutMs, wave.waveOpts).then(finish);
        }, wave.delayMs + jitter));
      }
    }

    // Hard timeout — cancel everything
    timers.push(setTimeout(() => {
      if (resolved) return;
      resolved = true;
      ctrl.aborted = true;
      for (const t of timers) clearTimeout(t);
      for (const b of ctrl.browsers) b.close().catch(() => {});
      resolve(firstFailure ?? timeoutResult);
    }, timeoutMs + 5_000));
  });
}

function writeCSV(results: TestResult[], outputPath: string): void {
  const headers = [
    'url', 'domain', 'category', 'difficulty', 'page_type', 'browser_used',
    'passed', 'blocked', 'title', 'content_length', 'has_screenshot',
    'content_preview', 'error', 'duration_ms', 'connect_ms', 'navigate_ms', 'content_ms', 'screenshot_ms',
    'credits_used', 'cost_usd',
  ];
  const rows = results.map((r) => [
    `"${r.url}"`,
    r.domain,
    r.category,
    r.difficulty,
    r.pageType,
    r.browserUsed,
    r.passed ? 'true' : 'false',
    r.blocked ? 'true' : 'false',
    `"${r.title.replace(/"/g, '""')}"`,
    r.contentLength.toString(),
    r.hasScreenshot ? 'true' : 'false',
    `"${r.contentPreview.replace(/"/g, '""')}"`,
    `"${r.error.replace(/"/g, '""')}"`,
    r.durationMs.toString(),
    r.connectMs.toString(),
    r.navigateMs.toString(),
    r.contentMs.toString(),
    r.screenshotMs.toString(),
    r.creditsUsed.toString(),
    r.costUsd.toFixed(4),
  ]);

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  fs.writeFileSync(outputPath, csv, 'utf-8');
}

/** Write the test domain dataset to a CSV file. */
function writeDatasetCSV(domains: DomainConfig[], outputPath: string): void {
  const headers = ['domain', 'category', 'difficulty', 'search_pages', 'keywords'];
  const rows = domains.map((d) => [
    d.domain,
    d.category,
    d.difficulty,
    d.searchPages.toString(),
    `"${d.keywords}"`,
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  fs.writeFileSync(outputPath, csv, 'utf-8');
}

/** Write individual test URLs to a CSV file for the dataset repo. */
function writeUrlsCSV(results: TestResult[], outputPath: string): void {
  const headers = [
    'url', 'domain', 'category', 'difficulty', 'page_type',
    'passed', 'browser_used', 'content_length', 'title', 'content_preview', 'duration_ms',
  ];
  const rows = results.map((r) => [
    `"${r.url}"`,
    r.domain,
    r.category,
    r.difficulty,
    r.pageType,
    r.passed ? 'true' : 'false',
    r.browserUsed,
    r.contentLength.toString(),
    `"${r.title.replace(/"/g, '""')}"`,
    `"${r.contentPreview.replace(/"/g, '""')}"`,
    r.durationMs.toString(),
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  fs.writeFileSync(outputPath, csv, 'utf-8');
}

// -------------------------------------------------------------------
// URL cache — skip /search on subsequent runs
// -------------------------------------------------------------------

const URL_CACHE_PATH = path.resolve(process.cwd(), 'stealth-urls.json');

type UrlCache = Record<string, string[]>;

function loadUrlCache(): UrlCache {
  try {
    if (fs.existsSync(URL_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(URL_CACHE_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveUrlCache(cache: UrlCache): void {
  fs.writeFileSync(URL_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

/** Strip tracking/referral query params that trigger anti-bot systems.
 * Many search-discovered URLs include srsltid, gaa_*, utm_* params
 * that mark the request as coming from a search referral — sites use
 * these to gate content behind paywalls or trigger bot detection. */
function cleanTrackingParams(url: string): string {
  try {
    // Decode HTML entities first (&amp; → &, etc.) — search-discovered URLs
    // often have HTML-encoded ampersands that break query parameter parsing.
    let cleaned = url
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    const u = new URL(cleaned);
    const trackingPrefixes = ['srsltid', 'gaa_', 'utm_', 'fbclid', 'gclid', 'msclkid',
      'amp;gaa_', 'amp%3Bgaa_', 'amp;utm_', 'amp%3Butm_', 'amp%3B'];
    const toDelete: string[] = [];
    for (const key of u.searchParams.keys()) {
      if (trackingPrefixes.some((p) => key.startsWith(p))) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) u.searchParams.delete(key);
    // Also strip trailing ? if all params were removed
    let result = u.toString();
    if (result.endsWith('?')) result = result.slice(0, -1);
    return result;
  } catch {
    return url;
  }
}

// Concurrency controls
const SEARCH_CONCURRENCY = 20;   // Parallel search API calls
const TEST_CONCURRENCY = CLI_CONCURRENCY;  // Parallel browser sessions

/** Run promises with limited concurrency. */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/** Async queue for streaming retries — pass 1 pushes failures, retry workers pull them. */
class AsyncRetryQueue<T> {
  private items: T[] = [];
  private waiters: ((item: T | null) => void)[] = [];
  private closed = false;

  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  async pop(): Promise<T | null> {
    const item = this.items.shift();
    if (item) return item;
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => this.waiters.push(resolve));
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters) waiter(null);
    this.waiters.length = 0;
  }

  get pending() { return this.items.length; }
}

// -------------------------------------------------------------------
// --retry-csv mode: re-run failed URLs from a previous CSV, patch in-place
// -------------------------------------------------------------------
async function retryFailedFromCsv(csvPath: string): Promise<void> {
  const absPath = path.resolve(process.cwd(), csvPath);
  if (!fs.existsSync(absPath)) {
    console.error(`retry-csv file not found: ${absPath}`);
    process.exit(1);
  }

  // Parse the CSV
  const raw = fs.readFileSync(absPath, 'utf-8');
  const lines = raw.split('\n');
  const header = lines[0]!;
  const rows = lines.slice(1).filter((l) => l.trim());

  // Parse each row back into a result-like object with its original line index
  interface CsvRow {
    lineIdx: number;    // index into the `rows` array
    url: string;
    domain: string;
    category: string;
    difficulty: string;
    pageType: 'landing' | 'interior';
    passed: boolean;
    line: string;       // original CSV line
  }

  const allRows: CsvRow[] = rows.map((line, i) => {
    // Parse CSV respecting quoted fields
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"' && !inQuotes) { inQuotes = true; continue; }
      if (line[c] === '"' && inQuotes) {
        if (line[c + 1] === '"') { current += '"'; c++; continue; }
        inQuotes = false; continue;
      }
      if (line[c] === ',' && !inQuotes) { fields.push(current); current = ''; continue; }
      current += line[c];
    }
    fields.push(current);

    return {
      lineIdx: i,
      url: fields[0] ?? '',
      domain: fields[1] ?? '',
      category: fields[2] ?? '',
      difficulty: fields[3] ?? '',
      pageType: (fields[4] ?? 'interior') as 'landing' | 'interior',
      passed: fields[6] === 'true',
      line,
    };
  });

  const failed = allRows.filter((r) => !r.passed);
  const totalBefore = allRows.filter((r) => r.passed).length;

  console.log(`spider-browser Retry Failed URLs`);
  console.log(`================================`);
  console.log(`CSV: ${absPath}`);
  console.log(`Total rows: ${allRows.length} | Passed: ${totalBefore} | Failed: ${failed.length}`);
  console.log(`Timeouts: page=${PAGE_TIMEOUT_MS}ms hedge=${HEDGE_DELAY_MS}ms retry=${RETRY_TIMEOUT_MS}ms`);
  console.log('');

  if (failed.length === 0) {
    console.log('No failed URLs to retry!');
    return;
  }

  // Build test targets from failed rows (clean URLs — decode HTML entities like &amp;)
  const testTargets = failed.map((r) => ({
    url: cleanTrackingParams(r.url),
    config: TEST_DOMAINS.find((d) => d.domain === r.domain) ?? {
      domain: r.domain, category: r.category, difficulty: r.difficulty as 'easy' | 'medium' | 'hard',
      searchPages: 1, keywords: '',
    },
    pageType: r.pageType,
  }));

  const results: (TestResult | null)[] = new Array(failed.length).fill(null);
  let fixed = 0;
  const startTime = Date.now();

  // Pass 1: standard hedge with extended interstitial budget (retrying known-hard URLs)
  console.log(`Pass 1: Testing ${failed.length} failed URLs (${Math.min(TEST_CONCURRENCY, failed.length)} concurrent)\n`);
  await runWithConcurrency(testTargets, Math.min(TEST_CONCURRENCY, failed.length), async (target, idx) => {
    const result = await testPageWithHedge(
      target.url, target.config, target.pageType,
      PAGE_TIMEOUT_MS,
      { stealth: 1, hedge: true, interstitialBudgetMs: 45000 },
      { stealth: 2, hedge: true, useFastNav: true, usePolling: true },
    );
    results[idx] = result;
    if (result.passed) fixed++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const status = result.passed ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
    console.log(`[${idx + 1}/${failed.length} ${elapsed}s] ${status} ${result.durationMs / 1000 | 0}s ${target.url.slice(0, 70)}`);
  });

  console.log(`\nPass 1: ${fixed}/${failed.length} recovered`);

  // Pass 2: retry remaining failures with escalated stealth
  const stillFailed = results
    .map((r, i) => ({ result: r!, idx: i, target: testTargets[i]! }))
    .filter(({ result }) => result && !result.passed);

  if (stillFailed.length > 0) {
    console.log(`\nPass 2: Retrying ${stillFailed.length} remaining with enterprise proxy (chrome-h)...\n`);
    await runWithConcurrency(stillFailed, Math.min(RETRY_CONCURRENCY, stillFailed.length), async ({ idx, target }) => {
      const result = await testPageWithHedge(
        target.url, target.config, target.pageType,
        RETRY_TIMEOUT_MS,
        { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 2, browser: 'chrome-h', interstitialBudgetMs: 20000 },
        { stealth: 3, commandTimeoutMs: 45000, hedge: true, useFastNav: true, usePolling: true, maxRetries: 2, browser: 'chrome-new' },
      );
      if (result.passed) {
        fixed++;
        results[idx] = result;
      }
      const status = result.passed ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
      console.log(`  ${status} ${target.url.slice(0, 80)}`);
    });

    console.log(`\nPass 2: total recovered ${fixed}/${failed.length}`);
  }

  // Pass 3: Firefox with stealth=3 — real browser + best proxies.
  // Firefox is 100% real (not headless), uses BiDi protocol, and has a completely
  // different TLS/browser fingerprint than Chrome. Sites that fingerprint Chrome
  // headless or detect CDP often pass Firefox without issue.
  const stillFailed2 = results
    .map((r, i) => ({ result: r!, idx: i, target: testTargets[i]! }))
    .filter(({ result }) => result && !result.passed);

  if (stillFailed2.length > 0) {
    console.log(`\nPass 3: Retrying ${stillFailed2.length} remaining with Firefox + enterprise proxy...\n`);
    await runWithConcurrency(stillFailed2, Math.min(RETRY_CONCURRENCY, stillFailed2.length), async ({ idx, target }) => {
      const result = await testPageWithHedge(
        target.url, target.config, target.pageType,
        RETRY_TIMEOUT_MS,
        { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 1, browser: 'firefox', interstitialBudgetMs: 20000 },
      );
      if (result.passed) {
        fixed++;
        results[idx] = result;
      }
      const status = result.passed ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
      console.log(`  ${status} ${target.url.slice(0, 80)}`);
    });

    console.log(`\nPass 3: total recovered ${fixed}/${failed.length}`);
  }

  // Pass 4: Servo — lightweight engine, different fingerprint entirely.
  const stillFailed3 = results
    .map((r, i) => ({ result: r!, idx: i, target: testTargets[i]! }))
    .filter(({ result }) => result && !result.passed);

  if (stillFailed3.length > 0) {
    console.log(`\nPass 4: Retrying ${stillFailed3.length} remaining with Servo + enterprise proxy...\n`);
    await runWithConcurrency(stillFailed3, Math.min(RETRY_CONCURRENCY, stillFailed3.length), async ({ idx, target }) => {
      const result = await testPageWithHedge(
        target.url, target.config, target.pageType,
        RETRY_TIMEOUT_MS,
        { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 1, browser: 'servo' as any, interstitialBudgetMs: 20000 },
      );
      if (result.passed) {
        fixed++;
        results[idx] = result;
      }
      const status = result.passed ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
      console.log(`  ${status} ${target.url.slice(0, 80)}`);
    });

    console.log(`\nPass 4: total recovered ${fixed}/${failed.length}`);
  }

  // Pass 5: LightPanda — minimal browser, unique fingerprint.
  const stillFailed4 = results
    .map((r, i) => ({ result: r!, idx: i, target: testTargets[i]! }))
    .filter(({ result }) => result && !result.passed);

  if (stillFailed4.length > 0) {
    console.log(`\nPass 5: Retrying ${stillFailed4.length} remaining with LightPanda + enterprise proxy...\n`);
    await runWithConcurrency(stillFailed4, Math.min(RETRY_CONCURRENCY, stillFailed4.length), async ({ idx, target }) => {
      const result = await testPageWithHedge(
        target.url, target.config, target.pageType,
        RETRY_TIMEOUT_MS,
        { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 1, browser: 'lightpanda', interstitialBudgetMs: 20000 },
      );
      if (result.passed) {
        fixed++;
        results[idx] = result;
      }
      const status = result.passed ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
      console.log(`  ${status} ${target.url.slice(0, 80)}`);
    });

    console.log(`\nPass 5: total recovered ${fixed}/${failed.length}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  // Patch the CSV: replace failed rows that now pass
  const updatedLines = [header];
  let patched = 0;
  for (const row of allRows) {
    const failedIdx = failed.findIndex((f) => f.lineIdx === row.lineIdx);
    if (failedIdx !== -1 && results[failedIdx]?.passed) {
      // This failed row now passes — write the new result
      const r = results[failedIdx]!;
      updatedLines.push([
        `"${r.url}"`, r.domain, r.category, r.difficulty, r.pageType, r.browserUsed,
        'true', 'false',
        `"${r.title.replace(/"/g, '""')}"`, r.contentLength.toString(),
        r.hasScreenshot ? 'true' : 'false',
        `"${r.contentPreview.replace(/"/g, '""')}"`, `"${r.error.replace(/"/g, '""')}"`,
        r.durationMs.toString(), r.connectMs.toString(), r.navigateMs.toString(),
        r.contentMs.toString(), r.screenshotMs.toString(),
        r.creditsUsed.toString(), r.costUsd.toFixed(4),
      ].join(','));
      patched++;
    } else {
      updatedLines.push(row.line);
    }
  }

  fs.writeFileSync(absPath, updatedLines.join('\n'), 'utf-8');

  const totalAfter = totalBefore + patched;
  console.log(`\n================================`);
  console.log(`Patched ${patched}/${failed.length} failed rows → now ${totalAfter}/${allRows.length} passed (${((totalAfter / allRows.length) * 100).toFixed(1)}%)`);
  console.log(`CSV updated in-place: ${absPath}`);
  console.log(`Completed in ${elapsed}s`);
}

async function main() {
  // --retry-csv mode: re-run only failed URLs from a previous CSV, patch in-place
  if (RETRY_CSV) {
    return retryFailedFromCsv(RETRY_CSV);
  }

  console.log('spider-browser Stealth & Reliability Test v19');
  console.log('=============================================');
  console.log(`Target: ${TARGET_URLS} URLs | Concurrency: ${SEARCH_CONCURRENCY} search / ${TEST_CONCURRENCY} test`);
  console.log(`Timeouts: connect=${CLI_CONNECT_TIMEOUT}ms command=${CLI_COMMAND_TIMEOUT}ms retries=${CLI_MAX_RETRIES} page=${PAGE_TIMEOUT_MS}ms hedge=${HEDGE_DELAY_MS}ms retry=${RETRY_TIMEOUT_MS}ms content-wait=${CONTENT_WAIT_MS}ms`);
  if (CLI_FAST_MODE) console.log('FAST MODE: no hedging, no retry, no smart-retry');
  console.log('');

  // Load cached URLs from previous runs, cleaning tracking params
  const urlCache = loadUrlCache();
  // Clean tracking params from cached URLs (one-time migration)
  let cacheModified = false;
  for (const domain of Object.keys(urlCache)) {
    const cleaned = urlCache[domain].map(cleanTrackingParams);
    // Deduplicate after cleaning (tracking params may have been the only difference)
    const unique = [...new Set(cleaned)];
    if (unique.length !== urlCache[domain].length || unique.some((u, i) => u !== urlCache[domain][i])) {
      urlCache[domain] = unique;
      cacheModified = true;
    }
  }
  if (cacheModified) saveUrlCache(urlCache);
  const cacheHits = Object.keys(urlCache).length;

  interface TestTarget {
    url: string;
    config: DomainConfig;
    pageType: 'landing' | 'interior';
  }

  const targets: TestTarget[] = [];

  // Fast path: if cache covers all domains, skip API discovery entirely
  const uncachedDomains = TEST_DOMAINS.filter((d) => !urlCache[d.domain] || urlCache[d.domain].length === 0);

  if (uncachedDomains.length === 0) {
    // All domains cached — build targets instantly
    console.log(`Loaded ${cacheHits} cached domains (${Object.values(urlCache).reduce((s, u) => s + u.length, 0)} URLs) — skipping API discovery\n`);
    for (const config of TEST_DOMAINS) {
      const pages = urlCache[config.domain].filter((u: string) => {
        try {
          const pathname = new URL(u).pathname.toLowerCase();
          return !/\.(pdf|png|jpg|jpeg|gif|svg|webp|zip|tar|gz|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/.test(pathname);
        } catch { return true; }
      }).slice(0, config.searchPages);
      for (const rawUrl of pages) {
        const cleanUrl = cleanTrackingParams(rawUrl);
        const pageType = cleanUrl === `https://www.${config.domain}` || cleanUrl === `https://${config.domain}` ? 'landing' : 'interior';
        targets.push({ url: cleanUrl, config, pageType });
      }
    }
  } else {
    // Some domains need discovery
    if (cacheHits > 0) console.log(`Loaded ${cacheHits} cached domains, discovering ${uncachedDomains.length} more...`);
    console.log('Phase 1: Discovering interior pages via Spider Search API...\n');

    let discoveredCount = 0;

    await runWithConcurrency(TEST_DOMAINS, SEARCH_CONCURRENCY, async (config) => {
      let pages: string[];
      if (urlCache[config.domain] && urlCache[config.domain].length > 0) {
        pages = urlCache[config.domain].filter((u: string) => {
          try {
            const pathname = new URL(u).pathname.toLowerCase();
            return !/\.(pdf|png|jpg|jpeg|gif|svg|webp|zip|tar|gz|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/.test(pathname);
          } catch { return true; }
        }).slice(0, config.searchPages);
      } else {
        pages = await discoverPages(config.domain, config.searchPages, config.keywords);
        urlCache[config.domain] = pages;
      }

      for (const rawUrl of pages) {
        const cleanUrl = cleanTrackingParams(rawUrl);
        const pageType = cleanUrl === `https://www.${config.domain}` || cleanUrl === `https://${config.domain}` ? 'landing' : 'interior';
        targets.push({ url: cleanUrl, config, pageType });
      }

      discoveredCount++;
      // Only log uncached domains to reduce noise
      if (!urlCache[config.domain] || urlCache[config.domain].length === 0) {
        console.log(`  [${discoveredCount}/${TEST_DOMAINS.length}] ${config.domain.padEnd(30)} ${pages.length} pages`);
      }

      if (discoveredCount % 20 === 0) saveUrlCache(urlCache);
    });

    saveUrlCache(urlCache);
  }

  const interiorCount = targets.filter((t) => t.pageType === 'interior').length;
  const landingCount = targets.filter((t) => t.pageType === 'landing').length;
  console.log(`${targets.length} total pages (${interiorCount} interior, ${landingCount} landing)`);
  console.log(`Target: ${TARGET_URLS} | Available: ${targets.length} (${targets.length >= TARGET_URLS ? 'MET' : `${TARGET_URLS - targets.length} short`})`);

  // Only expand if we're actually short AND have uncached domains to expand
  if (targets.length < TARGET_URLS && uncachedDomains.length > 0) {
    const deficit = TARGET_URLS - targets.length;
    const avgExtra = Math.ceil(deficit / TEST_DOMAINS.length);
    console.log(`\nPhase 1b: Expanding search for ${deficit} more URLs (avg +${avgExtra} per domain)...`);

    const expandable = TEST_DOMAINS.filter((d) => {
      const cached = urlCache[d.domain] ?? [];
      return cached.length < d.searchPages + avgExtra + 5;
    });

    await runWithConcurrency(expandable.slice(0, Math.min(100, expandable.length)), SEARCH_CONCURRENCY, async (config) => {
      const newLimit = config.searchPages + avgExtra + 5;
      const existing = new Set((urlCache[config.domain] ?? []).map((u: string) => u));
      const pages = await discoverPages(config.domain, newLimit, config.keywords);
      const newPages = pages.filter((u: string) => !existing.has(u));
      if (newPages.length > 0) {
        urlCache[config.domain] = [...(urlCache[config.domain] ?? []), ...newPages];
        for (const url of newPages) {
          targets.push({ url, config, pageType: 'interior' });
        }
      }
    });

    saveUrlCache(urlCache);
    console.log(`After expansion: ${targets.length} total pages`);
  }

  // Shuffle targets to interleave domains — prevents cluster failures when
  // all URLs from one domain hit the server simultaneously
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j]!, targets[i]!];
  }

  // Cap targets to TARGET_URLS
  const testTargets = targets.slice(0, TARGET_URLS);
  if (testTargets.length < targets.length) {
    console.log(`\nCapped to ${testTargets.length} URLs (discovered ${targets.length})`);
  }

  console.log(`\nPhase 2: Testing ${testTargets.length} pages (${TEST_CONCURRENCY} concurrent)${CLI_FAST_MODE ? ' [FAST MODE]' : ''}\n`);

  // Check credit balance before tests
  const creditsBefore = await checkCredits();
  if (creditsBefore !== undefined) {
    console.log(`Credits before: ${creditsBefore.toLocaleString()} ($${(creditsBefore / 10000).toFixed(2)} USD)`);
  }

  // Phase 2: Test pages concurrently (first pass — moderate concurrency)
  let completedCount = 0;
  const startTime = Date.now();

  function logResult(result: TestResult, target: TestTarget, count: number, total: number, phase: string) {
    const icon = result.passed ? '✓' : '✗';
    const status = result.passed ? 'PASS' : 'FAIL';
    const time = `${(result.durationMs / 1000).toFixed(1)}s`;
    const typeTag = target.pageType === 'interior' ? ' [INT]' : '';
    const browserTag = ` [${result.browserUsed}]`;
    const urlDisplay = target.url.length > 55 ? target.url.slice(0, 52) + '...' : target.url;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    // Show timing breakdown for failures to identify bottleneck
    const timingInfo = !result.passed && result.connectMs > 0
      ? ` c=${(result.connectMs / 1000).toFixed(1)}s n=${(result.navigateMs / 1000).toFixed(1)}s`
      : '';
    const extra = result.error
      ? ` (${result.error.slice(0, 60)}${timingInfo})`
      : result.blocked
        ? ' (blocked)'
        : '';
    console.log(`${phase}[${count}/${total} ${elapsed}s] ${target.config.category.padEnd(14)} ${urlDisplay.padEnd(56)} ${icon} ${status} ${time}${typeTag}${browserTag}${extra}`);
  }

  // Errors that should never be retried
  const nonRetryableErrors = [
    '404:', 'err_ssl_', 'net::err_cert_',
  ];

  // Failure-type-aware retry strategies — use the right tool for each failure type.
  // BLOCKED: escalate to stealth=3 (enterprise proxy) — WAF rejected the request
  // TIMEOUT: stealth=2 + fast-nav/polling — proxy quality isn't the issue, SPA rendering is
  // WS_ERR:  stealth=2, just reconnect — transient server/connection issue
  type FailureType = 'blocked' | 'timeout' | 'ws_error' | 'unknown';

  function classifyFailure(result: TestResult): FailureType {
    const err = result.error.toLowerCase();
    if (result.blocked || err.includes('bot detection') || err.includes('interstitial')) return 'blocked';
    if (err.includes('websocket') || err.includes('ws_err') || err.includes('not connected')) return 'ws_error';
    if (err.includes('timeout')) return 'timeout';
    return 'unknown';
  }

  const RETRY_STRATEGIES: Record<FailureType, TestPageOpts[]> = {
    blocked: [
      // 1st: chrome-h + enterprise proxy + 20s interstitial (if it doesn't resolve in 20s, it won't)
      { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 2, browser: 'chrome-h', interstitialBudgetMs: 20000 },
      // 2nd: chrome-new + enterprise + fast-nav (minimal footprint may bypass fingerprinting)
      { stealth: 3, commandTimeoutMs: 40000, hedge: true, useFastNav: true, usePolling: true, maxRetries: 2, browser: 'chrome-new' },
      // 3rd: Firefox — 100% real browser, completely different TLS/engine fingerprint
      { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 1, browser: 'firefox', interstitialBudgetMs: 20000 },
    ],
    timeout: [
      // 1st: chrome-h + DOM nav (returns on DOMContentLoaded, faster for SPAs)
      { stealth: 2, commandTimeoutMs: 35000, hedge: true, useDomNav: true, maxRetries: 2, browser: 'chrome-h' },
      // 2nd: chrome-new + fast-nav + polling (SPAs that never fire loadEventFired)
      { stealth: 3, commandTimeoutMs: 35000, hedge: true, useFastNav: true, usePolling: true, maxRetries: 2, browser: 'chrome-new' },
      // 3rd: Firefox — different engine, may handle SPA load events differently
      { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 1, browser: 'firefox', interstitialBudgetMs: 20000 },
    ],
    ws_error: [
      // Transient — just reconnect with same config
      { stealth: 2, commandTimeoutMs: 35000, hedge: true, maxRetries: 3 },
      // 2nd attempt: different stealth level forces different proxy/connection
      { stealth: 1, commandTimeoutMs: 35000, hedge: true, maxRetries: 3 },
    ],
    unknown: [
      // 1st: chrome-h + DOM nav + network idle (smart content detection)
      { stealth: 2, commandTimeoutMs: 35000, hedge: true, useDomNav: true, maxRetries: 2, browser: 'chrome-h' },
      // 2nd: fast-nav + polling
      { stealth: 3, commandTimeoutMs: 35000, hedge: true, useFastNav: true, usePolling: true, maxRetries: 2, browser: 'chrome-new' },
      // 3rd: Firefox as last resort
      { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 1, browser: 'firefox', interstitialBudgetMs: 20000 },
    ],
  };

  // Streaming retries — start retrying failures DURING pass 1, not after.
  // This overlaps retry work with the tail of pass 1, saving 60-80s total time.
  // Pass 1 uses auto/cheap proxy; retries use chrome-h with premium proxy.
  const retryQueue = new AsyncRetryQueue<{ target: TestTarget; resultIdx: number }>();
  let retryCount = 0;
  let retryFixed = 0;
  let retryTotal = 0;

  // Pre-allocate results array so retry workers can update it concurrently
  const results: TestResult[] = new Array(testTargets.length);

  // Launch retry workers — they block on queue.pop() until items arrive or queue closes
  const retryWorkersDone = !CLI_FAST_MODE ? (async () => {
    const workers: Promise<void>[] = [];
    for (let w = 0; w < RETRY_CONCURRENCY; w++) {
      workers.push((async () => {
        // Stagger retry worker startup
        await sleep(200 + Math.floor(Math.random() * 800));
        while (true) {
          const item = await retryQueue.pop();
          if (!item) break; // Queue closed

          const { target, resultIdx } = item;
          // Smart retry: classify failure type → pick the right strategy
          const failureType = classifyFailure(results[resultIdx]!);
          const profiles = RETRY_STRATEGIES[failureType];

          // First attempt: race primary vs hedge (if 2+ profiles)
          let attemptResult = await testPageWithHedge(
            target.url, target.config, target.pageType,
            RETRY_TIMEOUT_MS,
            profiles[0],
            profiles.length > 1 ? profiles[1] : undefined,
          );

          // If first attempt failed and there are more profiles, try again
          if (!attemptResult.passed && profiles.length > 2) {
            attemptResult = await testPageWithHedge(
              target.url, target.config, target.pageType,
              RETRY_TIMEOUT_MS,
              profiles[2],
            );
          }

          retryCount++;
          if (attemptResult.passed) {
            retryFixed++;
            results[resultIdx] = attemptResult;
          }
          logResult(attemptResult.passed ? attemptResult : results[resultIdx]!, target, retryCount, retryTotal, 'R');
        }
      })());
    }
    await Promise.all(workers);
  })() : Promise.resolve();

  await runWithConcurrency(testTargets, TEST_CONCURRENCY, async (target, i) => {
    // Stagger startup to avoid thundering herd on server
    if (i < TEST_CONCURRENCY) {
      await sleep(Math.floor(Math.random() * 2000));
    }

    // Pass 1: standard nav (stealth=1) vs fast-nav (stealth=2) hedge.
    // Primary: standard goto (best for SSR pages that fire loadEventFired).
    // Hedge: fast goto + polling (best for SPAs that never fire load events).
    // First to succeed wins — covers both page types in parallel.
    // Let server decide browser routing.
    const result = await testPageWithHedge(
      target.url, target.config, target.pageType,
      PAGE_TIMEOUT_MS,
      { stealth: 1, hedge: true },
      { stealth: 2, hedge: true, useFastNav: true, usePolling: true },
    );

    completedCount++;
    logResult(result, target, completedCount, testTargets.length, '');

    // Write to pre-allocated results array (retry workers also update this)
    results[i] = result;

    // Streaming retry: push failures to retry queue immediately (don't wait for pass 1 to finish)
    if (!result.passed && !CLI_FAST_MODE) {
      const errLower = result.error.toLowerCase();
      if (!nonRetryableErrors.some((re) => errLower.includes(re))) {
        retryTotal++;
        retryQueue.push({ target, resultIdx: i });
      }
    }

    return result;
  });

  const pass1Elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const pass1Passed = results.filter((r) => r.passed).length;
  const pass1Failed = results.filter((r) => !r.passed).length;
  console.log(`\nPass 1 completed in ${pass1Elapsed}s: ${pass1Passed}/${results.length} passed, ${pass1Failed} failed`);
  console.log(`Streaming retries: ${retryCount}/${retryTotal} processed so far (${retryFixed} fixed)`);

  // Close the retry queue — no more items will be pushed. Workers drain remaining items.
  retryQueue.close();
  await retryWorkersDone;

  if (retryTotal > 0) {
    const retryElapsed = ((Date.now() - startTime) / 1000 - parseInt(pass1Elapsed)).toFixed(0);
    console.log(`\nRetries completed in ${retryElapsed}s after pass 1: fixed ${retryFixed}/${retryTotal} failures`);
  }

  // Last-resort retry wave — give remaining failures one final shot with maximum budget.
  // This catches transient failures that cleared up during the run (server load, proxy rotation).
  const stillFailed = results
    .map((r, i) => ({ result: r, idx: i, target: testTargets[i]! }))
    .filter(({ result }) => !result.passed && !nonRetryableErrors.some((re) => result.error.toLowerCase().includes(re)));

  if (stillFailed.length > 0 && !CLI_FAST_MODE) {
    console.log(`\nLast-resort wave: retrying ${stillFailed.length} remaining failures (chrome-h + chrome-new)...`);
    let lastResortFixed = 0;

    await runWithConcurrency(stillFailed, Math.min(RETRY_CONCURRENCY, stillFailed.length), async ({ result, idx, target }) => {
      // Maximum budget: enterprise proxy, reduced interstitial (20s — if it doesn't resolve, it won't).
      // Explicit browser hints: chrome-h (primary) and chrome-new (hedge).
      const lastResult = await testPageWithHedge(
        target.url, target.config, target.pageType,
        RETRY_TIMEOUT_MS,
        { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 2, browser: 'chrome-h', interstitialBudgetMs: 20000 },
        { stealth: 3, commandTimeoutMs: 45000, hedge: true, useFastNav: true, usePolling: true, maxRetries: 2, browser: 'chrome-new' },
      );
      if (lastResult.passed) {
        lastResortFixed++;
        results[idx] = lastResult;
      }
      logResult(lastResult.passed ? lastResult : results[idx]!, target, lastResortFixed, stillFailed.length, 'L');
    });

    console.log(`Last-resort chrome wave: fixed ${lastResortFixed}/${stillFailed.length} failures`);

    // Firefox wave — real browser + best proxies. Different TLS/engine fingerprint.
    const stillFailed2 = results
      .map((r, i) => ({ result: r, idx: i, target: testTargets[i]! }))
      .filter(({ result }) => !result.passed && !nonRetryableErrors.some((re) => result.error.toLowerCase().includes(re)));

    if (stillFailed2.length > 0) {
      console.log(`\nFirefox wave: retrying ${stillFailed2.length} remaining failures...`);
      let firefoxFixed = 0;

      await runWithConcurrency(stillFailed2, Math.min(RETRY_CONCURRENCY, stillFailed2.length), async ({ idx, target }) => {
        const ffResult = await testPageWithHedge(
          target.url, target.config, target.pageType,
          RETRY_TIMEOUT_MS,
          { stealth: 3, commandTimeoutMs: 45000, hedge: true, maxRetries: 1, browser: 'firefox', interstitialBudgetMs: 20000 },
        );
        if (ffResult.passed) {
          firefoxFixed++;
          lastResortFixed++;
          results[idx] = ffResult;
        }
        logResult(ffResult.passed ? ffResult : results[idx]!, target, firefoxFixed, stillFailed2.length, 'FF');
      });

      console.log(`Firefox wave: fixed ${firefoxFixed}/${stillFailed2.length} failures`);
    }

    console.log(`Last-resort total: fixed ${lastResortFixed}/${stillFailed.length} failures`);
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nTotal completed in ${totalElapsed}s`);

  // Check credit balance after tests
  const creditsAfter = await checkCredits();
  let totalCreditsUsed = 0;
  let totalCostUsd = 0;
  if (creditsBefore !== undefined && creditsAfter !== undefined) {
    totalCreditsUsed = Math.max(0, creditsBefore - creditsAfter);
    totalCostUsd = totalCreditsUsed / 10000; // 10k credits = $1
    console.log(`Credits after:  ${creditsAfter.toLocaleString()} ($${(creditsAfter / 10000).toFixed(2)} USD)`);
    console.log(`Credits used:   ${totalCreditsUsed.toLocaleString()} ($${totalCostUsd.toFixed(4)} USD)`);
    console.log(`Cost per page:  $${(totalCostUsd / results.length).toFixed(6)} USD`);

  }

  // -------------------------------------------------------------------
  // Write CSV
  // -------------------------------------------------------------------
  // Timestamped filenames so each run is preserved (never overwritten).
  const runTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dateOnly = runTs.slice(0, 10);
  const outputPath = path.resolve(process.cwd(), `stealth-results-${runTs}.csv`);
  writeCSV(results, outputPath);

  // Store the dataset configuration (per-run)
  const datasetPath = path.resolve(process.cwd(), `stealth-dataset-${runTs}.csv`);
  writeDatasetCSV(TEST_DOMAINS, datasetPath);

  // Store individual URLs (per-run)
  const urlsCsvPath = path.resolve(process.cwd(), `stealth-urls-${runTs}.csv`);
  writeUrlsCSV(results, urlsCsvPath);

  // -------------------------------------------------------------------
  // Compute summary stats (needed by dataset repo + summary output)
  // -------------------------------------------------------------------
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);
  const blocked = results.filter((r) => r.blocked);
  const skipped: TestResult[] = [];

  // Also write to the dataset repo if it exists, and push to GitHub
  const datasetRepoPath = '/Users/jeffreymendez/Code/OSS/spider-browser-dataset';
  if (fs.existsSync(datasetRepoPath)) {
    writeDatasetCSV(TEST_DOMAINS, path.join(datasetRepoPath, 'domains.csv'));
    writeUrlsCSV(results, path.join(datasetRepoPath, 'urls.csv'));
    writeCSV(results, path.join(datasetRepoPath, `results-${runTs}.csv`));

    // Write summary stats as JSON for programmatic access
    const summary = {
      timestamp: runTs,
      total: results.length,
      passed: passed.length,
      failed: failed.length,
      blocked: blocked.length,
      skipped: skipped.length,
      successRate: ((passed.length / results.length) * 100).toFixed(1),
      domains: TEST_DOMAINS.length,
      elapsedSeconds: parseInt(totalElapsed),
      concurrency: TEST_CONCURRENCY,
      creditsUsed: totalCreditsUsed,
      costUsd: totalCostUsd,
      costPerPage: totalCostUsd / results.length,
    };
    fs.writeFileSync(
      path.join(datasetRepoPath, 'latest-summary.json'),
      JSON.stringify(summary, null, 2),
      'utf-8',
    );

    // Auto-push to GitHub
    try {
      const { execSync } = await import('node:child_process');
      const commitMsg = `results: ${runTs} — ${passed.length}/${results.length} passed (${summary.successRate}%)`;
      execSync('git add -A', { cwd: datasetRepoPath, stdio: 'pipe' });
      execSync(`git commit -m "${commitMsg}"`, { cwd: datasetRepoPath, stdio: 'pipe' });
      execSync('git push origin main', { cwd: datasetRepoPath, stdio: 'pipe' });
      console.log(`Dataset pushed to https://github.com/spider-rs/spider-browser-dataset`);
    } catch (e) {
      console.warn('Failed to push dataset to GitHub:', e instanceof Error ? e.message : e);
    }
  }

  console.log(`\nResults saved to: ${outputPath}`);
  console.log(`Dataset saved to: ${datasetPath}`);
  console.log(`URLs CSV saved to: ${urlsCsvPath}`);

  console.log('\n=============================================');
  console.log('RESULTS SUMMARY\n');

  console.log(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length} | Blocked: ${blocked.length} | Skipped: ${skipped.length}`);
  console.log(`Success Rate: ${((passed.length / results.length) * 100).toFixed(1)}%`);
  if (totalCreditsUsed > 0) {
    const testedCount = results.length;
    const metered = results.filter((r) => r.creditsUsed > 0);
    console.log('');
    console.log('--- Metering ---');
    console.log(`  Total credits:  ${totalCreditsUsed.toLocaleString()} ($${totalCostUsd.toFixed(4)} USD)`);
    console.log(`  Avg per page:   ${(totalCreditsUsed / testedCount).toFixed(2)} credits ($${(totalCostUsd / testedCount).toFixed(6)} USD)`);
    if (metered.length > 0) {
      const minC = Math.min(...metered.map((r) => r.creditsUsed));
      const maxC = Math.max(...metered.map((r) => r.creditsUsed));
      const avgC = metered.reduce((s, r) => s + r.creditsUsed, 0) / metered.length;
      console.log(`  Per-page range: ${minC.toFixed(2)} — ${maxC.toFixed(2)} credits (avg ${avgC.toFixed(2)}, ${metered.length}/${testedCount} metered)`);
    }
    console.log(`  Pages tested:   ${testedCount} (${skipped.length} skipped)`);
  }
  console.log('');

  // By page type
  const interiorResults = results.filter((r) => r.pageType === 'interior');
  const landingResults = results.filter((r) => r.pageType === 'landing');
  console.log('By Page Type:');
  if (interiorResults.length > 0) {
    const ip = interiorResults.filter((r) => r.passed).length;
    console.log(`  Interior       ${ip}/${interiorResults.length} (${((ip / interiorResults.length) * 100).toFixed(0)}%)`);
  }
  if (landingResults.length > 0) {
    const lp = landingResults.filter((r) => r.passed).length;
    console.log(`  Landing        ${lp}/${landingResults.length} (${((lp / landingResults.length) * 100).toFixed(0)}%)`);
  }

  // By category
  const categories = [...new Set(results.map((r) => r.category))];
  console.log('\nBy Category:');
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catPassed = catResults.filter((r) => r.passed);
    console.log(
      `  ${cat.padEnd(16)} ${catPassed.length}/${catResults.length} ` +
      `(${((catPassed.length / catResults.length) * 100).toFixed(0)}%)`,
    );
  }

  // By browser used (shows how many needed fallback)
  const browsers = [...new Set(results.map((r) => r.browserUsed))];
  if (browsers.length > 1 || browsers[0] !== 'chrome') {
    console.log('\nBy Browser Used:');
    for (const b of browsers) {
      const bResults = results.filter((r) => r.browserUsed === b);
      const bPassed = bResults.filter((r) => r.passed);
      console.log(
        `  ${b.padEnd(16)} ${bPassed.length}/${bResults.length} ` +
        `(${((bPassed.length / bResults.length) * 100).toFixed(0)}%)`,
      );
    }
  }

  // Speed stats (passed only)
  if (passed.length > 0) {
    console.log('\nSpeed (passed pages):');
    const avgConnect = passed.reduce((s, r) => s + r.connectMs, 0) / passed.length;
    const avgNav = passed.reduce((s, r) => s + r.navigateMs, 0) / passed.length;
    const avgContent = passed.reduce((s, r) => s + r.contentMs, 0) / passed.length;
    const avgShot = passed.reduce((s, r) => s + r.screenshotMs, 0) / passed.length;
    const avgTotal = passed.reduce((s, r) => s + r.durationMs, 0) / passed.length;
    console.log(`  Avg connect:    ${avgConnect.toFixed(0)}ms`);
    console.log(`  Avg navigate:   ${avgNav.toFixed(0)}ms`);
    console.log(`  Avg content:    ${avgContent.toFixed(0)}ms`);
    console.log(`  Avg screenshot: ${avgShot.toFixed(0)}ms`);
    console.log(`  Avg total:      ${(avgTotal / 1000).toFixed(1)}s`);
  }

  // Failure classification summary
  if (failed.length > 0) {
    const classify = (r: TestResult) => {
      const e = r.error.toLowerCase();
      if (r.blocked || e.includes('bot detection') || e.includes('blocked')) return 'BLOCKED';
      if (e.includes('page timeout') || e.includes('timeout exceeded')) return 'TIMEOUT';
      if (e.includes('cdp command timeout') || e.includes('setdiscovertargets')) return 'CDP_ERR';
      if (e.includes('insufficient content')) return 'THIN';
      if (e.includes('websocket') || e.includes('ws ')) return 'WS_ERR';
      if (e.includes('connection') || e.includes('net::err_')) return 'NET_ERR';
      return 'OTHER';
    };
    const failCounts: Record<string, number> = {};
    for (const r of failed) {
      const cls = classify(r);
      failCounts[cls] = (failCounts[cls] || 0) + 1;
    }
    console.log('\nFailure Breakdown:');
    for (const [cls, count] of Object.entries(failCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cls.padEnd(10)} ${count}`);
    }

    console.log('\nFailed Pages:');
    for (const r of failed) {
      const typeTag = classify(r);
      const reason = r.error ? r.error.slice(0, 70) : 'No content';
      console.log(`  [${typeTag.padEnd(7)}] [${r.browserUsed}] ${r.url.padEnd(55)} ${reason}`);
    }
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

/** Quick credit balance check — connects briefly to get x-sc header. */
async function checkCredits(): Promise<number | undefined> {
  try {
    const browser = new SpiderBrowser({
      apiKey: API_KEY!,
      connectTimeoutMs: 10000,
      commandTimeoutMs: 10000,
      smartRetry: false,
      logLevel: 'error',
    });
    let credits: number | undefined;
    browser.on('metering', (data) => {
      credits = data.credits;
    });
    await browser.init();
    await browser.close().catch(() => {});
    return credits;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Stealth test runner failed:', err);
  process.exit(1);
});
