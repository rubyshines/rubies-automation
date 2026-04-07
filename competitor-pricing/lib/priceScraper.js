const { URL } = require('url');
const https = require('https');
const http = require('http');

// Rate limiting — 2s between requests to same domain
const lastFetchByDomain = new Map();

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitDelay(url, delayMs = 1000) {
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
    if (elapsed < delayMs) {
      await sleep(delayMs - elapsed);
    }
  }
  lastFetchByDomain.set(hostname, Date.now());
}

// Hard timeout wrapper
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Cache for store base currencies (from meta.json)
const _storeCurrencyCache = new Map();

/**
 * Detect a Shopify store's base currency via /meta.json.
 * Returns currency code (e.g. 'CAD', 'EUR', 'USD') or null.
 */
async function detectShopifyCurrency(productUrl) {
  const parsed = new URL(productUrl);
  const origin = parsed.origin;

  if (_storeCurrencyCache.has(origin)) return _storeCurrencyCache.get(origin);

  try {
    const metaUrl = origin + '/meta.json';
    await rateLimitDelay(metaUrl);
    const res = await fetch(metaUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const meta = await res.json();
      if (meta.currency) {
        _storeCurrencyCache.set(origin, meta.currency);
        return meta.currency;
      }
    }
  } catch {
    // Not a Shopify store or meta.json blocked
  }

  _storeCurrencyCache.set(origin, null);
  return null;
}

/**
 * Try Shopify's product JSON endpoint first (most reliable for Shopify stores).
 * URL like /products/foo → /products/foo.json
 *
 * IMPORTANT: Shopify JSON returns prices in the store's BASE currency, not USD.
 * We detect the base currency via /meta.json so the caller can convert.
 *
 * NOTE: We use MINIMAL headers for JSON fetches. Full browser-like headers
 * (Accept-Language, etc.) trigger Shopify Markets to return geo-adjusted prices,
 * which are unreliable and inconsistent. Minimal headers get the store's true
 * base-currency price.
 */
async function tryShopifyJson(url) {
  const jsonUrl = url.replace(/\/?$/, '.json');
  await rateLimitDelay(jsonUrl);

  const res = await fetch(jsonUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const body = await res.text();

  try {
    const data = JSON.parse(body);
    if (!data.product) return null;

    const p = data.product;
    const variant = p.variants && p.variants[0];
    const price = variant ? parseFloat(variant.price) : null;
    const compareAt = variant && variant.compare_at_price
      ? parseFloat(variant.compare_at_price)
      : null;
    const available = p.variants
      ? p.variants.some((v) => v.available !== false)
      : true;

    // Detect the store's base currency
    const baseCurrency = await detectShopifyCurrency(url);

    return {
      product_name: p.title,
      price,
      compare_at_price: compareAt,
      currency_code: baseCurrency, // actual store currency (CAD, EUR, USD, etc.)
      in_stock: available,
      url_valid: true,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a product page HTML via simple HTTP request.
 * Returns { html, finalUrl, method: 'simple' }
 */
async function fetchProductPage(url) {
  await rateLimitDelay(url);

  try {
    const result = await withTimeout(fetchWithRedirects(url), 15000, 'HTTP fetch');
    if (result.html && result.html.length > 500) {
      return { html: result.html, finalUrl: result.finalUrl, method: 'simple' };
    }
  } catch (err) {
    console.warn(`  HTML fetch failed for ${url}: ${err.message}`);
  }

  // Puppeteer fallback
  try {
    const result = await withTimeout(puppeteerFetchPage(url), 45000, 'Puppeteer fetch');
    return { html: result.html, finalUrl: url, method: 'puppeteer' };
  } catch (err) {
    console.warn(`  Puppeteer fetch failed for ${url}: ${err.message}`);
    throw new Error(`Both fetch methods failed for ${url}`);
  }
}

// Minimal-header HTTP fetch for Shopify JSON endpoints.
// Full browser headers trigger Shopify Markets geo-pricing which returns wrong prices.
function fetchMinimal(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '' }, timeout: 12000, agent: false }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume(); // drain the response
        resolve({ redirect: redirectUrl, statusCode: res.statusCode });
        return;
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 200000) res.destroy();
      });
      res.on('end', () => resolve({ html: data, statusCode: res.statusCode }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// Simple HTTP fetch with full browser headers (for HTML pages)
function fetchSimple(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
      timeout: 12000,
    };

    const req = lib.request(options, (res) => {
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
    const result = await fetchSimple(current);
    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    return { html: result.html, statusCode: result.statusCode, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

// Puppeteer fallback
let _browser = null;
let _usageCount = 0;

async function puppeteerFetchPage(url) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error('puppeteer not installed');
  }

  if (_browser && _usageCount >= 10) {
    await _browser.close().catch(() => {});
    _browser = null;
    _usageCount = 0;
  }

  if (!_browser) {
    _browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }

  const page = await _browser.newPage();
  _usageCount++;

  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const html = await page.content();
    return { html };
  } finally {
    await page.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

module.exports = { fetchProductPage, tryShopifyJson, detectShopifyCurrency, closeBrowser };
