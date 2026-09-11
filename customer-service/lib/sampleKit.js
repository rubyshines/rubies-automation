/**
 * Wholesale sample kit — the recipe, and the stock rule that picks its colours.
 *
 * A sample kit is the box we send a prospective retailer so a buyer can handle
 * the fit and the fabric. It has gone out nineteen times as the same six lines
 * (November 2025), retyped by hand into create_order each time. This module is
 * that recipe written down, plus the one judgment the recipe cannot make by
 * itself: whether the colour we default to is a colour we should be showing.
 *
 * WHY COLOUR CAN CHANGE. The kit is a sales instrument. A buyer who falls for a
 * colourway we cannot restock is a worse outcome than a buyer shown black, so
 * the kit should only display colours we could confidently fill a wholesale
 * reorder in. That makes the test a question about supply, not about the single
 * unit the kit consumes.
 *
 * WHY WEEKS OF COVER AND NOT UNITS ON HAND. Units on hand answers the wrong
 * question and answers it backwards. Measured 2026-09-11: RUBY-PNK-M held 177
 * units against three sales in ninety days (758 weeks of cover, entirely safe to
 * draw on) while RUBY-BLK-XL held 43 units against thirty-eight sales (14.5
 * weeks, genuinely tight). Any flat unit threshold passes the tight one and
 * flags the safe one. Cover is inventory divided by the rate it actually leaves.
 *
 * The scoring is pure and lives in pickKitColors; loadKitStock is the only part
 * that touches the network.
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { normalizeSize } = require('./sizeUtils');

// ---------------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------------

/**
 * The postcard that goes in every kit. It is an UNLISTED Shopify product, which
 * is why the kit resolves its own SKUs out of Supabase rather than through
 * productCache — the cache deliberately loads ACTIVE products only, so that an
 * unlisted item can never surface in customer-facing product search.
 */
const KIT_POSTCARD_SKU = 'PCARD-RETAIL-KIT';

/**
 * The five garments, in the order they were packed for the November 2025 kits.
 *
 * `defaultColor` is the colour the kit wants: Sandstone for the four underwear
 * and bra pieces, because the nude shows the no-tuck shaping most clearly.
 * Ruby's default is Pink because Ruby has no Sandstone at all.
 *
 * `colorPreference` is the order substitutes are considered in, ahead of any
 * remaining colour. Black first everywhere: it is the universal neutral, so a
 * kit that falls back to it still reads as a deliberate set rather than as
 * whatever happened to be in the warehouse.
 */
const KIT_GARMENTS = [
  { key: 'charlie', prefix: 'UNW',  label: 'Charlie no-tuck underwear', defaultColor: 'SND', colorPreference: ['BLK'] },
  { key: 'aj',      prefix: 'AJ',   label: 'AJ no-tuck underwear',      defaultColor: 'SND', colorPreference: ['BLK'] },
  { key: 'brooke',  prefix: 'BB',   label: 'Brooke shaping bra',        defaultColor: 'SND', colorPreference: ['BLK'] },
  { key: 'ava',     prefix: 'SB',   label: 'Ava seamless shaping bra',  defaultColor: 'SND', colorPreference: ['BLK'] },
  { key: 'ruby',    prefix: 'RUBY', label: 'Ruby no-tuck bikini bottom', defaultColor: 'PNK', colorPreference: ['BLK'] },
];

// ---------------------------------------------------------------------------
// The stock rule
// ---------------------------------------------------------------------------

/**
 * Weeks of cover below which a colourway is not worth showing a buyer. Set at a
 * production cycle: under this, a reorder they place off the kit is a reorder we
 * may not be able to fill in the colour they saw.
 */
const MIN_WEEKS_COVER = 20;

/**
 * Units below which a colourway is out regardless of cover. This is the floor
 * that catches the case cover cannot see: a colourway new enough to have no
 * sales in the window has infinite cover on three units.
 */
const MIN_UNITS = 6;

/**
 * How much healthier a substitute must be before the kit changes colour. A swap
 * from nineteen weeks to twenty-two is churn, not a fix, and every swap costs
 * the kit some of its coherence.
 */
const SUBSTITUTION_MARGIN = 1.5;

/** Trailing window the sales rate is measured over. */
const SALES_WINDOW_DAYS = 90;

const WEEKS_PER = (days) => days / 7;

/**
 * Cover in weeks for one candidate. A colourway with no sales in the window has
 * no rate to divide by, so its cover is unbounded — which is correct, and is
 * exactly why MIN_UNITS exists alongside it.
 */
function weeksOfCover({ qty, unitsSold, windowDays = SALES_WINDOW_DAYS }) {
  const perWeek = (unitsSold || 0) / WEEKS_PER(windowDays);
  if (perWeek <= 0) return Infinity;
  return (qty || 0) / perWeek;
}

function isHealthy(c) {
  return c.qty >= MIN_UNITS && c.weeksCover >= MIN_WEEKS_COVER;
}

/**
 * Choose the colour for one garment. Pure.
 *
 * @param garment     entry from KIT_GARMENTS
 * @param candidates  [{ color, sku, qty, weeksCover, variantId, title }] — every
 *                    colourway of this garment that exists in the wanted size
 * @param forcedColor operator override; used verbatim when it resolves
 * @returns { chosen, status, reason, candidates }
 *          status: 'default' | 'forced' | 'substituted' | 'no_healthy_option' | 'unavailable'
 */
function pickGarmentColor(garment, candidates, forcedColor) {
  const list = (candidates || []).slice();
  if (!list.length) {
    return { chosen: null, status: 'unavailable', reason: 'no colourway of this garment exists in that size', candidates: list };
  }

  if (forcedColor) {
    const forced = list.find(c => c.color === forcedColor);
    if (forced) {
      return { chosen: forced, status: 'forced', reason: 'colour set by the operator', candidates: list };
    }
    // A forced colour that does not exist is an operator mistake worth saying
    // out loud rather than quietly ignoring, so it falls through to the normal
    // path carrying a reason.
  }

  const preferred = list.find(c => c.color === garment.defaultColor);

  if (preferred && isHealthy(preferred)) {
    return { chosen: preferred, status: 'default', reason: null, candidates: list };
  }

  // Substitutes: the named preference order first, then whatever is left by
  // cover. Only healthy ones, and only when meaningfully better than what we
  // would otherwise send.
  const rest = list
    .filter(c => c !== preferred && isHealthy(c))
    .sort((a, b) => {
      const ra = garment.colorPreference.indexOf(a.color);
      const rb = garment.colorPreference.indexOf(b.color);
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      return b.weeksCover - a.weeksCover;
    });

  const floor = preferred ? preferred.weeksCover * SUBSTITUTION_MARGIN : 0;
  const swap = rest.find(c => c.weeksCover >= floor);

  if (swap) {
    const why = preferred
      ? `${garment.defaultColor} is ${fmtCover(preferred.weeksCover)} of cover on ${preferred.qty} units`
      : `${garment.defaultColor} is not made in that size`;
    return { chosen: swap, status: 'substituted', reason: why, candidates: list };
  }

  // Nothing healthy clears the bar. Never silently ship the scarcest thing and
  // never silently substitute into something equally scarce — keep the default
  // and make the operator look at it.
  const fallback = preferred || list.slice().sort((a, b) => b.weeksCover - a.weeksCover)[0];
  return {
    chosen: fallback,
    status: 'no_healthy_option',
    reason: `no colourway of this garment clears ${MIN_WEEKS_COVER} weeks of cover in that size`,
    candidates: list,
  };
}

/**
 * Choose colours for the whole kit. Pure.
 *
 * @param candidatesByGarment Map/obj key → candidate array (see pickGarmentColor)
 * @param forcedColors        { [garmentKey]: 'BLK' }
 */
function pickKitColors(candidatesByGarment, forcedColors = {}) {
  return KIT_GARMENTS.map(g => ({
    garment: g,
    ...pickGarmentColor(g, candidatesByGarment[g.key] || [], forcedColors[g.key]),
  }));
}

function fmtCover(weeks) {
  if (weeks === Infinity) return 'no recent sales';
  return `${weeks.toFixed(0)}w`;
}

// ---------------------------------------------------------------------------
// Loading the numbers
// ---------------------------------------------------------------------------

/**
 * Net units sold per SKU over the trailing window, from the orders mirror.
 *
 * Sample kits are excluded on the same `sample*` tag rule the B2B cadence and
 * the wholesale price list use: a kit is a giveaway, and counting our own
 * giveaways as demand would make every colour we sample look scarcer than it is
 * and drive the rule to substitute away from itself.
 */
async function fetchUnitsSold(skus, { days = SALES_WINDOW_DAYS, now = new Date() } = {}) {
  const sb = getSupabaseClient();
  const since = new Date(now.getTime() - days * 86400000).toISOString();

  const orders = await fetchAllPaginated(() => sb.from('orders')
    .select('shopify_order_id, cancelled_at, tags').gte('created_at', since));
  const counted = orders
    .filter(o => !o.cancelled_at && !/sample/i.test(String(o.tags || '')))
    .map(o => o.shopify_order_id);

  const units = new Map();
  if (!counted.length || !skus.length) return units;

  const BATCH = 100;
  for (let i = 0; i < counted.length; i += BATCH) {
    const batch = counted.slice(i, i + BATCH);
    const rows = await fetchAllPaginated(() => sb.from('order_line_items')
      .select('sku, quantity, refunded_quantity')
      .in('shopify_order_id', batch)
      .in('sku', skus));
    for (const r of rows) {
      if (!r.sku) continue;
      const sold = (Number(r.quantity) || 0) - (Number(r.refunded_quantity) || 0);
      if (sold <= 0) continue;
      units.set(r.sku, (units.get(r.sku) || 0) + sold);
    }
  }
  return units;
}

/**
 * Every colourway of every kit garment in the wanted size, scored.
 *
 * Candidates are discovered from the catalog by SKU prefix rather than listed
 * here, so a new colourway becomes eligible the moment it is stocked. Only
 * ACTIVE products are eligible: an archived or unlisted colourway is not
 * something to put in front of a buyer.
 */
async function loadKitStock(size, { now = new Date() } = {}) {
  const sb = getSupabaseClient();
  // Both sides go through normalizeSize, so a kit asked for in "1X" matches the
  // SKUs that spell the same size XL, and the operator can type either.
  const wanted = normalizeSize(String(size || '').toUpperCase());

  const variants = await fetchAllPaginated(() => sb.from('product_variants')
    .select('sku, title, shopify_variant_id, shopify_product_id, inventory_quantity, price'));
  const products = await fetchAllPaginated(() => sb.from('products')
    .select('shopify_product_id, title, status'));
  const productById = new Map(products.map(p => [p.shopify_product_id, p]));

  const candidatesByGarment = {};
  const allSkus = [];

  for (const g of KIT_GARMENTS) {
    const rows = variants.filter(v => {
      if (!v.sku) return false;
      const parts = v.sku.split('-');
      if (parts.length !== 3) return false;
      const [prefix, , sz] = parts;
      if (prefix !== g.prefix || normalizeSize(sz.toUpperCase()) !== wanted) return false;
      return productById.get(v.shopify_product_id)?.status === 'ACTIVE';
    });
    candidatesByGarment[g.key] = rows.map(v => ({
      color: v.sku.split('-')[1],
      sku: v.sku,
      variantId: v.shopify_variant_id,
      productTitle: productById.get(v.shopify_product_id)?.title || g.label,
      // Shopify's own variant title already renders plus sizes the way the site
      // and the customer's order do (1X, not XL), so it is the safe label.
      variantTitle: v.title,
      price: v.price,
      qty: Number(v.inventory_quantity) || 0,
    }));
    allSkus.push(...candidatesByGarment[g.key].map(c => c.sku));
  }

  const sold = await fetchUnitsSold(allSkus, { now });
  for (const key of Object.keys(candidatesByGarment)) {
    for (const c of candidatesByGarment[key]) {
      c.unitsSold = sold.get(c.sku) || 0;
      c.weeksCover = weeksOfCover({ qty: c.qty, unitsSold: c.unitsSold });
    }
  }

  const postcard = variants.find(v => v.sku === KIT_POSTCARD_SKU) || null;

  return { candidatesByGarment, postcard, size: wanted };
}

/**
 * The kit, resolved and ready to hand to a draft order.
 *
 * @returns { size, lines, picks, postcard, warnings }
 */
async function buildSampleKit({ size, colors = {}, now = new Date() } = {}) {
  const { candidatesByGarment, postcard, size: wanted } = await loadKitStock(size, { now });
  const picks = pickKitColors(candidatesByGarment, colors);

  const warnings = [];
  for (const p of picks) {
    if (p.status === 'unavailable') {
      warnings.push(`${p.garment.label}: ${p.reason} — it is not in this kit.`);
    } else if (p.status === 'no_healthy_option') {
      warnings.push(`${p.garment.label}: ${p.reason}. Sending ${p.chosen.variantTitle} at ${fmtCover(p.chosen.weeksCover)} of cover on ${p.chosen.qty} units.`);
    }
    if (colors[p.garment.key] && p.status !== 'forced') {
      warnings.push(`${p.garment.label}: requested colour "${colors[p.garment.key]}" does not exist in ${wanted} — the stock rule chose instead.`);
    }
  }
  if (!postcard) {
    warnings.push(`${KIT_POSTCARD_SKU} was not found in the catalog — the kit has no postcard.`);
  } else if (postcard.inventory_quantity != null && postcard.inventory_quantity < 1) {
    warnings.push(`${KIT_POSTCARD_SKU} is out of stock.`);
  }

  const lines = [];
  if (postcard) {
    lines.push({
      variantId: postcard.shopify_variant_id,
      sku: postcard.sku,
      label: 'Retail kit postcard',
      variantTitle: null,
      quantity: 1,
    });
  }
  for (const p of picks) {
    if (!p.chosen) continue;
    lines.push({
      variantId: p.chosen.variantId,
      sku: p.chosen.sku,
      label: p.garment.label,
      variantTitle: p.chosen.variantTitle,
      quantity: 1,
    });
  }

  return { size: wanted, lines, picks, postcard, warnings };
}

module.exports = {
  KIT_GARMENTS,
  KIT_POSTCARD_SKU,
  MIN_WEEKS_COVER,
  MIN_UNITS,
  SUBSTITUTION_MARGIN,
  SALES_WINDOW_DAYS,
  weeksOfCover,
  pickGarmentColor,
  pickKitColors,
  fmtCover,
  fetchUnitsSold,
  loadKitStock,
  buildSampleKit,
};
