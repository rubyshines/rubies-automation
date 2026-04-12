const https = require('https');
const http = require('http');
const { URL } = require('url');

// Social media / marketplace domains — not scrapable, skip as "no website"
const SKIP_DOMAINS = [
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com',
  'yelp.com', 'google.com', 'maps.google.com',
  'pinterest.com', 'tiktok.com', 'linkedin.com', 'youtube.com',
];

// Block detection patterns indicating Cloudflare / captcha walls
const BLOCK_PATTERNS = [
  'enable javascript',
  'please verify you are human',
  'access denied',
  'checking your browser',
  'cf-browser-verification',
  'challenge-form',
  'ddos-guard',
  'ray id',
  'just a moment',
];

// Subpages worth scraping for additional context
const SUBPAGE_PATHS = ['/about', '/about-us', '/contact', '/contact-us', '/shop', '/collections', '/wholesale', '/pages/about', '/pages/contact'];

const MAX_CONTENT_CHARS = 15000;

// Rate limiting state
const lastFetchByDomain = new Map();

// Shared Puppeteer browser instance
let puppeteerBrowser = null;
let puppeteerUsageCount = 0;
const PUPPETEER_RECYCLE_AFTER = 10;

// Serialize Puppeteer calls — one at a time across parallel workers
let _puppeteerLock = Promise.resolve();
function withPuppeteerLock(fn) {
  const next = _puppeteerLock.then(fn).catch(fn); // always advance the chain
  _puppeteerLock = next.then(() => {}, () => {});
  return next;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitDelay(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  const last = lastFetchByDomain.get(hostname);
  const now = Date.now();
  if (last) {
    const elapsed = now - last;
    const delay = 1000; // 1s between requests to same domain
    if (elapsed < delay) {
      await sleep(delay - elapsed);
    }
  }
  lastFetchByDomain.set(hostname, Date.now());
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 15000,
    };

    const req = lib.request(options, (res) => {
      // Follow redirects (up to 5 hops)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        resolve({ redirect: redirectUrl, statusCode: res.statusCode });
        return;
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        // Stop accumulating if we have enough
        if (data.length > 500000) res.destroy();
      });
      res.on('end', () => resolve({ html: data, statusCode: res.statusCode }));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithRedirects(url, maxRedirects = 5) {
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const result = await fetchPage(current);
    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    return { html: result.html, statusCode: result.statusCode, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

async function puppeteerFetch(url) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error('puppeteer not installed — run: npm install puppeteer');
  }

  // Recycle browser every N pages to avoid memory leaks
  if (puppeteerBrowser && puppeteerUsageCount >= PUPPETEER_RECYCLE_AFTER) {
    await puppeteerBrowser.close().catch(() => {});
    puppeteerBrowser = null;
    puppeteerUsageCount = 0;
  }

  if (!puppeteerBrowser) {
    puppeteerBrowser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }

  const page = await puppeteerBrowser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Brief wait for JS hydration
    await sleep(2000);
    const html = await page.content();
    puppeteerUsageCount++;
    return { html, statusCode: 200, method: 'puppeteer' };
  } finally {
    await page.close().catch(() => {});
  }
}

async function closePuppeteer() {
  if (puppeteerBrowser) {
    await puppeteerBrowser.close().catch(() => {});
    puppeteerBrowser = null;
    puppeteerUsageCount = 0;
  }
}

function isBlocked(html) {
  if (!html) return true;
  const lower = html.toLowerCase();
  return BLOCK_PATTERNS.some((p) => lower.includes(p));
}

function isUsableContent(html) {
  if (!html || html.length < 200) return false;
  if (isBlocked(html)) return false;
  const text = extractText(html);
  return text.length >= 500;
}

function extractText(html) {
  if (!html) return '';

  let text = html
    // Remove script and style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Preserve line breaks for block elements
    .replace(/<\/?(p|div|h[1-6]|li|section|article|header|footer|nav|br)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.slice(0, MAX_CONTENT_CHARS);
}

function findSubpageLinks(html, baseUrl) {
  if (!html) return [];
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const found = new Set();
  const linkRegex = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    try {
      const resolved = new URL(href, baseUrl);
      // Only follow same-domain internal links
      if (resolved.hostname !== base.hostname) continue;
      const path = resolved.pathname.toLowerCase();
      if (SUBPAGE_PATHS.some((sp) => path === sp || path.startsWith(sp + '/'))) {
        found.add(resolved.pathname);
      }
    } catch {
      // skip malformed URLs
    }
  }

  return [...found].slice(0, 5); // cap at 5 subpages
}

async function scrapeUrl(url, verbose = false) {
  await rateLimitDelay(url);

  if (verbose) process.stdout.write(`  → Simple fetch: `);

  let html, method;

  try {
    const httpTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('HTTP fetch timed out (20s)')), 20000)
    );
    const result = await Promise.race([fetchWithRedirects(url), httpTimeout]);
    html = result.html;

    if (isUsableContent(html)) {
      method = 'simple';
      if (verbose) console.log(`SUCCESS (${result.statusCode}, ${html.length.toLocaleString()} chars)`);
    } else {
      const reason = isBlocked(html) ? 'blocked/captcha' : 'insufficient content';
      if (verbose) console.log(`FAILED (${reason}), trying Puppeteer...`);
      html = null;
    }
  } catch (err) {
    if (verbose) console.log(`ERROR (${err.message}), trying Puppeteer...`);
    html = null;
  }

  // Stage 2: Puppeteer fallback (serialized + hard 45s ceiling)
  if (!html) {
    await rateLimitDelay(url);
    if (verbose) process.stdout.write(`  → Puppeteer: `);
    try {
      const result = await withPuppeteerLock(async () => {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Puppeteer timed out (45s)')), 45000)
        );
        return Promise.race([puppeteerFetch(url), timeout]);
      });
      html = result.html;
      method = 'puppeteer';
      if (verbose) console.log(`SUCCESS (${html.length.toLocaleString()} chars)`);
    } catch (err) {
      if (verbose) console.log(`FAILED (${err.message})`);
      return { html: null, method: 'failed', error: err.message };
    }
  }

  return { html, method };
}

async function scrapeProspect(websiteUrl, verbose = false) {
  // Skip social media / non-scrapable domains
  try {
    const hostname = new URL(websiteUrl).hostname.replace(/^www\./, '');
    if (SKIP_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))) {
      if (verbose) console.log(`[SCRAPE] Skipping — social media / non-scrapable domain (${hostname})`);
      return { content: '', rawHtmlByPage: {}, pagesScraped: 0, method: 'skipped', error: `Social media URL: ${hostname}` };
    }
  } catch { /* malformed URL, let it fail naturally */ }

  const rawHtmlByPage = {};
  let totalText = '';

  if (verbose) console.log(`[SCRAPE] Fetching homepage...`);
  const homepage = await scrapeUrl(websiteUrl, verbose);

  if (!homepage.html) {
    return {
      content: '',
      rawHtmlByPage: {},
      pagesScraped: 0,
      method: 'failed',
      error: homepage.error || 'Could not fetch homepage',
    };
  }

  rawHtmlByPage[websiteUrl] = homepage.html;
  const homepageText = extractText(homepage.html);
  totalText += homepageText;

  // Discover and fetch subpages
  const subpageLinks = findSubpageLinks(homepage.html, websiteUrl);
  if (verbose && subpageLinks.length > 0) {
    console.log(`  → Found subpage links: ${subpageLinks.join(', ')}`);
  }

  const scrapeStart = Date.now();
  const SCRAPE_BUDGET_MS = 25000; // total cap across all subpages

  for (const path of subpageLinks) {
    if (Date.now() - scrapeStart > SCRAPE_BUDGET_MS) {
      if (verbose) console.log(`[SCRAPE] Time budget exceeded — stopping subpage fetch`);
      break;
    }

    let subUrl;
    try {
      subUrl = new URL(path, websiteUrl).toString();
    } catch {
      continue;
    }

    if (verbose) process.stdout.write(`[SCRAPE] Fetching ${path}... `);

    // Same-domain rate limiting (2s)
    await sleep(2000);

    try {
      const subTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('HTTP fetch timed out (20s)')), 20000)
      );
      const result = await Promise.race([fetchWithRedirects(subUrl), subTimeout]);
      if (result.html && isUsableContent(result.html)) {
        rawHtmlByPage[subUrl] = result.html;
        const subText = extractText(result.html);
        totalText += '\n\n' + subText;
        if (verbose) console.log(`→ SUCCESS (${subText.length.toLocaleString()} chars)`);
      } else {
        if (verbose) console.log(`→ SKIPPED (low content)`);
      }
    } catch (err) {
      if (verbose) console.log(`→ FAILED (${err.message})`);
    }

    // Stop if we have enough content
    if (totalText.length >= MAX_CONTENT_CHARS) break;
  }

  const truncated = totalText.slice(0, MAX_CONTENT_CHARS);
  const pagesScraped = Object.keys(rawHtmlByPage).length;

  if (verbose) {
    console.log(
      `[SCRAPE] Total content: ${totalText.length.toLocaleString()} chars (truncated to ${truncated.length.toLocaleString()} for analysis)`
    );
    const preview = truncated.replace(/\s+/g, ' ').slice(0, 200);
    console.log(`[PREVIEW] "${preview}..."`);
  }

  return {
    content: truncated,
    rawHtmlByPage,
    pagesScraped,
    method: homepage.method,
  };
}

module.exports = {
  scrapeProspect,
  fetchPage,
  puppeteerFetch,
  isUsableContent,
  extractText,
  findSubpageLinks,
  closePuppeteer,
};
