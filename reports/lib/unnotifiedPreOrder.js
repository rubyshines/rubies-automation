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
 * For each affected order we compose a per-case A/B/C draft (mirrors Naomi
 * outreach taxonomy) and seed it into CS Advisor via seedOutboundDraft().
 * Jamie reviews and sends from the dashboard. Idempotent via the
 * order_alert_notes table.
 *
 * Entry points:
 *   detectAndDraftUnnotifiedPreOrders(supabase, unfulfilledResults, opts)
 *     - cron-callable; returns { drafted, skipped }.
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
const { businessDaysSince, addBusinessDays } = require('../../shared/businessDays');
const { fetchOrderByNumber } = require('./warehanceClient');
const { initCsConfig, getProductNickname } = require('../../customer-service/lib/sizingEngine');
const { executeToolCall } = require('../../customer-service/lib/aiAdvisor');

const DELAY_ACKNOWLEDGE_DAYS = 3;
const MAX_ALTERNATIVES = 2;

const NOTE_PREFIX = '[auto-draft] Unnotified pre-order outreach drafted';
const SUBJECT = 'ACTION required on your recent RUBIES order';
const SIGNOFF = 'Take care,\nJamie Alexander\nRUBIES Founder';
// Orders older than this with no existing notes get skipped — they predate
// the auto-drafter and likely need human review rather than fresh outreach.
const STALENESS_DAYS = 14;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasPreOrderAttr(customAttributes) {
  if (!Array.isArray(customAttributes)) return false;
  return customAttributes.some(a => typeof a?.key === 'string' && /^pre-?order$/i.test(a.key));
}

function formatPreOrderDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const position = day <= 10 ? 'beginning of' : day <= 20 ? 'middle of' : 'end of';
  return `${position} ${month}, ${year}`;
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

// Returns true if the shipping deadline for an order has passed: 5pm Pacific
// Time on the next business day (US holidays + weekends) after the order date.
// Orders not yet past their deadline are still expected to ship normally.
function pastNextBusinessDay5pmPT(orderDateStr) {
  const orderDate = new Date(orderDateStr);

  // Resolve the order's calendar date in Pacific Time.
  const ptDateStr = orderDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const [y, m, d] = ptDateStr.split('-').map(Number);

  // Advance to the next business day (skips weekends + US federal holidays).
  const ptDateLocal = new Date(y, m - 1, d);
  const nextBizDay = addBusinessDays(ptDateLocal, 1);

  // Construct 5pm Pacific on that day — try PDT (UTC-7) then PST (UTC-8).
  const nbY = nextBizDay.getFullYear();
  const nbM = String(nextBizDay.getMonth() + 1).padStart(2, '0');
  const nbD = String(nextBizDay.getDate()).padStart(2, '0');
  const nextBizDateStr = `${nbY}-${nbM}-${nbD}`;
  let deadline;
  for (const off of ['-07:00', '-08:00']) {
    const t = new Date(`${nextBizDateStr}T17:00:00${off}`);
    const ptH = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
    }).format(t));
    if (ptH === 17) { deadline = t; break; }
  }
  if (!deadline) deadline = new Date(`${nextBizDateStr}T17:00:00-08:00`);
  return Date.now() > deadline.getTime();
}

// Keep only candidates whose specific Warehance order is not ready to ship
// (ready_to_ship === false). This is the authoritative per-order signal from the
// warehouse: an order in_progress or fully allocated will have ready_to_ship true
// and should not receive outreach. Orders not found in Warehance are skipped.
function filterToNotReadyToShip(candidates, warehanceOrders) {
  return candidates.filter(c => {
    const orderNum = String(c.order.order_number).replace('#', '');
    const whOrder = warehanceOrders.get(orderNum);
    if (!whOrder) return false;
    return whOrder.ready_to_ship === false;
  });
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

function composeBody({ orderNumber, classification, alternatives = [], daysSinceOrder = 0 }) {
  const leakPhrase = leakItemsPhrase(classification.leaks);
  const eta = bestETA(classification.leaks);
  const plural = classification.leaks.length > 1;
  const apology = apologyLine(daysSinceOrder);
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
function skuSize(sku) {
  const parts = String(sku || '').split('-');
  if (parts.length >= 2) return parts[parts.length - 1];
  return null;
}

// Resolve a leak's nickname + size by walking the product cache.
// Returns { nickname, size } or null if we can't classify the SKU.
function leakHandle(leakSku) {
  const variant = productCache.getVariantBySku(leakSku);
  if (!variant) return null;
  const nickname = getProductNickname(variant.productTitle);
  if (!nickname || nickname === 'item') return null;
  return { nickname, size: skuSize(leakSku) };
}

// Build up to MAX_ALTERNATIVES rendered swap suggestions for one leak SKU,
// using the advisor's `compare_products` tool. Precedence per the advisor's
// pre-order playbook (aiAdvisor.js): sibling color of the same product first,
// then a different product in the same size.
async function pickAlternativesViaCompare(leakSku) {
  const meta = leakHandle(leakSku);
  if (!meta) return [];
  const { nickname, size } = meta;
  if (!size) return [];

  let comparison;
  try {
    comparison = await executeToolCall('compare_products', { product: nickname, size });
  } catch {
    return [];
  }
  if (!comparison || comparison.error) return [];

  const rendered = [];
  // Tier 1: same product, in-stock sibling colors at the customer's size.
  for (const c of (comparison.source?.available_colors || [])) {
    if (rendered.length >= MAX_ALTERNATIVES) break;
    rendered.push(`the ${nickname} in ${c.color}, size ${size}`);
  }
  // Tier 2: different products in same category, same size, with stock.
  for (const alt of (comparison.alternatives || [])) {
    if (rendered.length >= MAX_ALTERNATIVES) break;
    rendered.push(`the ${alt.product}, size ${size}`);
  }
  return rendered;
}

async function fetchOrdersWithUnresolvedNotes(supabase, orderNumbers) {
  if (!orderNumbers.length) return new Set();
  const { data, error } = await supabase
    .from('order_alert_notes')
    .select('order_number, note')
    .in('order_number', orderNumbers.map(n => parseInt(String(n).replace('#', ''), 10)))
    .eq('resolved', false);
  if (error) throw new Error(`order_alert_notes lookup failed: ${error.message}`);
  // Any unresolved note (ours or another pipeline's, e.g. Naomi outreach) means
  // the order is already in someone's queue. Skip it to stay idempotent.
  return new Set((data || []).map(n => n.order_number));
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
    // Skip orders not yet past their shipping deadline (next business day 5pm PT).
    // An order that's still within its window is expected to ship normally.
    if (o.created_at && !pastNextBusinessDay5pmPT(o.created_at)) continue;
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
  const verified = filterToNotReadyToShip(fresh, warehanceOrders);

  if (!verified.length) return [];

  // Attach swap alternatives per leak via the advisor's compare_products tool.
  for (const c of verified) {
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
  for (const { order, classification, alternatives = [] } of leaks) {
    const orderNumber = String(order.order_number).replace('#', '');
    const daysSinceOrder = order.created_at ? businessDaysSince(order.created_at) || 0 : 0;
    const plain = composeBody({ orderNumber, classification, alternatives, daysSinceOrder });
    const html = plainToHtml(plain);
    const summary = `Unnotified pre-order (Case ${classification.case}) — ${classification.leaks.length} pre-order item${classification.leaks.length > 1 ? 's' : ''}`;
    const noteText = `${NOTE_PREFIX} — awaiting send/customer choice (Case ${classification.case})`;

    if (!write) {
      results.push({ order_number: orderNumber, case: classification.case, status: 'dry_run', summary });
      continue;
    }

    try {
      const seeded = await seedOutboundDraft({
        orderNumber,
        customerEmail: order.customer_email,
        customerName: null,
        subject: SUBJECT,
        plainBody: plain,
        htmlBody: html,
        summary,
        steer: `Auto-drafted unnotified pre-order outreach. Case ${classification.case}.`,
        noteText,
        author: 'auto',
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
  classifyOrder,
  filterToNotReadyToShip,
  pastNextBusinessDay5pmPT,
  composeBody,
  formatPreOrderDate,
  hasPreOrderAttr,
  NOTE_PREFIX,
};
