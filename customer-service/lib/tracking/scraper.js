/**
 * Passport tracking scraper — Shopify's fulfillment events cover USPS/OnTrac
 * and any other Shopify-supported carrier directly, so we only scrape
 * Passport here. Passport's local-carrier handoff (Royal Mail, Australia
 * Post, DHL, etc.) is not surfaced through Shopify's fulfillment events.
 */

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

      // If this URL returned usable data, use it (the finally below closes
      // the page — the success path used to leak it until browser recycle).
      if (text && !/can.t find the tracking number/i.test(text) && text.length > 100) {
        return text;
      }
      // Otherwise fall through to try the next URL.
    } catch {
      // Try next URL on error
    } finally {
      await page.close().catch(() => {});
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
// Main entry point — Passport only. Other carriers source events directly
// from Shopify's fulfillment.events GraphQL connection (synced into
// orders.fulfillments[].events by syncAll.js).
// ---------------------------------------------------------------------------

async function scrapeTracking(trackingUrl, trackingNumber) {
  const carrier = detectCarrier(trackingUrl);
  if (carrier !== 'passport') {
    throw new Error(`scrapeTracking is only used for Passport — got carrier=${carrier}. Non-Passport tracking should read fulfillments.events from Supabase.`);
  }
  let rawText = await fetchPassportPage(trackingNumber);
  if (rawText.length > 4000) rawText = rawText.substring(0, 4000);
  return { carrier, trackingUrl, rawText };
}

module.exports = {
  scrapeTracking,
  detectCarrier,
  fetchPassportPage,
  closeBrowser,
};
