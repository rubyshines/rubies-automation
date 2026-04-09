/**
 * Tracking page scraper — fetches carrier tracking pages and returns raw text.
 * Parsing/extraction is handled by the deterministic parser or AI analyzer.
 *
 * Carriers:
 * - Passport (track.passportshipping.com) — Puppeteer (JS-rendered page)
 * - OnTrac (www.ontrac.com) — simple HTTP fetch
 * - USPS (tools.usps.com) — Shopify fulfillment fallback (anti-bot)
 */

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ---------------------------------------------------------------------------
// Carrier detection from tracking URL
// ---------------------------------------------------------------------------

function detectCarrier(trackingUrl) {
  if (!trackingUrl) return 'unknown';
  if (trackingUrl.includes('passportshipping.com') || trackingUrl.includes('passportglobal.com')) return 'passport';
  if (trackingUrl.includes('ontrac.com')) return 'ontrac';
  if (trackingUrl.includes('usps.com')) return 'usps';
  if (trackingUrl.includes('fedex.com')) return 'fedex';
  if (trackingUrl.includes('ups.com')) return 'ups';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// HTML → clean text (shared across carriers)
// ---------------------------------------------------------------------------

function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Simple HTTP fetch (OnTrac)
// ---------------------------------------------------------------------------

async function fetchTrackingPage(url) {
  const response = await fetch(url, { headers: BROWSER_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  const html = await response.text();
  return htmlToText(html);
}

// ---------------------------------------------------------------------------
// Puppeteer — shared browser instance for Passport
// ---------------------------------------------------------------------------

let _browser = null;
let _pageCount = 0;
const MAX_PAGES_PER_BROWSER = 20; // recycle browser for memory

async function getBrowser() {
  if (_browser && _pageCount < MAX_PAGES_PER_BROWSER) return _browser;
  if (_browser) {
    try { await _browser.close(); } catch {}
  }
  const puppeteer = require('puppeteer');
  _browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  _pageCount = 0;
  return _browser;
}

// Passport tracking URLs to try in order — the branded subdomain has
// historical data that the main domain sometimes can't find.
const PASSPORT_URLS = [
  'https://track.passportshipping.com/',
  'https://rubyshines.passportglobal.com/',
];

async function fetchPassportPage(trackingNumber) {
  const browser = await getBrowser();

  for (const baseUrl of PASSPORT_URLS) {
    const page = await browser.newPage();
    _pageCount++;

    try {
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

      await page.goto(`${baseUrl}${trackingNumber}`, {
        waitUntil: 'networkidle2',
        timeout: 20000,
      });

      // Wait for tracking data to render (look for status text or events)
      await page.waitForFunction(
        () => document.body.innerText.includes('Delivered')
          || document.body.innerText.includes('In transit')
          || document.body.innerText.includes('Current Status')
          || document.body.innerText.includes('Exception')
          || document.body.innerText.includes('Returned')
          || document.body.innerText.includes('Out for Delivery')
          || document.body.innerText.includes('does not have'),
        { timeout: 15000 },
      ).catch(() => {}); // proceed even if timeout — page may have partial data

      const text = await page.evaluate(() => document.body.innerText);

      // If this URL returned usable data, use it
      if (text && !/can.t find the tracking number/i.test(text) && text.length > 100) {
        return text;
      }

      // Otherwise try next URL
      await page.close().catch(() => {});
    } catch {
      await page.close().catch(() => {});
      // Try next URL on error
    }
  }

  // All URLs failed — return last attempt's text (or empty) so caller can classify
  return '';
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
    _pageCount = 0;
  }
}

// ---------------------------------------------------------------------------
// USPS — no scraping available (anti-bot protection). Use Shopify fulfillment
// status as fallback. Returns a text summary from what Shopify knows.
// ---------------------------------------------------------------------------

function buildUSPSFallbackText(trackingNumber, shopifyFulfillment) {
  const status = shopifyFulfillment?.status || 'unknown';
  const lines = [`USPS Tracking: ${trackingNumber}`];
  lines.push(`Shopify fulfillment status: ${status}`);
  if (shopifyFulfillment?.createdAt) lines.push(`Shipped: ${shopifyFulfillment.createdAt.split('T')[0]}`);
  lines.push(`Track at: https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch raw text from a carrier tracking page.
 * @param {string} trackingUrl - Full tracking URL
 * @param {string} trackingNumber - Tracking number
 * @param {Object} [shopifyFulfillment] - Shopify fulfillment data (used as fallback for USPS)
 * @returns {Promise<{ carrier: string, trackingUrl: string, rawText: string }>}
 */
async function scrapeTracking(trackingUrl, trackingNumber, shopifyFulfillment) {
  const carrier = detectCarrier(trackingUrl);
  let rawText;

  switch (carrier) {
    case 'passport':
      rawText = await fetchPassportPage(trackingNumber);
      break;
    case 'ontrac':
      rawText = await fetchTrackingPage(`https://www.ontrac.com/tracking/?number=${trackingNumber}`);
      break;
    case 'usps':
      rawText = buildUSPSFallbackText(trackingNumber, shopifyFulfillment);
      break;
    default:
      rawText = `Track your package at: ${trackingUrl}`;
      break;
  }

  // Cap text length for AI processing
  if (rawText.length > 4000) rawText = rawText.substring(0, 4000);

  return { carrier, trackingUrl, rawText };
}

module.exports = {
  scrapeTracking,
  detectCarrier,
  fetchTrackingPage,
  fetchPassportPage,
  buildUSPSFallbackText,
  htmlToText,
  closeBrowser,
};
