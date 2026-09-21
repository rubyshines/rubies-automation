/**
 * catalog.js — what a store ACTUALLY sells, read from its own product feed.
 *
 * The research pass writes a prose profile from a homepage scrape, and that
 * profile is wrong in both directions about gender-affirming stock. One store
 * whose profile claimed a full "Gender Affirmation" category with gaffs and
 * breast forms had nothing of the kind; another whose profile named no gear at
 * all turned out to stock a Classic Gaff, Bandage Tucking Shorts and a
 * Dragonfly Tucking Thong. Both errors cost operator time, and the second kind
 * is the expensive one: a real prospect dropped on a summary's silence.
 *
 * A Shopify storefront publishes `/products.json` unauthenticated, so the
 * catalog can simply be read: titles, product types, tags and variant prices.
 * That turns three of the vetting rules from a judgment call into a lookup —
 * does a gaff exist in this catalog, what does their cheapest pair of
 * underwear cost, how much of the range is men's.
 *
 * Coverage is partial and that is fine. Roughly half of stores expose a
 * readable feed; the rest return `readable: false` and go to the operator's
 * hand-vet pile rather than being guessed at. "Cannot read" must never
 * collapse into "has none", which is the mistake a keyword summary makes.
 *
 * No model runs here. Deterministic, network-bound, and safe to re-run.
 */

// Femme gear is what RUBIES competes with and beside: a store carrying it
// already sells to trans women. Masc gear proves the shop serves trans
// customers but sits on the other side of the catalog, so the two are counted
// apart and never pooled.
const FEMME_RE = /\b(gaff|tucking|tuck (panty|panties|thong|short)|breast (form|plate)|hip (pad|padding|enhancer))/i;
const MASC_RE = /\b(binder|chest bind|packer|packing (gear|underwear)|stand.?to.?pee|\bstp\b)/i;
// Women's underwear, for the price floor. Men's lines are excluded so a shop
// whose cheap items are all jockstraps is not read as a cheap panty seller.
const PANTY_RE = /\b(panty|panties|brief|briefs|thong|boyshort|knicker|underwear|lingerie set)\b/i;
const MENS_RE = /\b(men'?s|jockstrap|jock strap|for him|boxer brief)\b/i;

const PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 8;   // 2000 products; beyond that a "no gear" read is not trustworthy
const DEFAULT_TIMEOUT_MS = 20000;

/** Bare host from a URL. Pure. */
function catalogHost(url) {
  return String(url || '')
    .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '').trim().toLowerCase();
}

/** Everything we match on for one product. Pure. */
function productText(p) {
  return [p.title, p.product_type, Array.isArray(p.tags) ? p.tags.join(' ') : p.tags].filter(Boolean).join(' ');
}

/**
 * Fold a product list into the facts the vetting rules ask about. Pure, so the
 * rules can be tested without a network.
 */
function summarizeProducts(products, { complete = true } = {}) {
  const femme = [], masc = [], pantyPrices = [];
  let mens = 0, panties = 0;
  for (const p of products) {
    const text = productText(p);
    if (FEMME_RE.test(text)) femme.push(p.title);
    if (MASC_RE.test(text)) masc.push(p.title);
    const isMens = MENS_RE.test(text);
    if (isMens) mens++;
    if (PANTY_RE.test(text) && !isMens) {
      panties++;
      for (const v of p.variants || []) {
        const n = parseFloat(v.price);
        if (n > 0) pantyPrices.push(n);
      }
    }
  }
  pantyPrices.sort((a, b) => a - b);
  return {
    readable: true,
    complete,                       // false when the page cap was hit: absence proves nothing
    products_read: products.length,
    femme_gear: femme.slice(0, 5),
    masc_gear: masc.slice(0, 5),
    femme_gear_count: femme.length,
    masc_gear_count: masc.length,
    womens_underwear_count: panties,
    cheapest_womens_underwear: pantyPrices.length ? pantyPrices[0] : null,
    median_womens_underwear: pantyPrices.length ? pantyPrices[Math.floor(pantyPrices.length / 2)] : null,
    mens_share: products.length ? Math.round((mens / products.length) * 100) / 100 : null,
  };
}

/** One page of a Shopify product feed, or null when this is not one. */
async function fetchProductPage(host, page, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://${host}/products.json?limit=${PAGE_SIZE}&page=${page}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RUBIES prospect research)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  if (!/json/i.test(res.headers.get('content-type') || '')) return null;
  const body = await res.json();
  return Array.isArray(body?.products) ? body.products : null;
}

/**
 * Read a store's catalog. Never throws: an unreadable store is a fact about
 * the store, not an error, and the caller routes it to a human.
 *
 * @returns {{readable: boolean, reason?: string, ...summarizeProducts}}
 */
async function readCatalog(website, { maxPages = DEFAULT_MAX_PAGES, ...opts } = {}) {
  const host = catalogHost(website);
  if (!host) return { readable: false, reason: 'no website' };
  const products = [];
  for (let page = 1; page <= maxPages; page++) {
    let batch;
    try { batch = await fetchProductPage(host, page, opts); }
    catch (err) { batch = null; if (page === 1) return { readable: false, reason: `fetch failed: ${err.message}` }; }
    if (batch === null) {
      if (page === 1) return { readable: false, reason: 'no product feed' };
      break;                                    // a later page failing still leaves a usable read
    }
    products.push(...batch);
    if (batch.length < PAGE_SIZE) return summarizeProducts(products, { complete: true });
  }
  // Ran out of pages with more to come: we read a lot but not all of it.
  return summarizeProducts(products, { complete: products.length < maxPages * PAGE_SIZE });
}

module.exports = {
  readCatalog, summarizeProducts, catalogHost, productText,
  FEMME_RE, MASC_RE, PANTY_RE, MENS_RE, PAGE_SIZE, DEFAULT_MAX_PAGES,
};
