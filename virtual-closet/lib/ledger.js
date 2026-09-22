'use strict';
/**
 * The ledger is fed from store orders in two ways that agree with each other:
 * the order webhook calls recordOrder(payload) the moment an order lands, and
 * the daily reconcile walks the order mirror for anything missed. Both are
 * idempotent through the unique (kind, source_type, source_id) index, so a
 * webhook retry or a reconcile pass can never double-credit a box.
 */
const { db, must, logEvent } = require('./db');
const money = require('./money');
const boxes = require('./boxes');
const centres = require('./centres');
const discounts = require('./discounts');
const sponsorship = require('./sponsorship');
const fx = require('./fx');

// Link mode (the minimal cut, 2026-09-21): no boxes. A centre's money is one
// running balance: what came in (orders, sponsors) less what it has spent on
// partner orders (redemptions). The public page shows lifetime raised, which
// only ever goes up; the centre's email shows the balance it can spend.
const RAISED_KINDS = new Set(['order_credit', 'sponsor', 'centre_add', 'adjustment']);

// Orders without a code: the store's theme writes the centre and the tap time
// onto the cart, and they arrive as note attributes. Such an order credits the
// centre when the tap was within the window and it is the buyer's first
// closet order (Jamie, 2026-09-22: the first order only, 30 days from the
// tap; the year of credit from the 09-19 draft is dropped).
const LINK_WINDOW_MS = 30 * 86400000;
const SPENT_KINDS = new Set(['redemption', 'adjustment']);

/**
 * Insert a ledger row unless its source is already there. Returns the row or
 * null when it existed. `amountCents` is in the centre's currency; `paid` is
 * what was actually paid, in the currency it was paid in, plus the rate when
 * one was used (Jamie, 2026-09-22: every row keeps both, for audit).
 */
async function credit({ centre, box, kind, amountCents, sourceType, sourceId, detail = {}, paid = null }) {
  const currency = centreCurrency(centre);
  const { data, error } = await db().from('vc_ledger')
    .insert({
      centre_id: centre.id, box_id: box?.id || null, kind, amount_cents: amountCents, source_type: sourceType, source_id: sourceId, detail,
      currency, paid_amount_cents: paid ? paid.cents : amountCents, paid_currency: paid ? paid.currency : currency, fx_rate: paid?.fxRate ?? null,
    })
    .select('*').single();
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) return null;
    throw new Error(`ledger insert: ${error.message}`);
  }
  return data;
}

function centreCurrency(centre) { return String(centre?.currency || money.SHOP_CURRENCY).toUpperCase(); }

/**
 * The product subtotal of an order in the shop's currency and, when the
 * payload carries it, as the shopper paid (the presentment money). Sponsor
 * lines are taken out of both: they are credited at face value on their own
 * and never also earn the quarter. A payload without price sets (older
 * simulations, the mirror before it carried presentment money) is shop money
 * with nothing known about how it was paid.
 */
function orderMoney(order, sponsorLines = []) {
  const set = order.subtotal_price_set || order.current_subtotal_price_set || null;
  const shopCurrency = String(set?.shop_money?.currency_code || order.currency || order.shop_currency || money.SHOP_CURRENCY).toUpperCase();
  const shopSubtotal = Math.round(parseFloat(order.subtotal_price ?? order.current_subtotal_price ?? set?.shop_money?.amount ?? 0) * 100);
  const shopCents = Math.max(0, shopSubtotal - sponsorLines.reduce((sum, li) => sum + li.amountCents, 0));
  const pm = set?.presentment_money;
  let presentment = null;
  if (pm && pm.amount != null && pm.currency_code) {
    const currency = String(pm.currency_code).toUpperCase();
    // The sponsor lines come off the presentment subtotal too; when one of them
    // was not paid in that currency the presentment figure cannot be trusted
    // and the order settles from shop money instead.
    const sponsorPaid = sponsorLines.every(li => li.presentment && li.presentment.currency === currency);
    if (sponsorPaid) presentment = { cents: Math.max(0, Math.round(parseFloat(pm.amount) * 100) - sponsorLines.reduce((sum, li) => sum + li.presentment.cents, 0)), currency };
  }
  return { shopCents, shopCurrency, presentment };
}

/**
 * Settle an amount into the centre's currency (Jamie, 2026-09-22):
 *  - paid in the centre's currency: as paid, no rate;
 *  - the centre in the shop's currency: shop money, as the ledger always did;
 *  - otherwise: shop money converted at the day's fx-reference rate, recorded
 *    once and never revisited.
 * Returns the cents to record and what was paid, for the row's audit columns.
 */
async function settle(centre, { shopCents, shopCurrency, presentment }) {
  const currency = centreCurrency(centre);
  const paid = presentment || { cents: shopCents, currency: shopCurrency };
  if (presentment && presentment.currency === currency) return { cents: presentment.cents, paid: { cents: paid.cents, currency: paid.currency, fxRate: null } };
  if (shopCurrency === currency) return { cents: shopCents, paid: { cents: paid.cents, currency: paid.currency, fxRate: null } };
  const rate = await fx.rate(centre);
  return { cents: Math.round(shopCents * rate), paid: { cents: paid.cents, currency: paid.currency, fxRate: rate } };
}

async function openBoxFor(centre) {
  if (centres.isLink(centre)) return null;
  return boxes.getOpenBox(centre.id, { create: true, goalCents: centre.goal_cents });
}

/** Pure: the balance from a centre's ledger rows. */
function balanceFromRows(rows) {
  const out = { raisedCents: 0, redeemedCents: 0, balanceCents: 0, orders: 0, sponsors: 0, lastActivityAt: null };
  for (const r of rows || []) {
    const a = r.amount_cents || 0;
    if (a > 0 && RAISED_KINDS.has(r.kind)) out.raisedCents += a;
    else if (a < 0 && SPENT_KINDS.has(r.kind)) out.redeemedCents += -a;
    if (r.kind === 'order_credit') out.orders += 1;
    if (r.kind === 'sponsor') out.sponsors += 1;
    if ((r.kind === 'order_credit' || r.kind === 'sponsor') && r.created_at && (!out.lastActivityAt || r.created_at > out.lastActivityAt)) out.lastActivityAt = r.created_at;
  }
  out.balanceCents = out.raisedCents - out.redeemedCents;
  return out;
}

async function balance(centre) {
  const rows = must(await db().from('vc_ledger').select('kind, amount_cents, created_at').eq('centre_id', centre.id), 'ledger balance');
  return balanceFromRows(rows);
}

/** All of a centre's ledger lines, newest first, for the operator. */
async function lines(centre, { limit = 200 } = {}) {
  return must(await db().from('vc_ledger').select('*').eq('centre_id', centre.id).order('created_at', { ascending: false }).limit(limit), 'ledger lines');
}

/**
 * The centre spent part of its balance on a partner order (kind
 * 'redemption', negative, idempotent on the order number), or the operator
 * corrected the ledger by hand (kind 'adjustment', either sign, note
 * required, no balance check). Returns the balance after, and `duplicate`
 * when the order number was already recorded.
 */
async function redeem({ centre, amountCents, orderNumber, note, actor = 'operator', kind = 'redemption' }) {
  amountCents = Math.round(Number(amountCents) || 0);
  if (kind === 'redemption') {
    if (!(amountCents > 0)) throw new Error('A redemption must be more than zero.');
    if (!orderNumber) throw new Error('A redemption needs the partner order number.');
    // The same order number recorded twice is a no-op, checked before the
    // balance so a repeated call after a real debit does not read as over-balance.
    const existing = must(await db().from('vc_ledger').select('id').eq('centre_id', centre.id).eq('kind', 'redemption').eq('source_type', 'wholesale_order').eq('source_id', String(orderNumber)).maybeSingle(), 'redemption lookup');
    if (existing) return { ...(await balance(centre)), duplicate: true };
    const before = await balance(centre);
    if (amountCents > before.balanceCents) throw new Error(`That is more than the balance: ${money.dollars(before.balanceCents, centreCurrency(centre))} available.`);
    const row = await credit({ centre, box: null, kind: 'redemption', amountCents: -amountCents, sourceType: 'wholesale_order', sourceId: String(orderNumber), detail: { note: note || null, actor } });
    if (!row) return { ...before, duplicate: true };
    await logEvent(centre.id, actor, 'ledger.redemption', { order_number: String(orderNumber), cents: amountCents });
    return { ...(await balance(centre)), duplicate: false };
  }
  if (kind !== 'adjustment') throw new Error(`Unknown kind: ${kind}`);
  if (!amountCents) throw new Error('An adjustment must not be zero.');
  if (!note) throw new Error('An adjustment needs a note saying why.');
  await credit({ centre, box: null, kind: 'adjustment', amountCents, sourceType: 'operator', sourceId: null, detail: { note, actor, order_number: orderNumber ? String(orderNumber) : null } });
  await logEvent(centre.id, actor, 'ledger.adjustment', { cents: amountCents, note });
  return { ...(await balance(centre)), duplicate: false };
}

/** Pure: what the digest says about a run of order-credit and sponsor rows. */
function digestFromRows(rows) {
  const out = { any: false, orders: 0, orderCents: 0, sponsors: 0, sponsorCents: 0, maxCreatedAt: null };
  for (const r of rows || []) {
    if (r.kind === 'order_credit') { out.orders += 1; out.orderCents += r.amount_cents || 0; }
    else if (r.kind === 'sponsor') { out.sponsors += 1; out.sponsorCents += r.amount_cents || 0; }
    else continue;
    out.any = true;
    if (!out.maxCreatedAt || r.created_at > out.maxCreatedAt) out.maxCreatedAt = r.created_at;
  }
  return out;
}

/** Activity since the centre's digest watermark (all of it when there is none). */
async function digestActivity(centre, { since } = {}) {
  let q = db().from('vc_ledger').select('kind, amount_cents, created_at').eq('centre_id', centre.id).in('kind', ['order_credit', 'sponsor']).order('created_at');
  if (since) q = q.gt('created_at', since);
  return digestFromRows(must(await q, 'digest rows'));
}

/**
 * From a REST order payload (webhook) or a mirror row with its line items.
 * Returns what was newly credited so the caller can send emails.
 */
async function recordOrder(order, { lineItems = null, emit = true, lookupAttributes = false } = {}) {
  const orderId = String(order.id || order.shopify_order_id || '').split('/').pop();
  if (!orderId) return { credited: [] };
  if (order.financial_status && !['paid', 'partially_paid', 'authorized'].includes(String(order.financial_status).toLowerCase())) return { credited: [] };
  const credited = [];
  const email = String(order.email || order.customer_email || order.contact_email || '').toLowerCase() || null;

  // Sponsor lines in the same order are credited at face value below and
  // never also earn the quarter: the quarter is of what was spent on product.
  const s = await sponsorship.settings();
  const items = lineItems || order.line_items || [];
  const sponsorLines = items.map(li => sponsorship.readLineItem(li, s)).filter(Boolean);
  const productMoney = orderMoney(order, sponsorLines);
  // The quarter, in the centre's currency, of what the shopper paid for product.
  const quarterFor = async centre => {
    const settled = await settle(centre, productMoney);
    const subtotal = Math.max(0, settled.cents);
    return { subtotal, amountCents: money.orderCreditCents(subtotal), paid: settled.paid };
  };

  // 1. A community order through a centre's link (discount code prefix VC-).
  const codes = (order.discount_codes || []).map(c => (typeof c === 'string' ? c : c.code)).filter(Boolean);
  let codeCentre = null;
  for (const code of codes) {
    const known = await discounts.centreForCode(code);
    if (!known) continue;
    const centre = await centres.getById(known.centre_id);
    if (!centre) continue;
    codeCentre = centre;
    const box = await openBoxFor(centre);
    const q = productMoney.shopCents > 0 ? await quarterFor(centre) : null;
    const row = q && q.subtotal > 0 ? await credit({ centre, box, kind: 'order_credit', amountCents: q.amountCents, sourceType: 'shopify_order', sourceId: orderId, detail: { code, subtotal_cents: q.subtotal, order_number: order.order_number || order.name, email }, paid: q.paid }) : null;
    await db().from('vc_discount_codes').update({ order_id: orderId, used_at: new Date().toISOString() }).eq('code', known.code).is('order_id', null);
    if (row) {
      credited.push({ ...row, centre, box });
      await logEvent(centre.id, 'system', 'ledger.order_credit', { order: orderId, cents: row.amount_cents });
      // The code has done its job; off the store it goes so nobody reuses it.
      if (await discounts.retireCode(known.code)) await logEvent(centre.id, 'system', 'code.retired', { code: known.code, order: orderId });
    }
  }

  // 2. Sponsorship and centre top-up line items.
  let orderAttrs = sponsorship.readOrderAttributes(order);
  // Mirror rows carry no note attributes; fetch them from Shopify when a
  // sponsorship line has no properties of its own, or when a code-less order
  // may be a link order (the reconcile asks for that on recent orders).
  const wantsAttrs = (sponsorLines.length && sponsorLines.some(r => !r.slug)) || (lookupAttributes && !codes.length);
  if (!orderAttrs.slug && wantsAttrs) {
    try {
      const { shopifyGraphQL } = require('../../customer-service/lib/shopify');
      const data = await shopifyGraphQL('query($id: ID!) { order(id: $id) { customAttributes { key value } } }', { id: `gid://shopify/Order/${orderId}` });
      orderAttrs = sponsorship.readOrderAttributes(data.order || {});
    } catch (err) { console.warn(`[vc] order attributes lookup failed for ${orderId}: ${err.message}`); }
  }
  for (const li of items) {
    const read = sponsorship.readLineItem(li, s, orderAttrs);
    if (!read || !read.slug) continue;
    const centre = await centres.getBySlug(read.slug);
    if (!centre) continue;
    const box = await openBoxFor(centre);
    // A sponsor line settles like an order: as paid in the centre's currency, else converted once.
    const settled = await settle(centre, { shopCents: read.amountCents, shopCurrency: read.shopCurrency || productMoney.shopCurrency, presentment: read.presentment });
    const row = await credit({ centre, box, kind: read.kind, amountCents: settled.cents, sourceType: 'shopify_line_item', sourceId: read.lineItemId || `${orderId}-${read.kind}`, detail: { order: orderId, order_number: order.order_number || order.name, email, intended_box: read.boxNumber }, paid: settled.paid });
    if (row) { credited.push({ ...row, centre, box }); await logEvent(centre.id, 'system', `ledger.${read.kind}`, { order: orderId, cents: row.amount_cents }); }
  }

  // 3. No code, but the theme put a centre on the cart: the shopper came
  // from the link within the window. One credit per order, and only the
  // buyer's first closet order, so a spent code that Shopify stripped at
  // checkout does not turn into a second credit here.
  if (!codes.length && productMoney.shopCents > 0 && orderAttrs.slug && orderAttrs.sinceMs) {
    const fresh = Date.now() - orderAttrs.sinceMs <= LINK_WINDOW_MS;
    const centre = fresh ? await centres.getBySlug(orderAttrs.slug) : null;
    if (centre && !(await hasClosetOrder(email))) {
      const box = await openBoxFor(centre);
      const q = await quarterFor(centre);
      const row = q.subtotal > 0 ? await credit({ centre, box, kind: 'order_credit', amountCents: q.amountCents, sourceType: 'shopify_order', sourceId: orderId, detail: { attributed: 'link', since: new Date(orderAttrs.sinceMs).toISOString(), subtotal_cents: q.subtotal, order_number: order.order_number || order.name, email }, paid: q.paid }) : null;
      if (row) { credited.push({ ...row, centre, box }); await logEvent(centre.id, 'system', 'ledger.order_credit', { order: orderId, cents: row.amount_cents, attributed: 'link' }); }
    }
  }

  // A credited code order marks the customer on the store, so the cart can
  // say the 20% is spent when they are signed in on another device.
  if (codeCentre && credited.some(r => r.kind === 'order_credit' && r.detail?.code) && order.customer?.id) {
    await tagCustomer(order.customer.id, ['closet-discount-used', `closet:${codeCentre.slug}`]);
  }

  if (emit && credited.length) await notify(credited, order);
  return { credited };
}

/** Has this email already been credited as a closet order, at any centre? */
async function hasClosetOrder(email) {
  if (!email) return false;
  // Pilot scale: the order-credit rows are few, so read them and match in
  // code rather than lean on a JSON-path filter the in-memory tests cannot run.
  const rows = must(await db().from('vc_ledger').select('detail').eq('kind', 'order_credit'), 'closet orders');
  return rows.some(r => String(r.detail?.email || '').toLowerCase() === email);
}

/** Add tags to a Shopify customer; a failure here is logged, never fatal. */
async function tagCustomer(customerId, tags) {
  try {
    const shopify = require('../../customer-service/lib/shopify');
    await shopify.addTags(`gid://shopify/Customer/${String(customerId).split('/').pop()}`, tags);
  } catch (err) { console.warn(`[vc] customer tag failed: ${err.message}`); }
}

/** Emails for newly credited rows: sponsor thank-you, centre "someone sponsored", "box funded" when it tips over. */
async function notify(credited, order) {
  const emails = require('./emails');
  const buyerEmail = order.email || order.customer_email || order.contact_email || null;
  const byCentre = new Map();
  for (const row of credited) {
    if (!byCentre.has(row.centre.id)) byCentre.set(row.centre.id, { centre: row.centre, box: row.box, rows: [] });
    byCentre.get(row.centre.id).rows.push(row);
  }
  for (const { centre, box, rows } of byCentre.values()) {
    if (centres.isLink(centre)) {
      // Link mode: the sponsor hears back at once; the centre hears in its
      // daily digest, and order credits email nobody live.
      const bal = await balance(centre);
      for (const row of rows) {
        if (row.kind === 'sponsor' && buyerEmail) await emails.sponsorThanks({ centre, to: buyerEmail, amountCents: row.amount_cents, raised: bal.raisedCents });
      }
      continue;
    }
    const sum = await boxes.summary(centre, box);
    const to = centre.statements_email || (await adminEmail(centre.id));
    for (const row of rows) {
      if (row.kind === 'sponsor') {
        if (buyerEmail) await emails.sponsorThanks({ centre, to: buyerEmail, amountCents: row.amount_cents, box, raised: sum.raised, goal: sum.goal, city: centre.address?.city });
        if (to) await emails.sponsored({ centre, to, amountCents: row.amount_cents, box, raised: sum.raised, goal: sum.goal });
      }
    }
    // Box just became funded: tell the centre once.
    const before = sum.raised - rows.reduce((a, r) => a + r.amount_cents, 0);
    if (sum.funded && before < sum.goal && to) {
      await emails.boxFunded({ centre, to, box, raised: sum.raised });
      await logEvent(centre.id, 'system', 'box.funded', { number: box.number, raised: sum.raised });
    }
  }
}

async function adminEmail(centreId) {
  const rows = must(await db().from('vc_memberships').select('vc_users(email)').eq('centre_id', centreId).eq('role', 'admin').limit(1), 'admin email');
  return rows[0]?.vc_users?.email || null;
}

/**
 * Walk recent mirror orders and record anything the webhook missed.
 * Emails are not re-sent for rows found here (they were most likely sent
 * live); the operator sees them in the log.
 */
async function reconcile({ days = 45 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const s = await sponsorship.settings();
  const variantIds = s?.variants ? Object.values(s.variants).map(v => v.id) : [];
  // The mirror carries both shop money and what the shopper paid (presentment),
  // so a non-USD centre's orders settle here exactly as they do off the webhook.
  const orders = must(await db().from('orders').select('shopify_order_id, order_number, customer_email, discount_codes, subtotal_price, shop_currency, presentment_currency, presentment_subtotal_price, financial_status, created_at').gte('created_at', since).order('created_at'), 'orders');
  let checked = 0, credited = 0;
  for (const o of orders) {
    const codes = (o.discount_codes || []).map(c => (typeof c === 'string' ? c : c.code)).filter(c => /^VC-/i.test(c || ''));
    let lineItems = [];
    if (variantIds.length) {
      lineItems = must(await db().from('order_line_items').select('shopify_line_item_id, shopify_variant_id, quantity, unit_price, unit_price_currency, presentment_unit_price, presentment_unit_price_currency, custom_attributes').eq('shopify_order_id', o.shopify_order_id).in('shopify_variant_id', variantIds), 'line items');
    }
    // A code-less order from the last two days may be a link order whose
    // attribution only exists as note attributes, which the mirror lacks;
    // those get a lookup. Older ones were checked when they were recent.
    const recent = new Date(o.created_at) >= new Date(Date.now() - 2 * 86400000);
    if (!codes.length && !lineItems.length && !recent) continue;
    checked++;
    const shopCurrency = o.shop_currency || money.SHOP_CURRENCY;
    const { credited: rows } = await recordOrder({
      id: String(o.shopify_order_id).split('/').pop(), order_number: o.order_number, email: o.customer_email,
      discount_codes: codes, subtotal_price: o.subtotal_price, financial_status: o.financial_status, currency: shopCurrency,
      subtotal_price_set: o.presentment_currency ? {
        shop_money: { amount: String(o.subtotal_price ?? 0), currency_code: shopCurrency },
        presentment_money: { amount: String(o.presentment_subtotal_price ?? 0), currency_code: o.presentment_currency },
      } : undefined,
    }, { lineItems, emit: false, lookupAttributes: !codes.length && !lineItems.length });
    credited += rows.length;
  }
  return { checked, credited };
}

module.exports = { recordOrder, reconcile, credit, balance, balanceFromRows, lines, redeem, digestActivity, digestFromRows, orderMoney, settle, centreCurrency, LINK_WINDOW_MS };
