/**
 * Tracking page scraper — fetches carrier tracking pages and returns raw text.
 * Parsing/extraction is handled by the AI analyzer, not regex.
 *
 * Carriers:
 * - Passport (track.passportshipping.com) — simple HTTP fetch
 * - OnTrac (www.ontrac.com) — simple HTTP fetch
 * - USPS (tools.usps.com) — requires Puppeteer (JS-rendered React app)
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
  if (trackingUrl.includes('passportshipping.com')) return 'passport';
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
// Simple HTTP fetch (Passport, OnTrac)
// ---------------------------------------------------------------------------

async function fetchTrackingPage(url) {
  const response = await fetch(url, { headers: BROWSER_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  const html = await response.text();
  return htmlToText(html);
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
      rawText = await fetchTrackingPage(`https://track.passportshipping.com/${trackingNumber}`);
      break;
    case 'ontrac':
      rawText = await fetchTrackingPage(`https://www.ontrac.com/tracking/?number=${trackingNumber}`);
      break;
    case 'usps':
      // USPS has anti-bot protection — use Shopify fulfillment status as fallback
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
  buildUSPSFallbackText,
  htmlToText,
};
