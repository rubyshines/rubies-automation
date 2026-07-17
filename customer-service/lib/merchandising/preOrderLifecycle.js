/**
 * Pre-order lifecycle: hygiene sweep + delay-notification waves.
 *
 * Two recurring operator processes, run every pre-order cycle:
 *
 *   1. Hygiene (preOrderHygiene) — reconcile the "open unfulfilled" picture
 *      before communicating anything. The Supabase mirror is a lagging cache:
 *      orders fulfilled/archived in Shopify can linger open (missed webhook),
 *      and line-item custom_attributes are null for orders last synced before
 *      the 2026-05-01 migration. Live Shopify + Warehance are the truth.
 *
 *   2. Update notices (sendPreOrderUpdateNotices) — when a production order
 *      slips, email every open order that was promised an earlier date. Two
 *      variants: pre-order-only orders get a swap offer; mixed orders get
 *      split-or-swap. Plain email from care@ via SendGrid — no Gorgias ticket
 *      up front; a reply flows through normal intake and creates one.
 *
 * Hard-won source-of-truth rules (2026-07-16 wave):
 *   - Line-item `Pre-order` attributes are read LIVE from Shopify, never from
 *     the mirror (nulls on older orders).
 *   - An order is "waiting" only if Warehance says ready_to_ship === false.
 *     Shopify inventory 0 does NOT mean blocked — Warehance reserves units on
 *     the order at placement, so a past-dated pre-order line whose stock
 *     arrived ships fine (declare its text in stale_targets).
 *   - Every live send is recorded in preorder_notifications so a later wave
 *     knows who was already told what (dedupe by communicated target).
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { sendEmail } = require('../../../shared/sendgridClient');
const { shopifyGraphQL } = require('../shopify');
const { fetchOrderByNumber, getHoldReasons } = require('../../../reports/lib/warehanceClient');
const { signOff, signOffHtml } = require('../signatures');

const SUBJECT = 'RUBIES Pre-Order Update';
const DEFAULT_TEST_RECIPIENT = 'jamie@rubyshines.com';
const NO_DATE_TEXT = 'Will ship when in stock';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/**
 * Parse a customer-visible `Pre-order` attribute value.
 *
 * "Target availability middle of August, 2026." →
 *   { kind: 'dated', phrase: 'the middle of August', isPast, anchor }
 * "Will ship when in stock" → { kind: 'no_date' }
 * anything else → { kind: 'unknown' }
 *
 * The anchor used for isPast is the END of the stated window (beginning=10th,
 * middle=20th, end=last day) so a promise only reads as broken once the whole
 * window has passed.
 */
function parsePromisedTarget(text, now = new Date()) {
  const t = (text || '').trim();
  if (!t) return { kind: 'unknown', raw: text };
  if (/^will ship when in stock\.?$/i.test(t)) return { kind: 'no_date', raw: text };

  const m = t.match(/^Target availability (beginning|middle|end) of ([A-Za-z]+),? (\d{4})\.?$/i);
  if (!m) return { kind: 'unknown', raw: text };
  const [, part, monthName, yearStr] = m;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month === -1) return { kind: 'unknown', raw: text };

  const year = Number(yearStr);
  const day = part.toLowerCase() === 'beginning' ? 10
    : part.toLowerCase() === 'middle' ? 20
      : new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); // last day of month
  const anchor = new Date(Date.UTC(year, month, day, 23, 59, 59));
  return {
    kind: 'dated',
    phrase: `the ${part.toLowerCase()} of ${monthName[0].toUpperCase()}${monthName.slice(1).toLowerCase()}`,
    isPast: anchor.getTime() < now.getTime(),
    anchor,
    raw: text,
  };
}

/**
 * Format a line item the way the order confirmation shows it:
 * "2 X Sassy No-Tuck Shaping Underwear - Sandstone, M".
 * Product titles arrive all-caps from Shopify; title-case them, keep the AJ
 * acronym uppercase, and strip the legacy leading "THE".
 */
function titleCaseProduct(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[a-z0-9']+/g, w => (w === 'aj' ? 'AJ' : w[0].toUpperCase() + w.slice(1)));
}

function describeItem(li) {
  const name = titleCaseProduct(li.title).replace(/^The\s+/, '');
  const variant = (li.variantTitle || '').split('/').map(s => s.trim()).filter(Boolean).join(', ');
  return `${li.qty} X ${name}${variant && !/^default(\s+title)?$/i.test(variant) ? ` - ${variant}` : ''}`;
}

/**
 * Split an order's unfulfilled lines for a notification wave.
 *
 * waveTargets — exact attribute texts this wave updates (the waiting lines).
 * staleTargets — texts the OPERATOR declares arrived-and-reserved (treated as
 *   in-stock; e.g. a "beginning of April" Gaff whose restock landed).
 *
 * Lines with any other pre-order text make the order `unhandled` — a promise
 * we're not updating and can't classify, so the order needs individual review
 * rather than a wrong batch email.
 */
function classifyOrderLines(lines, { waveTargets, staleTargets = [] }, now = new Date()) {
  const wave = new Set(waveTargets);
  const stale = new Set(staleTargets);
  const preItems = [];
  const inStockItems = [];
  const unhandledTargets = [];

  for (const li of lines) {
    const target = ((li.customAttributes || []).find(a => a.key === 'Pre-order') || {}).value?.trim() || null;
    if (!target || stale.has(target)) { inStockItems.push(li); continue; }
    if (wave.has(target)) { preItems.push({ ...li, target }); continue; }
    unhandledTargets.push(target);
  }
  return { preItems, inStockItems, unhandledTargets: [...new Set(unhandledTargets)] };
}

/**
 * Compose the update email. Variant A (no in-stock items) offers a swap;
 * variant B (mixed) offers split-or-swap. Opener + apology derive from the
 * earliest promised target. newDatePhrase reads like "the end of August".
 * No em dashes anywhere — customer-facing copy rule.
 */
function composeUpdateEmail({ preItems, inStockItems, newDatePhrase }, now = new Date()) {
  const itemLines = preItems.map(describeItem);
  const plural = preItems.length > 1;
  const preNoun = `pre-order${plural ? ' items' : ''}`;

  const parsed = preItems
    .map(li => parsePromisedTarget(li.target, now))
    .sort((a, z) => (a.anchor?.getTime() ?? Infinity) - (z.anchor?.getTime() ?? Infinity));
  const earliest = parsed[0];

  let opener;
  let update;
  if (earliest.kind === 'no_date') {
    opener = `When you placed your order, your ${preNoun} ${plural ? 'were' : 'was'} listed to ship when back in stock:`;
    update = `We wanted to give you a better idea of timing. Our new inventory is on its way, and it is now looking like your order will ship closer to ${newDatePhrase}.`;
  } else if (earliest.isPast) {
    opener = `When you placed your order, the target availability for your ${preNoun} was ${earliest.phrase}:`;
    update = `We are sorry for the wait. Our new inventory is on its way, and it is now looking like your order will ship closer to ${newDatePhrase}.`;
  } else {
    opener = `When you placed your order, the target availability for your ${preNoun} was ${earliest.phrase}:`;
    update = `Our new inventory is on its way, but it is now looking like your order will ship closer to ${newDatePhrase}.`;
  }

  const introText = `You have a pre-order with us and we wanted to give you an update. ${opener}`;

  let middle;
  if (inStockItems.length) {
    middle =
      'If you need something from your order more urgently, you can:\n\n' +
      '1. Have us split your order and ship the in-stock items right away. ' +
      `The ${preNoun} will follow as soon as ${plural ? 'they arrive' : 'it arrives'}.\n` +
      `2. Swap your ${preNoun} for something that is in stock, so your whole order ships now.\n\n` +
      'Just reply to this email and let us know. Otherwise we will ship everything together as soon as your pre-order arrives.';
  } else {
    middle =
      'If you need something from your order more urgently, we would be happy to swap your pre-order for something we have in stock. ' +
      'We have inventory in most styles, colours and sizes. Just reply to this email and we will get you sorted.';
  }

  const thanks = 'Thank you so much for your support and understanding.';

  const text =
    `Hi!\n\n${introText}\n\n${itemLines.map(l => `- ${l}`).join('\n')}\n\n${update}\n\n${middle}\n\n${thanks}\n\n${signOff('Take care,')}`;

  const para = s => `<p>${s.replace(/\n/g, '<br>')}</p>`;
  const html =
    para('Hi!') +
    para(introText) +
    `<ul>${itemLines.map(l => `<li>${l}</li>`).join('')}</ul>` +
    para(update) +
    para(middle) +
    para(thanks) +
    signOffHtml('Take care,');

  return { text, html, variant: inStockItems.length ? 'B_mixed' : 'A_pre_only' };
}

// ---------------------------------------------------------------------------
// Live scan (Shopify + Warehance per open order)
// ---------------------------------------------------------------------------

/**
 * All open (mirror: unfulfilled/partial, not cancelled, not closed) orders,
 * each verified against live Shopify and Warehance. Sequentially paced —
 * ~1s per 4 orders.
 *
 * Returns rows: { order_number, shopify_order_id, customer_email, created_at,
 *   drift ('closed'|'cancelled'|'fulfilled'|null — live disagrees with mirror),
 *   financial_status, lines[{ id, sku, title, variantTitle, qty, customAttributes }],
 *   mirrorLines[{ shopify_line_item_id, custom_attributes }],
 *   warehance: { found, ready_to_ship, holds, status, fulfillment_status } }
 */
async function scanOpenPreOrders({ onProgress } = {}) {
  const sb = getSupabaseClient();
  const { data: orders, error } = await sb
    .from('orders')
    .select('shopify_order_id, order_number, customer_email, created_at')
    .or('fulfillment_status.is.null,fulfillment_status.in.(unfulfilled,partial,UNFULFILLED,PARTIALLY_FULFILLED)')
    .is('cancelled_at', null)
    .is('closed_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`orders query: ${error.message}`);

  const rows = [];
  const errors = [];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (onProgress) onProgress(i + 1, orders.length, o.order_number);
    try {
      const data = await shopifyGraphQL(
        `query($id: ID!) { order(id: $id) {
          displayFulfillmentStatus displayFinancialStatus closed cancelledAt
          lineItems(first: 50) { nodes { id sku title variantTitle quantity unfulfilledQuantity customAttributes { key value } } }
        } }`,
        { id: o.shopify_order_id }
      );
      const live = data.order;
      if (!live) { errors.push({ order: o.order_number, error: 'not found in Shopify' }); continue; }

      const drift = live.cancelledAt ? 'cancelled'
        : live.closed ? 'closed'
          : live.displayFulfillmentStatus === 'FULFILLED' ? 'fulfilled'
            : null;

      let wh = null;
      if (!drift) {
        try { wh = await fetchOrderByNumber(o.order_number); } catch (e) { /* reported as not found */ }
      }

      const { data: mirrorLines } = await sb
        .from('order_line_items')
        .select('shopify_line_item_id, sku, custom_attributes')
        .eq('shopify_order_id', o.shopify_order_id);

      rows.push({
        order_number: o.order_number,
        shopify_order_id: o.shopify_order_id,
        customer_email: o.customer_email,
        created_at: o.created_at,
        drift,
        financial_status: live.displayFinancialStatus,
        lines: live.lineItems.nodes
          .map(li => ({
            id: li.id,
            sku: li.sku,
            title: li.title,
            variantTitle: li.variantTitle,
            qty: li.unfulfilledQuantity ?? li.quantity,
            customAttributes: li.customAttributes,
          }))
          .filter(li => li.qty > 0),
        mirrorLines: mirrorLines || [],
        warehance: drift ? null : {
          found: !!wh,
          ready_to_ship: wh ? wh.ready_to_ship : null,
          holds: wh ? getHoldReasons(wh) : [],
          status: wh ? wh.status : null,
          fulfillment_status: wh ? wh.fulfillment_status : null,
        },
      });
    } catch (e) {
      errors.push({ order: o.order_number, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

function liveAttrDiffersFromMirror(row) {
  // Compare per line by numeric line-item id (mirror stores the numeric id).
  const mirrorById = new Map(
    row.mirrorLines
      .filter(m => m.shopify_line_item_id != null)
      .map(m => [String(m.shopify_line_item_id), m.custom_attributes])
  );
  const diffs = [];
  for (const li of row.lines) {
    const numericId = String(li.id).replace(/^gid:\/\/shopify\/LineItem\//, '');
    if (!mirrorById.has(numericId)) continue; // mirror missing the row entirely — resync territory
    const mirrorAttrs = mirrorById.get(numericId);
    const liveAttrs = li.customAttributes || [];
    const norm = a => JSON.stringify((a || []).map(x => [x.key, x.value]).sort());
    if (norm(mirrorAttrs) !== norm(liveAttrs)) diffs.push({ numericId, live: liveAttrs });
  }
  return diffs;
}

/**
 * Hygiene sweep. Read-only by default; fixes are opt-in per flag (the flag is
 * the operator's approval).
 *
 * fixAttributes  — backfill order_line_items.custom_attributes from live
 *                  Shopify (heals the pre-2026-05-01 null gap).
 * fixClosedDrift — stamp mirror orders whose live Shopify state is
 *                  closed/cancelled/fulfilled so they stop polluting reports.
 */
async function preOrderHygiene({ fixAttributes = false, fixClosedDrift = false, onProgress } = {}) {
  const sb = getSupabaseClient();
  const { rows, errors } = await scanOpenPreOrders({ onProgress });
  const now = Date.now();

  const report = {
    scanned: rows.length,
    mirror_drift: [],
    refunded_open: [],
    ready_unshipped: [],
    stuck_no_hold: [],
    held: [],
    not_in_warehance: [],
    waiting_by_target: {},
    attribute_drift: [],
    errors,
    fixes: { attributes: 0, closed_drift: 0 },
  };

  for (const row of rows) {
    const ageDays = Math.floor((now - new Date(row.created_at).getTime()) / 86400000);
    const ref = { order: row.order_number, email: row.customer_email, age_days: ageDays };

    if (row.drift) {
      report.mirror_drift.push({ ...ref, live_state: row.drift });
      if (fixClosedDrift) {
        const patch = { updated_at: new Date().toISOString() };
        if (row.drift === 'cancelled') patch.cancelled_at = new Date().toISOString();
        else if (row.drift === 'closed') patch.closed_at = new Date().toISOString();
        else patch.fulfillment_status = 'FULFILLED';
        const { error: fixErr } = await sb.from('orders').update(patch).eq('shopify_order_id', row.shopify_order_id);
        if (!fixErr) report.fixes.closed_drift++;
      }
      continue;
    }

    const attrDiffs = liveAttrDiffersFromMirror(row);
    if (attrDiffs.length) {
      report.attribute_drift.push({ ...ref, lines: attrDiffs.length });
      if (fixAttributes) {
        for (const d of attrDiffs) {
          const { error: fixErr } = await sb
            .from('order_line_items')
            .update({ custom_attributes: d.live })
            .eq('shopify_line_item_id', d.numericId);
          if (!fixErr) report.fixes.attributes++;
        }
      }
    }

    if (String(row.financial_status).toUpperCase() === 'REFUNDED') {
      report.refunded_open.push({ ...ref, note: 'fully refunded but open + unfulfilled — archive it' });
      continue;
    }

    const wh = row.warehance;
    if (!wh.found) { report.not_in_warehance.push(ref); continue; }
    if (wh.holds.length) { report.held.push({ ...ref, holds: wh.holds }); continue; }

    const targets = [...new Set(row.lines
      .map(li => ((li.customAttributes || []).find(a => a.key === 'Pre-order') || {}).value?.trim())
      .filter(Boolean))];

    if (wh.ready_to_ship === true) {
      if (ageDays >= 3) report.ready_unshipped.push({ ...ref, note: 'Warehance says ready — why unshipped?' });
      continue;
    }

    if (!targets.length) {
      report.stuck_no_hold.push({ ...ref, note: 'not ready to ship, no hold, no pre-order line — check for phantom/unmapped lines' });
      continue;
    }

    for (const t of targets) {
      if (!report.waiting_by_target[t]) report.waiting_by_target[t] = [];
      report.waiting_by_target[t].push(row.order_number);
    }
  }

  return report;
}

function hygieneReportMarkdown(report) {
  const lines = [`## Pre-order hygiene — ${report.scanned} open unfulfilled orders scanned`, ''];
  const section = (title, items, fmt) => {
    if (!items.length) return;
    lines.push(`**${title} (${items.length})**`);
    for (const i of items) lines.push(`- ${fmt(i)}`);
    lines.push('');
  };
  section('Mirror drift (live Shopify says done — fix with fix_closed_drift)', report.mirror_drift,
    i => `#${i.order}: live ${i.live_state}`);
  section('Refunded but open (archive in Shopify)', report.refunded_open, i => `#${i.order} (${i.age_days}d)`);
  section('Ready to ship but unshipped 3+ days', report.ready_unshipped, i => `#${i.order} (${i.age_days}d)`);
  section('Stuck: not ready, no hold, no pre-order line', report.stuck_no_hold, i => `#${i.order} (${i.age_days}d) — ${i.note}`);
  section('On hold (informational)', report.held, i => `#${i.order}: ${i.holds.join(', ')}`);
  section('Not found in Warehance', report.not_in_warehance, i => `#${i.order}`);
  section('Line-attribute drift vs mirror (fix with fix_attributes)', report.attribute_drift,
    i => `#${i.order}: ${i.lines} line(s)`);
  section('Scan errors', report.errors, i => `#${i.order}: ${i.error}`);

  const targets = Object.entries(report.waiting_by_target);
  if (targets.length) {
    lines.push('**Waiting pre-orders by promised text** (healthy population)');
    for (const [t, orders] of targets.sort((a, z) => z[1].length - a[1].length)) {
      lines.push(`- "${t}": ${orders.length} orders (${orders.map(o => `#${o}`).join(', ')})`);
    }
    lines.push('');
  }
  if (report.fixes.attributes || report.fixes.closed_drift) {
    lines.push(`**Fixes applied:** ${report.fixes.attributes} line attribute backfills, ${report.fixes.closed_drift} mirror-drift stamps`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Notification wave
// ---------------------------------------------------------------------------

/**
 * Orders already told a given target, from preorder_notifications.
 * Fail-soft: missing table → empty set + warning (sends still work; dedupe
 * just can't see history).
 */
async function previouslyNotified(communicatedTarget) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('preorder_notifications')
    .select('order_number')
    .eq('communicated_target', communicatedTarget);
  if (error) return { orders: new Set(), warning: `preorder_notifications unavailable (${error.message}) — dedupe disabled` };
  return { orders: new Set((data || []).map(r => r.order_number)), warning: null };
}

/**
 * Run a notification wave.
 *
 * @param {object} args
 * @param {string} args.newDatePhrase  e.g. "the end of August" (reads inline:
 *   "...will ship closer to the end of August.")
 * @param {string[]} args.waveTargets  exact promised texts being updated
 * @param {string[]} [args.staleTargets] promised texts whose stock arrived
 *   (operator judgment) — lines treated as in-stock
 * @param {number[]} [args.excludeOrders]
 * @param {'dry_run'|'test_send'|'send'} [args.mode='dry_run']
 * @param {string} [args.testRecipient]
 * @param {boolean} [args.resend=false]  include orders already told this date
 */
async function sendPreOrderUpdateNotices({
  newDatePhrase,
  waveTargets,
  staleTargets = [],
  excludeOrders = [],
  mode = 'dry_run',
  testRecipient = DEFAULT_TEST_RECIPIENT,
  resend = false,
  onProgress,
} = {}) {
  if (!newDatePhrase) throw new Error('newDatePhrase is required (e.g. "the end of August")');
  if (!Array.isArray(waveTargets) || !waveTargets.length) throw new Error('waveTargets is required (exact promised texts)');
  if (!['dry_run', 'test_send', 'send'].includes(mode)) throw new Error(`unknown mode: ${mode}`);

  const sb = getSupabaseClient();
  const exclude = new Set(excludeOrders.map(Number));
  const { orders: alreadyTold, warning: dedupeWarning } = await previouslyNotified(newDatePhrase);

  const { rows, errors } = await scanOpenPreOrders({ onProgress });
  const skipped = errors.map(e => `#${e.order}: scan error — ${e.error}`);
  const candidates = [];

  for (const row of rows) {
    if (exclude.has(row.order_number)) { skipped.push(`#${row.order_number}: excluded by operator`); continue; }
    if (row.drift) { skipped.push(`#${row.order_number}: live Shopify says ${row.drift} — run hygiene`); continue; }

    const { preItems, inStockItems, unhandledTargets } = classifyOrderLines(row.lines, { waveTargets, staleTargets });
    if (!preItems.length) continue; // not part of this wave
    if (unhandledTargets.length) {
      skipped.push(`#${row.order_number}: also promised "${unhandledTargets.join('; ')}" — handle individually`);
      continue;
    }
    if (!row.warehance.found) { skipped.push(`#${row.order_number}: not in Warehance — check manually`); continue; }
    if (row.warehance.ready_to_ship !== false) { skipped.push(`#${row.order_number}: Warehance says ready to ship — no email`); continue; }
    if (!resend && alreadyTold.has(row.order_number)) {
      skipped.push(`#${row.order_number}: already told "${newDatePhrase}" — pass resend=true to include`);
      continue;
    }

    const email = composeUpdateEmail({ preItems, inStockItems, newDatePhrase });
    candidates.push({
      order_number: row.order_number,
      customer_email: row.customer_email,
      promised: [...new Set(preItems.map(li => li.target))],
      variant: email.variant,
      email,
    });
  }

  const summary = {
    mode,
    total: candidates.length,
    byVariant: {
      A_pre_only: candidates.filter(c => c.variant === 'A_pre_only').length,
      B_mixed: candidates.filter(c => c.variant === 'B_mixed').length,
    },
    skipped,
    dedupeWarning,
    results: [],
  };

  if (mode === 'dry_run') {
    summary.results = candidates.map(c => ({
      order_number: c.order_number, customer_email: c.customer_email,
      promised: c.promised, variant: c.variant, body: c.email.text,
    }));
    return summary;
  }

  let queue = candidates;
  if (mode === 'test_send') {
    // One example per (earliest-promise kind, variant) combination.
    const seen = new Set();
    queue = candidates.filter(c => {
      const key = `${c.promised.slice().sort().join('|')}::${c.variant}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  for (const c of queue) {
    const to = mode === 'test_send' ? testRecipient : c.customer_email;
    const subject = mode === 'test_send'
      ? `[TEST ${c.variant} — would go to ${c.customer_email}] ${SUBJECT}`
      : SUBJECT;
    const result = await sendEmail({ to, subject, text: c.email.text, html: c.email.html });

    const entry = {
      order_number: c.order_number,
      customer_email: c.customer_email,
      to,
      variant: c.variant,
      sent: result.ok,
      error: result.ok ? null : result.error,
    };

    if (result.ok && mode === 'send') {
      const { error: trackErr } = await sb.from('preorder_notifications').insert({
        order_number: c.order_number,
        customer_email: c.customer_email,
        promised_targets: c.promised,
        communicated_target: newDatePhrase,
        variant: c.variant,
      });
      entry.tracked = !trackErr;
      if (trackErr) entry.track_error = trackErr.message;
    }

    summary.results.push(entry);
    await new Promise(r => setTimeout(r, 300));
  }

  summary.sent = summary.results.filter(r => r.sent).length;
  summary.failed = summary.results.filter(r => !r.sent).length;
  return summary;
}

module.exports = {
  parsePromisedTarget,
  classifyOrderLines,
  composeUpdateEmail,
  describeItem,
  titleCaseProduct,
  scanOpenPreOrders,
  preOrderHygiene,
  hygieneReportMarkdown,
  sendPreOrderUpdateNotices,
  SUBJECT,
  NO_DATE_TEXT,
};
