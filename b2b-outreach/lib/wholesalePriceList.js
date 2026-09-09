/**
 * wholesalePriceList.js — the RUBIES wholesale terms and line sheet, as data
 * and as the JSON the storefront page renders.
 *
 * One source for two surfaces (2026-09-09): the email template's inline terms
 * and rubyshines.com/pages/wholesale-pricing (a theme section that fetches
 * assets/wholesale-pricing.json, which this module publishes). Every number is
 * retail × the discount, computed here and nowhere else, so the email and the
 * page can never disagree. A PDF attachment existed for a day and was dropped
 * (Jamie 2026-09-10): the country-aware page serves every case the PDF did.
 *
 * Deterministic end to end, no model anywhere (house rule: AI decides, code
 * calculates). The sheet is derived from the product catalog:
 *
 *   featured — the sheet is a curated subset in popularity order, locked with
 *              Jamie 2026-09-10 (FEATURED below): the styles a store actually
 *              stocks, not every SKU. Bras go last. A product missing from the
 *              catalog is skipped, never invented.
 *   section  — Underwear / Swimwear / Bras, decided from the product TITLE.
 *              Tags were tried and rejected: Naomi and Sassy are tagged
 *              `swimwear` but are underwear, and Jamie's own July 2026 price
 *              list files them under Underwear.
 *   bands    — a product's variants grouped by price, so youth and adult
 *              pricing sit under one product ("Youth 4-11", "Adult 12-16,
 *              XS-4X") rather than repeating the product per row.
 *
 * The page is country-aware (?country=xx picks a view); the email's inline
 * terms use the recipient's own rate, which is a per-partner negotiated figure
 * when one is stored and the country default otherwise.
 */
const { NUMERIC_SIZES, LETTER_SIZES, getVariantSize, parseSizeVariant } = require('../../customer-service/lib/sizeUtils');
const { partnerDiscountPercent } = require('./donationAgreement');
const { normalizeCountry } = require('./meetingTimezone');

const PAGE_URL = 'https://rubyshines.com/pages/wholesale-pricing';
const STORE_URL = 'https://rubyshines.com';
/** The site's explainer for the no-tuck shaping; linked from the email and the page intro (Jamie 2026-09-10). */
const HOW_IT_WORKS_URL = 'https://rubyshines.com/pages/how-it-works';

/** What the public page shows. Jamie 2026-09-09: "for now just show it as 50% off". */
const PAGE_DISCOUNT_PERCENT = 50;

/** The minimum order, in USD. Jamie 2026-09-10. */
const MINIMUM_ORDER_USD = 300;

/**
 * The sheet: section → the product handles on it. Jamie 2026-09-10: "AJ,
 * Charlie, Naomi and Sassy for underwear, all the bras are fine, swimwear:
 * Cheeky, Ruby, Mia, Serena. Order by popularity, have the bra last." Editing
 * this list is how a style joins or leaves the sheet. The ORDER within a
 * section comes from units sold (see orderByPopularity), so this list is
 * membership, not ranking; its order is only the tie-break.
 */
const FEATURED = [
  { name: 'Underwear', handles: [
    'the-aj-shaping-underwear',
    'the-extra-cute-shaping-underwear',
    'the-naomi-gaff-extra-strength-shaping-underwear',
    'the-sassy-no-tuck-shaping-underwear',
  ] },
  { name: 'Swimwear', handles: [
    'the-cheeky-shaping-bikini-bottom',
    'the-ruby-no-tuck-shaping-bikini-bottom',
    'the-mia-halter-bikini-top',
    'the-shaping-shorty-shorts',
  ] },
  { name: 'Bras', handles: [
    'the-ava-seamless-shaping-bra',
    'the-brooke-bra',
    'evey-shaping-sports-bra',
  ] },
];

const SECTION_ORDER = FEATURED.map(s => s.name);

// Products that never belong on a wholesale sheet, by tag or category, used
// when the sheet is built unfiltered (featured: false). A product with no sized
// variant (gift card, pride flag) is excluded before these are consulted.
const EXCLUDED_TAGS = new Set(['pride-merch', 'rubies-merch', 'chest-shaping']);
const EXCLUDED_CATEGORIES = new Set(['Bundles', 'Other']);

/** The extra line a retailer outside the US sees. Jamie 2026-09-10. */
const PAYMENT_LINE = 'Pay in USD (recommended) or in your local currency at the exchange rate on the day';

/**
 * The terms, as short lines at one discount. The email template prints these,
 * the PDF prints them, and the page prints them from the published JSON, so
 * the wording lives here once. Jamie 2026-09-10: terse. `international` adds
 * the payment line for anyone outside the US. Customer-facing, so no em
 * dashes. Pure.
 */
function wholesaleTermsLines(discountPercent, { international = false } = {}) {
  const d = Number(discountPercent);
  if (!Number.isFinite(d) || d <= 0 || d >= 100) throw new Error(`discountPercent must be between 0 and 100, got ${discountPercent}`);
  return [
    `${d}% off retail, priced in USD`,
    `$${MINIMUM_ORDER_USD} USD minimum order, no unit minimums`,
    'Free shipping, no duties',
    'Orders typically arrive within 5 business days',
    ...(international ? [PAYMENT_LINE] : []),
  ];
}

/**
 * The page is country-aware (Jamie 2026-09-10): `?country=ca` picks a view.
 * A view is a rate plus its terms. Only three exist, because the rate rule
 * has only three outcomes: the US (50%, domestic terms), Australia (50%,
 * international terms), everywhere else (30%, international terms). The
 * page's default, with no parameter, is the US view. Pure.
 */
const PAGE_VIEWS = {
  us: { rate: 50, international: false },
  au: { rate: 50, international: true },
  other: { rate: 30, international: true },
};
const DEFAULT_PAGE_VIEW = 'us';

/**
 * Local currency by country code, for the page's USD ↔ local toggle (Jamie
 * 2026-09-10). Prices are always priced in USD; the toggle is a courtesy
 * conversion at the day's rate, fetched in the browser. A country not listed
 * here gets no toggle. Lowercase ISO country → ISO 4217 currency. Pure data.
 */
const CURRENCY_BY_COUNTRY = {
  ca: 'CAD', au: 'AUD', nz: 'NZD', gb: 'GBP', ch: 'CHF', jp: 'JPY', mx: 'MXN',
  dk: 'DKK', se: 'SEK', no: 'NOK', pl: 'PLN', cz: 'CZK',
  de: 'EUR', fr: 'EUR', nl: 'EUR', be: 'EUR', ie: 'EUR', es: 'EUR', it: 'EUR', pt: 'EUR', at: 'EUR', fi: 'EUR',
};

/** Free-text country ("Canada", "US", "United Kingdom") → lowercase ISO code, or null. Pure. */
function countryCode(country) {
  const iso = normalizeCountry(country);
  return iso ? iso.toLowerCase() : null;
}

/** Which page view a country lands on: { key, rate, international }. Unknown → the default. Pure. */
function pageViewFor(country) {
  const code = countryCode(country);
  const key = code && PAGE_VIEWS[code] ? code : (code ? 'other' : DEFAULT_PAGE_VIEW);
  return { key, ...PAGE_VIEWS[key] };
}

/** The page link for a country: bare for the default view, `?country=xx` otherwise. Pure. */
function pageUrlFor(country) {
  const code = countryCode(country);
  if (!code || pageViewFor(country).key === DEFAULT_PAGE_VIEW) return PAGE_URL;
  return `${PAGE_URL}?country=${code}`;
}

/** Is this country the US? Drives the payment line on the PDF. Pure. */
function isDomestic(country) {
  return countryCode(country) === 'us';
}

/**
 * The discount a company buys at: a stored negotiated rate wins, else the
 * country default (US/AU 50%, elsewhere 30%, the same lookup the partnership
 * agreement uses). Pure.
 */
function wholesaleDiscountFor(company) {
  const stored = Number(company?.wholesale_discount_percent);
  if (Number.isFinite(stored) && stored > 0 && stored < 100) return stored;
  return partnerDiscountPercent(company?.country);
}

/** Retail × (100 − discount)%, in cents so 33 × 50% is 16.5 and not 16.499. Pure. */
function wholesalePrice(retail, discountPercent) {
  const r = Number(retail);
  if (!Number.isFinite(r)) throw new Error(`retail must be a number, got ${retail}`);
  return Math.round(r * 100 * (100 - Number(discountPercent))) / 10000;
}

/** Underwear / Bras / Swimwear from the title, or null for "not on the sheet". Pure. */
function sectionFor(title) {
  const t = String(title || '').toUpperCase();
  if (/\bBRA\b/.test(t)) return 'Bras';
  if (/UNDERWEAR/.test(t)) return 'Underwear';
  if (/BIKINI|ONE-PIECE|TANKINI|SWIM|SHORTY|\bSHORT\b/.test(t)) return 'Swimwear';
  return null;
}

/**
 * "AJ NO-TUCK SHAPING UNDERWEAR" → "AJ No-Tuck Shaping Underwear". Catalog
 * titles are shouted; the sheet is not. A whole word of one or two capitals
 * (AJ) is a name and stays; "NO" inside "NO-TUCK" is not. Pure.
 */
function displayName(title) {
  const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);
  return String(title || '').trim().split(/\s+/)
    .map(w => (/^[A-Z0-9]{1,2}$/.test(w) ? w : w.split('-').map(cap).join('-')))
    .join(' ');
}

/** Is this catalog product something a retailer can stock at wholesale? Pure. */
function isSheetProduct(product) {
  if (!product) return false;
  if (!sectionFor(product.title)) return false;
  const tags = (product.tags || []).map(t => String(t).toLowerCase());
  if (tags.some(t => EXCLUDED_TAGS.has(t))) return false;
  const cats = product.metafields?.categories || [];
  if (cats.some(c => EXCLUDED_CATEGORIES.has(c))) return false;
  return (product.variants || []).some(v => getVariantSize(v));
}

/** { base: 'XS', tall: true } from a cache size string like "xs" or "l tall". Pure. */
function splitSize(size) {
  const { base, modifier } = parseSizeVariant(String(size || '').toUpperCase());
  return { base: String(base || '').toUpperCase(), tall: modifier === 'Tall' };
}

/** "4-11", "12-16", "XS-4X", or a single size. Pure. */
function rangeLabel(sizes, order) {
  const present = order.filter(s => sizes.has(s));
  if (!present.length) return null;
  const first = present[0];
  const last = present[present.length - 1];
  return first === last ? first : `${first}-${last}`;
}

/**
 * One band per price a product sells at, labelled by the sizes that share it.
 *
 *   "Youth 4-11"           numeric sizes alone, whatever they run to
 *   "Adult 12-16, XS-4X"   youth 12-16 priced with the adult letter sizes
 *   "XS-4X"                letters only
 *   "… (incl. Tall)"       the band carries Tall variants
 *
 * Plus sizes (XS+, XXS+) sit inside a letter range and are not named; the
 * range already covers them. Sorted by price ascending. Pure.
 */
function priceBands(product) {
  const byPrice = new Map();
  for (const v of product.variants || []) {
    const size = getVariantSize(v);
    if (!size) continue;
    const retail = Number(v.price);
    if (!Number.isFinite(retail)) continue;
    const key = retail.toFixed(2);
    if (!byPrice.has(key)) byPrice.set(key, { retail, sizes: new Set(), tall: false });
    const band = byPrice.get(key);
    const { base, tall } = splitSize(size);
    band.sizes.add(base);
    if (tall) band.tall = true;
  }
  const letterNoPlus = LETTER_SIZES.filter(s => !s.endsWith('+'));
  return [...byPrice.values()]
    .sort((a, b) => a.retail - b.retail)
    .map(({ retail, sizes, tall }) => {
      const numeric = rangeLabel(sizes, NUMERIC_SIZES);
      const letters = rangeLabel(sizes, letterNoPlus);
      const numericMin = Math.min(...NUMERIC_SIZES.filter(s => sizes.has(s)).map(Number), Infinity);
      let prefix = '';
      if (numeric && !letters) prefix = 'Youth ';
      else if (numeric && letters && numericMin >= 12) prefix = 'Adult ';
      const parts = [numeric, letters].filter(Boolean).join(', ');
      return { retail, sizes: `${prefix}${parts}${tall ? ' (incl. Tall)' : ''}` };
    });
}

/**
 * One sheet entry for a catalog product at a discount. `extraRates` adds a
 * `wholesale_by_rate` map so the page can switch views without arithmetic. Pure.
 */
function sheetProduct(p, discountPercent, media, extraRates = []) {
  const m = media?.get?.(p.handle) || {};
  const rates = [...new Set([Number(discountPercent), ...extraRates.map(Number)])];
  return {
    product: displayName(p.title),
    handle: p.handle || null,
    url: `${STORE_URL}/products/${p.handle}`,
    image: m.image || null,
    bands: priceBands(p).map(b => ({
      ...b,
      wholesale: wholesalePrice(b.retail, discountPercent),
      ...(extraRates.length ? { wholesale_by_rate: Object.fromEntries(rates.map(r => [String(r), wholesalePrice(b.retail, r)])) } : {}),
    })),
  };
}

/**
 * Handles in popularity order: most units sold first, FEATURED order as the
 * tie-break (and the whole order when no sales data is supplied). Jamie
 * 2026-09-10: "order by popularity". Units come from the orders mirror at
 * publish time (fetchUnitsSoldByHandle), a deterministic count. Pure.
 */
function orderByPopularity(handles, popularity) {
  if (!popularity) return [...handles];
  const units = h => Number(popularity.get?.(h)) || 0;
  return [...handles].sort((a, b) => units(b) - units(a) || handles.indexOf(a) - handles.indexOf(b));
}

/**
 * The whole sheet at one discount.
 *
 *   featured (default true) — the curated FEATURED subset, each section by
 *                              popularity when `popularity` is given.
 *   featured: false          — every eligible catalog product, sections in
 *                              SECTION_ORDER, products A–Z (the full sheet,
 *                              for the console).
 *   media                    — Map(handle → { image }) to decorate products
 *                              with; absent means image: null.
 *   popularity               — Map(handle → units sold), the ranking source.
 *
 * Pure.
 *
 * @returns { discount_percent, currency, sections: [{ name, products: [{ product, handle, url, image, bands: [{ sizes, retail, wholesale }] }] }] }
 */
function buildPriceList(products, { discountPercent, featured = true, media, extraRates = [], popularity } = {}) {
  const d = Number(discountPercent);
  wholesaleTermsLines(d); // validates the rate
  const catalog = (products || []).filter(isSheetProduct);
  let sections;
  if (featured) {
    const byHandle = new Map(catalog.map(p => [p.handle, p]));
    sections = FEATURED.map(s => ({
      name: s.name,
      products: orderByPopularity(s.handles, popularity).map(h => byHandle.get(h)).filter(Boolean).map(p => sheetProduct(p, d, media, extraRates)),
    }));
  } else {
    sections = SECTION_ORDER.map(name => ({
      name,
      products: catalog.filter(p => sectionFor(p.title) === name)
        .sort((a, b) => displayName(a.title).localeCompare(displayName(b.title)))
        .map(p => sheetProduct(p, d, media, extraRates)),
    }));
  }
  return { discount_percent: d, currency: 'USD', sections: sections.filter(s => s.products.length) };
}

/** Every band as a flat row, for tables and tests. Pure. */
function flatRows(list) {
  return list.sections.flatMap(s => s.products.flatMap(p => p.bands.map(b => ({
    section: s.name, product: p.product, handle: p.handle, sizes: b.sizes, retail: b.retail, wholesale: b.wholesale,
  }))));
}

/**
 * The JSON the theme page fetches. Every view's rate is precomputed on each
 * band (`wholesale_by_rate`) and every view's terms ride along, so the page
 * does lookups only; `discount_percent` / `terms` / `wholesale` remain the
 * default view for anything reading the old shape. Pure.
 */
function themePayload(products, { generatedAt = new Date(), media, popularity, fxReferenceUsd = null } = {}) {
  const defaultRate = PAGE_VIEWS[DEFAULT_PAGE_VIEW].rate;
  const rates = [...new Set(Object.values(PAGE_VIEWS).map(v => v.rate))];
  const list = buildPriceList(products, { discountPercent: defaultRate, media, extraRates: rates, popularity });
  const views = Object.fromEntries(Object.entries(PAGE_VIEWS).map(([key, v]) => [key, {
    rate: v.rate,
    international: v.international,
    terms: wholesaleTermsLines(v.rate, { international: v.international }),
  }]));
  return {
    generated_at: new Date(generatedAt).toISOString(),
    discount_percent: list.discount_percent,
    currency: list.currency,
    minimum_order_usd: MINIMUM_ORDER_USD,
    terms: views[DEFAULT_PAGE_VIEW].terms,
    default_view: DEFAULT_PAGE_VIEW,
    views,
    currency_by_country: CURRENCY_BY_COUNTRY,
    // The USD price of the store's hidden `fx-reference` product. The page
    // reads that product's price in the visitor's market currency (Shopify's
    // own conversion, the same trick the shipping bar uses) and divides by
    // this to get the rate, so converted prices match the storefront's.
    fx_reference_usd: fxReferenceUsd == null ? null : Number(fxReferenceUsd),
    sections: list.sections,
  };
}

/** The catalog, loading it from Supabase if this process has not yet. */
async function loadSheetProducts() {
  const productCache = require('../../customer-service/lib/productCache');
  if (!productCache.getProducts().length) await productCache.loadFromSupabase();
  const products = productCache.getProducts();
  if (!products.length) throw new Error('product catalog is empty; cannot build the price list');
  return products;
}

module.exports = {
  PAGE_URL,
  STORE_URL,
  HOW_IT_WORKS_URL,
  PAGE_DISCOUNT_PERCENT,
  MINIMUM_ORDER_USD,
  PAYMENT_LINE,
  PAGE_VIEWS,
  DEFAULT_PAGE_VIEW,
  CURRENCY_BY_COUNTRY,
  FEATURED,
  SECTION_ORDER,
  countryCode,
  pageViewFor,
  pageUrlFor,
  isDomestic,
  wholesaleTermsLines,
  wholesaleDiscountFor,
  wholesalePrice,
  sectionFor,
  displayName,
  isSheetProduct,
  priceBands,
  orderByPopularity,
  buildPriceList,
  flatRows,
  themePayload,
  loadSheetProducts,
};
