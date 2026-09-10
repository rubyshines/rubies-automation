/**
 * Publish the wholesale line sheet to the rubies-ecom-v4 theme as a static
 * JSON asset, the way store locators and donation partners are published.
 *
 * Reads the product catalog (Supabase mirror of Shopify), ranks each section
 * by units sold over the last year (orders mirror), decorates each featured
 * product with its Shopify featured image, and writes
 * rubies-ecom-v4/assets/wholesale-pricing.json for the `wholesale-pricing`
 * theme section to fetch. The rows and the terms come from
 * b2b-outreach/lib/wholesalePriceList.js, the same module the wholesale_terms
 * email template reads, so the page and the email agree.
 *
 * Two ways to land the file, chosen automatically (2026-09-10, "no way I will
 * remember this"):
 *   - GITHUB_TOKEN set → one commit straight to the theme's main through the
 *     GitHub Contents API. Works anywhere, including the Railway crons, so
 *     the nightly sync can publish after the product sync.
 *   - otherwise → the local worktree + PR + auto-merge flow (needs the theme
 *     checkout and the gh CLI, i.e. Jamie's machine).
 * Both are no-ops when nothing but `generated_at` changed, so running every
 * night costs nothing on a quiet day.
 */

const path = require('path');

const { publishThemeAsset } = require('./themeAssetPublish');
const { hasGithubToken, putJsonIfChanged } = require('./githubContents');
const { themePayload, loadSheetProducts, PAGE_URL, FEATURED } = require('../../b2b-outreach/lib/wholesalePriceList');

const THEME_REPO = { owner: 'rubyshines', repo: 'rubies-ecom-v4', branch: 'main' };
const ASSET_PATH = 'assets/wholesale-pricing.json';

const DEFAULT_THEME_ASSET_PATH = path.resolve(
  __dirname, '../../../rubies-ecom-v4', ASSET_PATH
);

/** Keys whose change alone is not a change. */
const STAMP_KEYS = ['generated_at'];

// The page renders the image at up to ~200px wide; a 480px CDN cut is sharp
// on retina without pulling the 2000px original.
const IMAGE_WIDTH = 480;

/**
 * Map(handle → { image }) from Shopify for the featured handles. Live data
 * because product photos change and the catalog mirror does not carry them.
 * A product with no featured image gets null and the page renders without one.
 */
async function fetchProductMedia() {
  const { shopifyGraphQL } = require('./shopify');
  const handles = FEATURED.flatMap(s => s.handles);
  const query = handles.map(h => `handle:${h}`).join(' OR ');
  const data = await shopifyGraphQL(`query($q: String!) {
    products(first: 50, query: $q) { nodes { handle featuredImage { url } } }
  }`, { q: query });
  const media = new Map();
  for (const p of data?.products?.nodes || []) {
    const url = p.featuredImage?.url || null;
    media.set(p.handle, { image: url ? withWidth(url, IMAGE_WIDTH) : null });
  }
  return media;
}

/**
 * The USD price of the store's hidden `fx-reference` product (handle
 * `fx-reference`, the shipping bar's FX yardstick). The page divides that
 * product's market-converted price by this figure to get Shopify's rate.
 * Null when the product is missing, and the page then offers no switch.
 */
async function fetchFxReferenceUsd() {
  const { shopifyGraphQL } = require('./shopify');
  const data = await shopifyGraphQL(`{ productByHandle(handle: "fx-reference") { variants(first: 1) { nodes { price } } } }`);
  const price = Number(data?.productByHandle?.variants?.nodes?.[0]?.price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Shopify CDN URLs accept a width parameter; add it without breaking the version query. Pure. */
function withWidth(url, width) {
  try {
    const u = new URL(url);
    u.searchParams.set('width', String(width));
    return u.toString();
  } catch {
    return url;
  }
}

/** How far back "popular" looks. A year covers both swim and underwear seasons. */
const POPULARITY_DAYS = 365;

/**
 * Map(handle → units sold) over the trailing window, from the orders mirror:
 * every non-cancelled order that is not a samples event (tagged `sample*`,
 * the same rule the B2B cadence uses), quantity net of refunds, resolved
 * variant → product → handle. A deterministic count, so it is code, not a
 * judgment. Products with no sales are simply absent (treated as 0).
 */
async function fetchUnitsSoldByHandle({ days = POPULARITY_DAYS, now = new Date() } = {}) {
  const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
  const sb = getSupabaseClient();
  const since = new Date(now.getTime() - days * 86400000).toISOString();

  const orders = await fetchAllPaginated(() => sb.from('orders')
    .select('shopify_order_id, cancelled_at, tags').gte('created_at', since));
  const counted = new Set(orders
    .filter(o => !o.cancelled_at && !/sample/i.test(String(o.tags || '')))
    .map(o => o.shopify_order_id));
  if (!counted.size) return new Map();

  const [items, variants, products] = await Promise.all([
    fetchAllPaginated(() => sb.from('order_line_items')
      .select('shopify_order_id, shopify_variant_id, quantity, refunded_quantity').gte('shopify_order_id', 0)),
    fetchAllPaginated(() => sb.from('product_variants').select('shopify_variant_id, shopify_product_id')),
    fetchAllPaginated(() => sb.from('products').select('shopify_product_id, handle')),
  ]);
  const variantToProduct = new Map(variants.map(v => [String(v.shopify_variant_id), v.shopify_product_id]));
  const productToHandle = new Map(products.map(p => [p.shopify_product_id, p.handle]));

  const units = new Map();
  for (const li of items) {
    if (!counted.has(li.shopify_order_id)) continue;
    const handle = productToHandle.get(variantToProduct.get(String(li.shopify_variant_id)));
    if (!handle) continue;
    units.set(handle, (units.get(handle) || 0) + (Number(li.quantity) || 0) - (Number(li.refunded_quantity) || 0));
  }
  return units;
}

/** The payload as it would be written, without touching git. */
async function buildWholesalePricingPayload({ generatedAt, media, popularity, fxReferenceUsd } = {}) {
  const products = await loadSheetProducts();
  const m = media || await fetchProductMedia();
  const pop = popularity || await fetchUnitsSoldByHandle();
  const fx = fxReferenceUsd === undefined ? await fetchFxReferenceUsd() : fxReferenceUsd;
  return themePayload(products, { generatedAt, media: m, popularity: pop, fxReferenceUsd: fx });
}

function countProducts(payload) {
  return payload.sections.reduce((n, s) => n + s.products.length, 0);
}

/**
 * Land the payload on the theme.
 *
 * @param {object} opts
 *   via         'auto' (default: GitHub API when GITHUB_TOKEN is set, else
 *               worktree) | 'github' | 'worktree'
 *   outPath     worktree flow: where to write the JSON (default = theme repo working tree)
 *   dry_run     worktree flow: only write the working tree, no commit/push/merge
 *   merge       worktree flow: true (default) → open PR + squash-merge → auto-deploys
 *   baseBranch  default 'main'
 * @returns the standard theme-publish result shape (+ count, discount_percent, via)
 */
async function publishWholesalePricing({
  via = 'auto',
  outPath = DEFAULT_THEME_ASSET_PATH,
  dry_run = false,
  merge = true,
  baseBranch = 'main',
  payload: given,
  putJson = putJsonIfChanged,
} = {}) {
  const payload = given || await buildWholesalePricingPayload();
  const count = countProducts(payload);
  const mode = via === 'auto' ? (hasGithubToken() && !dry_run ? 'github' : 'worktree') : via;

  if (mode === 'github') {
    const res = await putJson({
      ...THEME_REPO,
      branch: baseBranch,
      path: ASSET_PATH,
      content: payload,
      ignoreKeys: STAMP_KEYS,
      message: `data: update wholesale-pricing.json (${count} products at ${payload.discount_percent}%)\n\nGenerated by rubies-automations wholesale_price_list_publish from the product catalog.`,
    });
    return {
      via: 'github',
      path: null,
      count,
      discount_percent: payload.discount_percent,
      committed: !res.noOp,
      merged: !res.noOp,
      noOp: res.noOp,
      branch: baseBranch,
      baseBranch,
      commitSha: res.commitSha,
      prUrl: res.commitUrl,
      liveUrl: PAGE_URL,
    };
  }

  const result = await publishThemeAsset(payload, {
    outPath,
    dry_run,
    merge,
    baseBranch,
    liveUrl: PAGE_URL,
    relativeOutPath: ASSET_PATH,
    branchPrefix: 'data/wholesale-pricing',
    commitTitle: `data: update wholesale-pricing.json (${count} products at ${payload.discount_percent}%)`,
    commitBody: 'Generated by rubies-automations wholesale_price_list_publish from the product catalog.',
    prTitle: `data: update wholesale-pricing.json (${count} products)`,
    prBody: 'Auto-generated wholesale line sheet from the product catalog.\n\n🤖 Generated with rubies-automations',
    ignoreKeys: STAMP_KEYS,
  });
  // publishThemeAsset counts array payloads; this one is an object.
  return { ...result, via: 'worktree', count, discount_percent: payload.discount_percent };
}

/**
 * The unattended entry point (set_product_prices after a commit, the nightly
 * sync after Products). Never throws: a publish failure must not turn a
 * successful price change into an error, and the returned line says what
 * happened so the caller can show it.
 *
 * @returns { ok, noOp, line, result?, error? }
 */
async function autoPublishWholesalePricing(opts = {}) {
  try {
    const result = await publishWholesalePricing(opts);
    if (result.noOp) return { ok: true, noOp: true, result, line: 'Wholesale pricing page: unchanged, nothing to publish.' };
    if (result.merged) {
      return { ok: true, noOp: false, result, line: `Wholesale pricing page: published (${result.count} products, via ${result.via}); live in ~30s at ${PAGE_URL}.` };
    }
    return {
      ok: false, noOp: false, result,
      line: `Wholesale pricing page: pushed but not merged${result.mergeError ? ` (${result.mergeError})` : ''}${result.branch ? `; branch ${result.branch}` : ''}.`,
    };
  } catch (err) {
    return {
      ok: false, noOp: false, error: err.message,
      line: `Wholesale pricing page: publish failed (${err.message}). Run wholesale_price_list_publish by hand.`,
    };
  }
}

module.exports = {
  publishWholesalePricing, autoPublishWholesalePricing, buildWholesalePricingPayload,
  fetchProductMedia, fetchUnitsSoldByHandle, fetchFxReferenceUsd, withWidth,
  POPULARITY_DAYS, STAMP_KEYS, THEME_REPO, ASSET_PATH, DEFAULT_THEME_ASSET_PATH,
};
