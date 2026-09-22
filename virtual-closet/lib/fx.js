'use strict';
/**
 * The day's exchange rate for a centre whose currency is not the shop's.
 *
 * The store carries a hidden product, handle `fx-reference`, priced at a
 * round USD figure. Shopify Markets prices it in every market's currency at
 * the store's own conversion rate, and the theme reads that local price to
 * convert shipping thresholds (rubies-ecom-v4 sections/announcement-bar.liquid).
 * The ledger reads the same product through the Admin API's contextual
 * pricing for the centre's country, so the rate the ledger uses is the rate
 * the shopper saw. rate = local price / base price, centre currency per 1 USD.
 *
 * A converted row records the rate and is never revisited (Jamie, 2026-09-22),
 * so the cache here is only about not asking Shopify for every order on a
 * busy day: one read per country per hour per process.
 */
const FX_HANDLE = 'fx-reference';
const TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // country -> { at, rate, currency }

/**
 * Centre currency per one unit of the shop currency, for a centre. Throws
 * when the store has no fx-reference product, no price for that country, or
 * prices it in a currency other than the centre's (a Markets misconfiguration
 * the ledger must not paper over).
 */
async function rate(centre, { now = Date.now() } = {}) {
  const country = String(centre?.address?.country || '').toUpperCase();
  const currency = String(centre?.currency || '').toUpperCase();
  if (!country || !currency) throw new Error('fx: the centre needs a country and a currency');
  const hit = cache.get(country);
  if (hit && now - hit.at < TTL_MS && hit.currency === currency) return hit.rate;

  // Lazy, so tests can stand in for the Shopify client (see ledger.js).
  const { shopifyGraphQL } = require('../../customer-service/lib/shopify');
  const data = await shopifyGraphQL(`query($handle: String!, $country: CountryCode!) {
    productByHandle(handle: $handle) { variants(first: 1) { nodes {
      price
      contextualPricing(context: { country: $country }) { price { amount currencyCode } }
    } } } }`, { handle: FX_HANDLE, country });
  const v = data?.productByHandle?.variants?.nodes?.[0];
  const base = parseFloat(v?.price);
  const local = parseFloat(v?.contextualPricing?.price?.amount);
  const localCurrency = v?.contextualPricing?.price?.currencyCode;
  if (!(base > 0) || !(local > 0)) throw new Error(`fx: no ${FX_HANDLE} price for ${country}`);
  if (localCurrency !== currency) throw new Error(`fx: the store prices ${country} in ${localCurrency}, the centre is in ${currency}`);
  const r = local / base;
  cache.set(country, { at: now, rate: r, currency });
  return r;
}

function clear() { cache.clear(); }

module.exports = { FX_HANDLE, rate, clear };
