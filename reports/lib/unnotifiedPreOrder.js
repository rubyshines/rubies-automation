/**
 * Unnotified pre-order — detection + auto-draft into CS Advisor.
 *
 * Background: a customer can buy an out-of-stock "continue selling" variant
 * without ever being told it's a pre-order. The most common cause is the
 * Shopify Shop App, which bypasses our custom theme and so never stamps line
 * items with the `Pre-order` customAttribute that the Pre-Order Now app applies
 * on the Online Store — but the detection is channel-agnostic (an Online Store
 * race condition produces the same signal). Either way the order sits
 * unfulfilled until inventory arrives and the customer is left uninformed.
 *
 * Detection signal (per-line-item):
 *   variant inventory ≤ 0
 *   AND no `Pre-order` customAttribute on the line item
 *   AND line item is unfulfilled
 *
 * Timing: an order becomes a candidate MIN_ORDER_AGE_MINUTES after it was
 * placed. Warehance allocates within minutes when stock exists (measured
 * 2026-07-29 across all 115 open orders: the youngest was already
 * ready_to_ship at 16 minutes, and not one order was unallocated while the
 * warehouse held stock for it). So "still unallocated after an hour" IS the
 * shortage signal, and waiting longer only delays an email the customer needs
 * as early as possible. This replaced a next-business-day-5pm-PT gate that was
 * built around the once-daily report cron and held outreach for up to two days.
 *
 * For each affected order we compose a per-case A/B/C draft (mirrors Naomi
 * outreach taxonomy) and seed it into CS Advisor via seedOutboundDraft().
 * Jamie reviews and sends from the dashboard. Idempotent via the
 * order_alert_notes table.
 *
 * Entry points:
 *   sweepUnnotifiedPreOrders(opts)
 *     - self-contained; loads its own candidates from the order mirror. Runs
 *       on the always-on webhook server every SWEEP_MS. This is the only
 *       writer — the daily report reads the notes it leaves behind.
 *   detectAndDraftUnnotifiedPreOrders(supabase, unfulfilledResults, opts)
 *     - takes pre-loaded results (used by the sweep and by tests).
 *   CLI: node reports/lib/unnotifiedPreOrder.js [--write]
 *     - default: dry-run print only; --write actually seeds drafts.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { seedOutboundDraft } = require('../../customer-service/lib/customerOutreach');
const productCache = require('../../customer-service/lib/productCache');
const {
  businessDaysSince,
  addBusinessDays,
  olderThanMinutes,
  UNALLOCATED_SHORTAGE_MINUTES,
} = require('../../shared/businessDays');
const { fetchOrderByNumber, fetchSkuStockMany } = require('./warehanceClient');
const { initCsConfig, getProductNickname } = require('../../customer-service/lib/sizingEngine');
const { executeToolCall } = require('../../customer-service/lib/aiAdvisor');
const { formatPreOrderDate } = require('../../customer-service/lib/preOrderAttrs');
const { normalizeSize, NUMERIC_TO_LETTER_UPPER, getVariantColor, extractSizeFromSku } = require('../../customer-service/lib/sizeUtils');
const { SIGNATURE_BLOCK_MD } = require('../../customer-service/lib/signatures');

const DELAY_ACKNOWLEDGE_DAYS = 3;
const MAX_ALTERNATIVES = 2;

const NOTE_PREFIX = '[auto-draft] Unnotified pre-order outreach drafted';
const SUBJECT = 'ACTION required on your recent RUBIES order';
// Swap-done drafts require no customer action, so no ACTION-required subject.
const SUBJECT_SWAPPED = 'Good news about your recent RUBIES order';
// These drafts are seeded into the dashboard and sent through the normal draft
// send path (autoLinkProducts turns the markdown link into a real <a>), so the
// markdown signature form is the correct one here — same as the advisor's.
const SIGNOFF = `Take care,\n\n${SIGNATURE_BLOCK_MD}`;
// Orders older than this with no existing notes get skipped — they predate
// the auto-drafter and likely need human review rather than fresh outreach.
const STALENESS_DAYS = 14;
// How long an order must sit before "still unallocated" counts as a shortage
// rather than normal warehouse ingestion + allocation lag. Shared with the
// daily order report's severity gate so the two can't drift apart.
const MIN_ORDER_AGE_MINUTES = UNALLOCATED_SHORTAGE_MINUTES;
// Sweep cadence on the webhook server. Well under MIN_ORDER_AGE_MINUTES so a
// candidate is picked up within a few minutes of becoming eligible.
const SWEEP_MS = 10 * 60 * 1000;
// Bound the mirror query — anything past STALENESS_DAYS is filtered out anyway.
const SWEEP_LOOKBACK_DAYS = STALENESS_DAYS;

const PRE_ORDER_TAG_RE = /pre-?order/i;

// Shopify order-level pre-order tag. Belt-and-braces over the per-line-item
// `Pre-order` customAttribute: the attribute is the precise signal (it says
// WHICH item was sold as a pre-order), but if it is ever missing from the
// mirror while the order carries the tag, the customer was still told. Skipping
// is the safe direction — a missed leak is a quiet follow-up, a wrong leak
// email tells a pre-order customer their order has a problem it doesn't have.
function isPreOrderByTags(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => PRE_ORDER_TAG_RE.test(String(t)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasPreOrderAttr(customAttributes) {
  if (!Array.isArray(customAttributes)) return false;
  return customAttributes.some(a => typeof a?.key === 'string' && /^pre-?order$/i.test(a.key));
}

function renderItem(li) {
  return productCache.renderVariantForCustomer(li.sku)
    || `the ${(li.title || '').replace(/^THE\s+/i, '')}${li.variant_title ? ` (${li.variant_title})` : ''}`;
}

function capitalizeFirst(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function plainToHtml(plain) {
  const lines = plain.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${escapeHtml(line.slice(2))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim() === '') html += '';
      else html += `<p>${escapeHtml(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Classification — A / B / C
// ---------------------------------------------------------------------------
//
// A: every paid line item in the order is a leak (or the rest are freebies)
// B: leak items + at least one other paid item that is in stock
// C: leak items + at least one other paid item that is also out of stock
//    (other-backorder — the order won't ship even without the leak)

const ZERO_PRICE_FREEBIE_SKUS = new Set(['MESSAGECARD', 'RUBIESPOSTCARDS', 'VINYLSTICKER']);

function isPaidLineItem(li) {
  if (ZERO_PRICE_FREEBIE_SKUS.has(li.sku)) return false;
  if (Number(li.unit_price ?? li.price ?? 0) <= 0) return false;
  return true;
}

function classifyOrder(lineItems, variantStateBySku) {
  const leaks = [];
  const inStockOther = [];
  const oosOther = [];
  for (const li of lineItems) {
    if (!isPaidLineItem(li)) continue;
    if (!li.sku) continue;
    const state = variantStateBySku.get(li.sku);
    if (!state) continue;
    const inv = state.inventory_quantity ?? 0;
    const hasAttr = hasPreOrderAttr(li.custom_attributes);
    const isLeak = inv <= 0 && !hasAttr;
    if (isLeak) {
      leaks.push({ ...li, _variant: state });
    } else if (inv <= 0) {
      oosOther.push({ ...li, _variant: state });
    } else {
      inStockOther.push({ ...li, _variant: state });
    }
  }
  if (leaks.length === 0) return null;
  let caseLabel;
  if (inStockOther.length === 0 && oosOther.length === 0) caseLabel = 'A';
  else if (oosOther.length > 0) caseLabel = 'C';
  else caseLabel = 'B';
  return { case: caseLabel, leaks, inStockOther, oosOther };
}

// Keep only candidates whose specific Warehance order is not ready to ship
// (ready_to_ship === false). This is the authoritative per-order signal from the
// warehouse: an order in_progress or fully allocated will have ready_to_ship true
// and should not receive outreach. Orders not found in Warehance are skipped.
//
// A cancelled or already-fulfilled order also reports ready_to_ship === false,
// so those are excluded explicitly. The mirror's open/closed state drifts (the
// order sync only pulls open orders, so a missed fulfillment webhook never
// self-heals), which means a shipped order can still look unfulfilled upstream
// of here — Warehance is the arbiter, and it says so in not_ready_to_ship_types.
function filterToNotReadyToShip(candidates, warehanceOrders) {
  return candidates.filter(c => {
    const orderNum = String(c.order.order_number).replace('#', '');
    const whOrder = warehanceOrders.get(orderNum);
    if (!whOrder) return false;
    if (whOrder.ready_to_ship !== false) return false;
    if (whOrder.cancelled) return false;
    const types = whOrder.not_ready_to_ship_types || {};
    if (types.order_cancelled || types.order_is_already_fulfilled) return false;
    return true;
  });
}

// Re-verify every Shopify-flagged item against physical warehouse stock.
// Shopify "available" is net of allocations, so an item whose unit(s) are
// already allocated to THIS order reads 0 on the website while sitting at the
// warehouse ready to ship. The ready_to_ship gate above is order-level and
// can't tell WHICH item blocks the order — a mixed order (one allocated item +
// one genuine backorder) passes the gate and the allocated item wears the
// blame. Warehouse-covered items reclassify as in-stock and the A/B/C case is
// recomputed; an order whose every leak turns out to be allocated returns null
// (no outreach). SKUs with no warehouse data keep their Shopify verdict.
//
// The test is `available < qty AND backordered > 0`, and it needs both halves:
//
//   available alone is wrong — a unit allocated to THIS order makes available
//   read 0, which is the #32601 case (Sky on hand and allocated to the order,
//   other items genuinely backordered). Blaming Sky there emails the customer
//   about an item that was about to ship.
//
//   on_hand alone (the previous test) is wrong the other way — it can't see
//   that the unit on the shelf is spoken for by a DIFFERENT order, which is
//   the #32715 case (on_hand 1, allocated 1, available 0, backordered 1). That
//   silently dropped 6 of 111 open orders when measured 2026-07-29.
//
// backordered separates them: Warehance only records backordered demand it
// cannot meet, so an item already allocated to this order is never backordered.
// Measured against Warehance's own ready_to_ship verdict across all 111
// non-held open orders, this test agrees on every one.
function reclassifyWithWarehouseStock(classification, stockBySku) {
  const genuinelyOOS = (li) => {
    const wh = stockBySku.get(li.sku);
    if (!wh) return true; // no warehouse data — trust the Shopify signal
    const qty = Number(li.quantity ?? 1) || 1;
    return (wh.available ?? 0) < qty && (wh.backordered ?? 0) > 0;
  };
  const leaks = [];
  const inStockOther = [...classification.inStockOther];
  const oosOther = [];
  for (const li of classification.leaks) (genuinelyOOS(li) ? leaks : inStockOther).push(li);
  for (const li of classification.oosOther) (genuinelyOOS(li) ? oosOther : inStockOther).push(li);
  if (!leaks.length) return null;
  const caseLabel = oosOther.length > 0 ? 'C' : inStockOther.length > 0 ? 'B' : 'A';
  return { case: caseLabel, leaks, inStockOther, oosOther };
}

// ---------------------------------------------------------------------------
// Body templates
// ---------------------------------------------------------------------------

function bestETA(leaks) {
  // Latest target date across the leak items, formatted human-friendly.
  const dates = leaks.map(li => li._variant?.pre_order_date).filter(Boolean).sort();
  if (!dates.length) return null;
  return formatPreOrderDate(dates[dates.length - 1]);
}

function leakItemsPhrase(leaks) {
  return joinList(leaks.map(renderItem));
}

function apologyLine(daysSinceOrder) {
  const base = 'Sorry for the mixup';
  if (daysSinceOrder >= DELAY_ACKNOWLEDGE_DAYS) {
    return `${base}, and apologies for the delay reaching out — I only just caught this while reviewing orders.`;
  }
  return `${base}.`;
}

function swapBullet(alternatives) {
  if (!alternatives.length) return null;
  const list = alternatives.join(' or ');
  const stockTag = alternatives.length > 1 ? '(both in stock)' : '(in stock)';
  return `- Swap for ${list} ${stockTag}, or another color, size, or style if you have one in mind.`;
}

function bodyCaseA({ orderNumber, leakPhrase, eta, plural, alternatives, apology }) {
  const verb = plural ? 'are' : 'is';
  const etaSentence = eta
    ? `Our inventory got out of sync, but we have more arriving ${eta}.`
    : `Our inventory got out of sync and we don't have a firm restock date yet.`;
  const holdLine = eta
    ? `- Hold the order and ship as soon as the new stock arrives (${eta}).`
    : `- Hold the order and ship as soon as the new stock arrives.`;
  const swap = swapBullet(alternatives);
  const bullets = [holdLine, swap, '- Cancel the order and refund you in full.'].filter(Boolean).join('\n');
  return `Hi,

I'm writing about your RUBIES order #${orderNumber}. ${capitalizeFirst(leakPhrase)} you ordered ${verb} on pre-order. ${etaSentence} ${apology}

Here's what I can do:

${bullets}

Just reply and let me know what works best.

${SIGNOFF}`;
}

function bodyCaseB({ orderNumber, leakPhrase, eta, plural, alternatives, apology }) {
  const verb = plural ? 'are' : 'is';
  const etaSentence = eta
    ? `Our inventory got out of sync, but we have more arriving ${eta}.`
    : `Our inventory got out of sync and we don't have a firm restock date yet.`;
  const splitLine = eta
    ? `- Ship the in-stock items right away and ship the pre-order items separately when the new stock arrives (${eta}).`
    : `- Ship the in-stock items right away and ship the pre-order items separately when the new stock arrives.`;
  const swap = swapBullet(alternatives);
  const bullets = [
    splitLine,
    '- Hold everything and ship together when the new stock arrives.',
    swap,
    '- Refund just the pre-order items and ship the rest right away.',
  ].filter(Boolean).join('\n');
  return `Hi,

I'm writing about your RUBIES order #${orderNumber}. ${capitalizeFirst(leakPhrase)} you ordered ${verb} on pre-order. ${etaSentence} Your other items are good to go. ${apology}

Here's what I can do:

${bullets}

Just reply and let me know what works best.

${SIGNOFF}`;
}

function bodyCaseC({ orderNumber, leakPhrase, eta, otherPhrase, plural, alternatives, apology }) {
  const verb = plural ? 'are' : 'is';
  const etaSentence = eta
    ? `Our inventory got out of sync, but we have more arriving ${eta}.`
    : `Our inventory got out of sync and we don't have a firm restock date yet.`;
  const otherSentence = otherPhrase
    ? `Your other items (${otherPhrase}) are also on backorder, so the full order wouldn't ship until restock either way.`
    : `Other items on the order are also on backorder, so the full order wouldn't ship until restock either way.`;
  const swap = swapBullet(alternatives);
  const bullets = [
    '- Hold the order and ship when everything\'s in stock.',
    swap,
    '- Refund just the pre-order items so the rest can ship as soon as the other backorder resolves.',
  ].filter(Boolean).join('\n');
  return `Hi,

I'm writing about your RUBIES order #${orderNumber}. ${capitalizeFirst(leakPhrase)} you ordered ${verb} on pre-order. ${etaSentence} ${otherSentence} ${apology}

Here's what I can do for the pre-order items specifically:

${bullets}

Just reply and let me know what works best.

${SIGNOFF}`;
}

// "Done for you" variant: every leak was swapped to its identical-fit
// youth/adult equivalent, so the email informs rather than asks. The swapped
// size IS the ordered garment (identical fit), so there is no "wait for the
// original" offer and no opt-out paragraph at all (a straight swap needs no
// menu), the fit equivalence is stated exactly once, and price is never
// mentioned (findEquivalentSwap already guarantees same price).
function bodySwapDone({ orderNumber, leakPhrase, plural, swaps, apology }) {
  const verb = plural ? 'are' : 'is';
  const swapFacts = joinList(swaps.map(s =>
    `size ${s.toSize} on our ${s.chart} size chart is the exact same fit as the ${s.fromSize}`));
  const stockVerb = swaps.length > 1 ? "they're" : "it's";
  const swapActions = joinList(swaps.map(s => `your ${s.nickname} to ${s.color}, size ${s.toSize}`));
  return `Hi,

I'm writing about your RUBIES order #${orderNumber}. ${capitalizeFirst(leakPhrase)} you ordered ${verb} on pre-order. Our inventory got out of sync. ${apology}

Good news: ${swapFacts}, and ${stockVerb} in stock. So I went ahead and swapped ${swapActions}, and your full order can now ship right away.

${SIGNOFF}`;
}

function composeBody({ orderNumber, classification, alternatives = [], autoSwaps = [], daysSinceOrder = 0 }) {
  const leakPhrase = leakItemsPhrase(classification.leaks);
  const eta = bestETA(classification.leaks);
  const plural = classification.leaks.length > 1;
  const apology = apologyLine(daysSinceOrder);
  if (autoSwaps.length) return bodySwapDone({ orderNumber, leakPhrase, plural, swaps: autoSwaps, apology });
  if (classification.case === 'A') return bodyCaseA({ orderNumber, leakPhrase, eta, plural, alternatives, apology });
  if (classification.case === 'B') return bodyCaseB({ orderNumber, leakPhrase, eta, plural, alternatives, apology });
  const otherPhrase = joinList(classification.oosOther.map(renderItem));
  return bodyCaseC({ orderNumber, leakPhrase, eta, otherPhrase, plural, alternatives, apology });
}

// ---------------------------------------------------------------------------
// Detection — load variants needed and walk the unfulfilled results
// ---------------------------------------------------------------------------

async function loadVariantStateBySku(supabase, skus) {
  const result = new Map();
  if (!skus.length) return result;
  const unique = [...new Set(skus)];
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200);
    const { data, error } = await supabase
      .from('product_variants')
      .select('sku, shopify_product_id, inventory_quantity, pre_order_incoming, pre_order_date')
      .in('sku', batch);
    if (error) throw new Error(`product_variants lookup failed: ${error.message}`);
    for (const v of (data || [])) result.set(v.sku, v);
  }
  return result;
}

// Extract the customer-ordered size from a RUBIES SKU. Format is
// <product>-<color>-<size> (or <product>-<size> for size-only items).
// Resolve a leak's nickname, size, and color by walking the product cache.
// Returns { nickname, size, displaySize, color } or null if we can't classify
// the SKU.
//
// `size` is the raw SKU segment and is what SKU construction and catalog
// lookups need. `displaySize` is the customer-facing label and is the ONLY one
// that may appear in an email: RUBIES plus sizes are always written 1X/2X/3X/4X,
// never XL/2XL, which is how the variant titles read on the site and on the
// order. SKUs spell the same size XL, so anything rendering the raw segment
// tells the customer a size name we do not use (2026-07-29: a swap bullet
// offered "the Mia in Pink, size XL" on an order whose own line said 1X).
// extractSizeFromSku is the shared normalizer the rest of the codebase already
// routes through — contextBuilder feeds the advisor its `normalized` value,
// which is why advisor-written prose gets this right.
function leakHandle(leakSku) {
  const variant = productCache.getVariantBySku(leakSku);
  if (!variant) return null;
  const nickname = getProductNickname(variant.productTitle);
  if (!nickname || nickname === 'item') return null;
  const color = getVariantColor({ selectedOptions: variant.options || [] });
  const { raw, normalized } = extractSizeFromSku(leakSku);
  return { nickname, size: raw, displaySize: normalized || raw, color };
}

/** Adult letter → youth numeric equivalent (inverse of NUMERIC_TO_LETTER_UPPER). */
const LETTER_TO_NUMERIC = Object.fromEntries(
  Object.entries(NUMERIC_TO_LETTER_UPPER).map(([num, letter]) => [letter, num]),
);

// Youth/adult equivalent of a size token (adult S = youth 14, M = 16, XS = 12),
// or null when none exists (youth tops out at 16 = M; adult L+ has no youth twin).
function equivalentSize(size) {
  const norm = normalizeSize(size);
  if (!norm) return null;
  return NUMERIC_TO_LETTER_UPPER[norm] || LETTER_TO_NUMERIC[norm] || null;
}

// Find the youth/adult identical-fit swap target for a leak SKU: same product,
// same color, equivalent size, in stock, same price. Same-price is a hard gate:
// some products price youth and adult tiers differently, and a price delta
// can't ride a "we already did this for you" email. Returns
// { fromSku, toSku, nickname, color, fromSize, toSize, chart, rendered } or null.
async function findEquivalentSwap(leakSku) {
  const meta = leakHandle(leakSku);
  if (!meta) return null;
  const { nickname, size, displaySize, color } = meta;
  if (!size || !color) return null;
  const eqSize = equivalentSize(size);
  if (!eqSize) return null;

  // Target SKU: same product+color segments, equivalent size as last segment.
  const parts = String(leakSku).split('-');
  parts[parts.length - 1] = eqSize;
  const targetSku = parts.join('-');
  const source = productCache.getVariantBySku(leakSku);
  const target = productCache.getVariantBySku(targetSku);
  if (!source || !target) return null;
  if (Number(target.price) !== Number(source.price)) return null;

  let eq;
  try {
    eq = await executeToolCall('compare_products', { product: nickname, size: eqSize });
  } catch { return null; }
  const colorHit = (eq?.source?.available_colors || [])
    .find(c => (c.color || '').toLowerCase() === color);
  if (!colorHit || (colorHit.inventory ?? 0) <= 0) return null;

  const chart = /^\d/.test(eqSize) ? 'youth' : 'adult';
  return {
    fromSku: source.sku,
    toSku: target.sku,
    nickname,
    color: colorHit.color,
    fromSize: displaySize,
    toSize: eqSize,
    chart,
    rendered: `the ${nickname} in ${colorHit.color}, size ${eqSize} (our ${chart} size with the same fit as ${displaySize})`,
  };
}

// Build up to MAX_ALTERNATIVES rendered swap suggestions for one leak SKU,
// using the advisor's `compare_products` tool. Precedence per the advisor's
// pre-order playbook (aiAdvisor.js): youth/adult equivalent size in the
// customer's own color first (identical fit), then sibling colors of the same
// product, then a different product in the same size.
async function pickAlternativesViaCompare(leakSku) {
  const meta = leakHandle(leakSku);
  if (!meta) return [];
  const { nickname, size, displaySize } = meta;
  if (!size) return [];

  const rendered = [];

  // Tier 0: youth/adult equivalent size, same color — identical fit, so it
  // beats a color change. Best-effort: any miss falls through to same-size tiers.
  const eqSwap = await findEquivalentSwap(leakSku);
  if (eqSwap) rendered.push(eqSwap.rendered);

  let comparison;
  try {
    comparison = await executeToolCall('compare_products', { product: nickname, size });
  } catch {
    return rendered;
  }
  if (!comparison || comparison.error) return rendered;

  // Tier 1: same product, in-stock sibling colors at the customer's size.
  // Rendered with displaySize, never the raw SKU segment — see leakHandle.
  for (const c of (comparison.source?.available_colors || [])) {
    if (rendered.length >= MAX_ALTERNATIVES) break;
    rendered.push(`the ${nickname} in ${c.color}, size ${displaySize}`);
  }
  // Tier 2: different products in same category, same size, with stock.
  for (const alt of (comparison.alternatives || [])) {
    if (rendered.length >= MAX_ALTERNATIVES) break;
    rendered.push(`the ${alt.product}, size ${displaySize}`);
  }
  return rendered;
}

async function fetchOrdersWithUnresolvedNotes(supabase, orderNumbers) {
  if (!orderNumbers.length) return new Set();
  const { data, error } = await supabase
    .from('order_alert_notes')
    .select('order_number, note, resolved')
    .in('order_number', orderNumbers.map(n => parseInt(String(n).replace('#', ''), 10)));
  if (error) throw new Error(`order_alert_notes lookup failed: ${error.message}`);
  // Skip if: any unresolved note (ours or another pipeline's, e.g. Naomi
  // outreach) means the order is already in someone's queue; OR the order was
  // EVER auto-drafted, even if that note has since been resolved (note
  // lifecycle resolves notes when the conversation closes — that must never
  // re-trigger a second outreach to the same customer).
  return new Set(
    (data || [])
      .filter(n => !n.resolved || (n.note || '').startsWith(NOTE_PREFIX) || (n.note || '').startsWith('[auto-draft]'))
      .map(n => n.order_number),
  );
}

async function detectUnnotifiedPreOrders(supabase, unfulfilledResults) {
  const orders = unfulfilledResults.map(r => r.order);

  // Collect all SKUs across all unfulfilled orders to do one bulk variant lookup.
  const allSkus = [];
  for (const o of orders) {
    for (const li of (o.order_line_items || [])) {
      if (li.sku) allSkus.push(li.sku);
    }
  }
  const variantStateBySku = await loadVariantStateBySku(supabase, allSkus);

  const staleCutoff = Date.now() - STALENESS_DAYS * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const r of unfulfilledResults) {
    const o = r.order;
    // Skip orders older than STALENESS_DAYS (predate the auto-drafter).
    if (o.created_at && new Date(o.created_at).getTime() < staleCutoff) continue;
    // Skip orders too fresh to distinguish a shortage from allocation lag
    // (and orders with no usable created_at — olderThanMinutes fails closed).
    if (!olderThanMinutes(o.created_at, MIN_ORDER_AGE_MINUTES)) continue;
    // Skip orders Shopify tagged as pre-orders — the customer was told.
    if (isPreOrderByTags(o.tags)) continue;
    const classification = classifyOrder(o.order_line_items || [], variantStateBySku);
    if (!classification) continue;
    candidates.push({ order: o, classification });
  }

  if (!candidates.length) return [];

  const existing = await fetchOrdersWithUnresolvedNotes(supabase, candidates.map(c => c.order.order_number));
  const fresh = candidates.filter(c => {
    const n = parseInt(String(c.order.order_number).replace('#', ''), 10);
    return !existing.has(n);
  });

  if (!fresh.length) return [];

  // Look up each candidate in Warehance by order number and keep only those
  // where ready_to_ship === false. Per-order fetch (not a bulk paginated pull)
  // so we only call the API for the small set of candidates that made it here.
  // Individual fetch failures are logged and treated as "skip" (unknown state).
  const orderEntries = await Promise.all(fresh.map(async c => {
    const orderNum = String(c.order.order_number).replace('#', '');
    try {
      const whOrder = await fetchOrderByNumber(orderNum);
      return [orderNum, whOrder];
    } catch (e) {
      console.warn(`[unnotifiedPreOrder] Warehance lookup failed for #${orderNum}: ${e.message}`);
      return [orderNum, null];
    }
  }));
  const warehanceOrders = new Map(orderEntries);
  const notReady = filterToNotReadyToShip(fresh, warehanceOrders);

  if (!notReady.length) return [];

  // Per-item warehouse verification (see reclassifyWithWarehouseStock). If the
  // stock lookup fails, skip outreach this run rather than risk false
  // positives — same posture as the per-order lookup above.
  let stockBySku;
  try {
    const flaggedSkus = notReady.flatMap(c =>
      [...c.classification.leaks, ...c.classification.oosOther].map(li => li.sku));
    stockBySku = await fetchSkuStockMany(flaggedSkus);
  } catch (e) {
    console.warn(`[unnotifiedPreOrder] Warehance stock lookup failed — skipping outreach this run: ${e.message}`);
    return [];
  }
  const verified = [];
  for (const c of notReady) {
    const reclassified = reclassifyWithWarehouseStock(c.classification, stockBySku);
    if (reclassified) verified.push({ ...c, classification: reclassified });
  }

  if (!verified.length) return [];

  // Attach swap data per order. Done-for-you swap: when EVERY leak has an
  // in-stock, same-price, identical-fit youth/adult equivalent in the ordered
  // color AND the swap unblocks the whole order (cases A/B), the outreach
  // states the swap as already made and stages the order edit as the draft's
  // paired operator action. Case C keeps the options email — other items are
  // still backordered, so the swap wouldn't unblock shipping and the
  // customer's choice matters more. Otherwise: rendered alternatives for the
  // options email.
  for (const c of verified) {
    if (c.classification.case !== 'C') {
      const swaps = [];
      for (const li of c.classification.leaks) {
        const s = await findEquivalentSwap(li.sku);
        if (!s) { swaps.length = 0; break; }
        swaps.push(s);
      }
      if (swaps.length) {
        c.autoSwaps = swaps;
        c.alternatives = [];
        continue;
      }
    }
    const perLeakAlts = [];
    for (const li of c.classification.leaks) {
      const alts = await pickAlternativesViaCompare(li.sku);
      perLeakAlts.push(...alts);
    }
    c.alternatives = [...new Set(perLeakAlts)].slice(0, MAX_ALTERNATIVES);
  }
  return verified;
}

// ---------------------------------------------------------------------------
// Draft seeding — turn detected leaks into pending CS Advisor drafts
// ---------------------------------------------------------------------------

async function draftLeakOutreach({ leaks, write = false }) {
  const results = [];
  for (const { order, classification, alternatives = [], autoSwaps = [] } of leaks) {
    const orderNumber = String(order.order_number).replace('#', '');
    const daysSinceOrder = order.created_at ? businessDaysSince(order.created_at) || 0 : 0;
    const plain = composeBody({ orderNumber, classification, alternatives, autoSwaps, daysSinceOrder });
    const html = plainToHtml(plain);
    const swapped = autoSwaps.length > 0;
    const summary = `Unnotified pre-order (Case ${classification.case}) — ${classification.leaks.length} pre-order item${classification.leaks.length > 1 ? 's' : ''}${swapped ? '; identical-fit swap staged' : ''}`;
    const noteText = `${NOTE_PREFIX} — awaiting send/customer choice (Case ${classification.case})`;
    // The swap-done email states the swap as already made, so the order edit is
    // staged as the draft's paired operator action (Execute & Send runs the
    // action before the send, keeping the past tense true).
    const operatorActionSummary = swapped
      ? `Order #${orderNumber}: swap ${joinList(autoSwaps.map(s => `${s.fromSku} to ${s.toSku}`))} via edit_order (identical-fit ${joinList([...new Set(autoSwaps.map(s => s.chart))])} equivalent, in stock, same price). The outreach email states the swap is already done, so execute the swap before sending.`
      : null;

    if (!write) {
      results.push({ order_number: orderNumber, case: classification.case, status: 'dry_run', summary });
      continue;
    }

    try {
      const seeded = await seedOutboundDraft({
        orderNumber,
        customerEmail: order.customer_email,
        customerName: null,
        subject: swapped ? SUBJECT_SWAPPED : SUBJECT,
        plainBody: plain,
        htmlBody: html,
        summary,
        steer: `Auto-drafted unnotified pre-order outreach. Case ${classification.case}.${swapped ? ' Identical-fit swap staged as operator action.' : ''}`,
        noteText,
        author: 'auto',
        actionType: swapped ? 'order_modification' : null,
        operatorActionSummary,
      });
      results.push({
        order_number: orderNumber,
        case: classification.case,
        status: seeded.ok ? 'drafted' : 'failed',
        cs_ticket_id: seeded.cs_ticket_id || null,
        cs_draft_id: seeded.cs_draft_id || null,
        error: seeded.ok ? null : seeded.error,
        summary,
      });
    } catch (err) {
      results.push({ order_number: orderNumber, case: classification.case, status: 'failed', error: err.message, summary });
    }
  }
  return results;
}

async function detectAndDraftUnnotifiedPreOrders(supabase, unfulfilledResults, { write = false } = {}) {
  await productCache.loadFromSupabase();
  try { await initCsConfig(); } catch (e) { console.warn(`[unnotifiedPreOrder] initCsConfig: ${e.message}`); }
  const leaks = await detectUnnotifiedPreOrders(supabase, unfulfilledResults);
  if (!leaks.length) return { drafted: [], skipped: 0 };
  const results = await draftLeakOutreach({ leaks, write });
  return { drafted: results, skipped: 0 };
}

// ---------------------------------------------------------------------------
// Sweep — self-contained candidate loading for the always-on webhook server
// ---------------------------------------------------------------------------

/**
 * Load recent unfulfilled orders straight from the mirror, in the
 * `[{ order }]` shape detectUnnotifiedPreOrders expects.
 *
 * Deliberately NOT checkUnfulfilledOrders(): that path also runs batched
 * Shopify GraphQL calls (with sleeps between batches), an inventory-snapshot
 * join and a notes pass to build the daily report, which is far too heavy to
 * run every SWEEP_MS. Everything the drafter needs it re-derives from live
 * sources anyway — Warehance for order and per-SKU truth, product_variants for
 * inventory, order_alert_notes for idempotence. Mirror staleness is safe here
 * because it can only over-supply candidates, and every one is re-verified
 * against live Warehance before a draft is seeded.
 */
async function loadRecentUnfulfilledOrders(supabase, { lookbackDays = SWEEP_LOOKBACK_DAYS } = {}) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const results = [];
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('orders')
      .select('order_number, created_at, customer_email, tags, fulfillment_status, cancelled_at, order_line_items(sku, title, variant_title, quantity, unit_price, custom_attributes)')
      .gte('created_at', since)
      .is('cancelled_at', null)
      .neq('fulfillment_status', 'FULFILLED')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`orders lookup failed: ${error.message}`);
    for (const o of (data || [])) results.push({ order: o });
    if (!data || data.length < PAGE) break;
  }
  return results;
}

/**
 * One sweep tick: find unnotified pre-order leaks among recent unfulfilled
 * orders and seed drafts for them. Idempotent (order_alert_notes) and normally
 * a no-op — a leak is rare. Safe to call on a timer.
 */
async function sweepUnnotifiedPreOrders({ write = true, supabase = null } = {}) {
  const sb = supabase || getSupabaseClient();
  const candidates = await loadRecentUnfulfilledOrders(sb);
  if (!candidates.length) return { drafted: [], skipped: 0 };
  return detectAndDraftUnnotifiedPreOrders(sb, candidates, { write });
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const write = process.argv.includes('--write');
    const ordersArg = process.argv.find(a => a.startsWith('--orders='));
    const orderFilter = ordersArg
      ? new Set(ordersArg.slice('--orders='.length).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite))
      : null;
    const { checkUnfulfilledOrders } = require('./unfulfilled');
    const supabase = getSupabaseClient();
    console.log(`Unnotified pre-order detection — ${write ? 'LIVE (will seed drafts)' : 'dry run (no writes)'}${orderFilter ? ` — filter: ${[...orderFilter].join(',')}` : ''}\n`);
    const uf = await checkUnfulfilledOrders();
    const filtered = orderFilter
      ? uf.results.filter(r => orderFilter.has(parseInt(String(r.order.order_number).replace('#', ''), 10)))
      : uf.results;
    const { drafted } = await detectAndDraftUnnotifiedPreOrders(supabase, filtered, { write });
    if (!drafted.length) {
      console.log('No unnotified pre-order candidates found.');
      return;
    }
    for (const r of drafted) {
      const tag = r.status === 'drafted' ? `✅ #${r.cs_ticket_id}` : r.status === 'dry_run' ? '(dry)' : `FAIL: ${r.error}`;
      console.log(`  #${r.order_number}  Case ${r.case}  ${tag}`);
      console.log(`    ${r.summary}`);
    }
    console.log(`\nTotal: ${drafted.length} ${write ? 'drafted' : 'would-be drafts'}`);
  })().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = {
  detectUnnotifiedPreOrders,
  detectAndDraftUnnotifiedPreOrders,
  sweepUnnotifiedPreOrders,
  loadRecentUnfulfilledOrders,
  classifyOrder,
  filterToNotReadyToShip,
  reclassifyWithWarehouseStock,
  isPreOrderByTags,
  olderThanMinutes,
  MIN_ORDER_AGE_MINUTES,
  SWEEP_MS,
  composeBody,
  pickAlternativesViaCompare,
  findEquivalentSwap,
  formatPreOrderDate,
  hasPreOrderAttr,
  NOTE_PREFIX,
};
