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

/** Insert a ledger row unless its source is already there. Returns the row or null when it existed. */
async function credit({ centre, box, kind, amountCents, sourceType, sourceId, detail = {} }) {
  const { data, error } = await db().from('vc_ledger')
    .insert({ centre_id: centre.id, box_id: box?.id || null, kind, amount_cents: amountCents, source_type: sourceType, source_id: sourceId, detail })
    .select('*').single();
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) return null;
    throw new Error(`ledger insert: ${error.message}`);
  }
  return data;
}

async function openBoxFor(centre) {
  return boxes.getOpenBox(centre.id, { create: true, goalCents: centre.goal_cents });
}

/**
 * From a REST order payload (webhook) or a mirror row with its line items.
 * Returns what was newly credited so the caller can send emails.
 */
async function recordOrder(order, { lineItems = null, emit = true } = {}) {
  const orderId = String(order.id || order.shopify_order_id || '').split('/').pop();
  if (!orderId) return { credited: [] };
  if (order.financial_status && !['paid', 'partially_paid', 'authorized'].includes(String(order.financial_status).toLowerCase())) return { credited: [] };
  const credited = [];

  // 1. A community order through a centre's link (discount code prefix VC-).
  const codes = (order.discount_codes || []).map(c => (typeof c === 'string' ? c : c.code)).filter(Boolean);
  for (const code of codes) {
    const known = await discounts.centreForCode(code);
    if (!known) continue;
    const centre = await centres.getById(known.centre_id);
    if (!centre) continue;
    const subtotal = Math.round(parseFloat(order.subtotal_price ?? order.current_subtotal_price ?? 0) * 100);
    const box = await openBoxFor(centre);
    const row = await credit({ centre, box, kind: 'order_credit', amountCents: money.orderCreditCents(subtotal), sourceType: 'shopify_order', sourceId: orderId, detail: { code, subtotal_cents: subtotal, order_number: order.order_number || order.name } });
    await db().from('vc_discount_codes').update({ order_id: orderId, used_at: new Date().toISOString() }).eq('code', known.code).is('order_id', null);
    if (row) { credited.push({ ...row, centre, box }); await logEvent(centre.id, 'system', 'ledger.order_credit', { order: orderId, cents: row.amount_cents }); }
  }

  // 2. Sponsorship and centre top-up line items.
  const s = await sponsorship.settings();
  const items = lineItems || order.line_items || [];
  let orderAttrs = sponsorship.readOrderAttributes(order);
  // Mirror rows carry no note attributes; fetch them from Shopify when a sponsorship line has no properties of its own.
  if (!orderAttrs.slug && items.some(li => sponsorship.readLineItem(li, s) && !sponsorship.readLineItem(li, s).slug)) {
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
    const row = await credit({ centre, box, kind: read.kind, amountCents: read.amountCents, sourceType: 'shopify_line_item', sourceId: read.lineItemId || `${orderId}-${read.kind}`, detail: { order: orderId, order_number: order.order_number || order.name, email: order.email || order.customer_email || null, intended_box: read.boxNumber } });
    if (row) { credited.push({ ...row, centre, box }); await logEvent(centre.id, 'system', `ledger.${read.kind}`, { order: orderId, cents: row.amount_cents }); }
  }

  if (emit && credited.length) await notify(credited, order);
  return { credited };
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
  const orders = must(await db().from('orders').select('shopify_order_id, order_number, customer_email, discount_codes, subtotal_price, financial_status, created_at').gte('created_at', since).order('created_at'), 'orders');
  let checked = 0, credited = 0;
  for (const o of orders) {
    const codes = (o.discount_codes || []).map(c => (typeof c === 'string' ? c : c.code)).filter(c => /^VC-/i.test(c || ''));
    let lineItems = [];
    if (variantIds.length) {
      lineItems = must(await db().from('order_line_items').select('shopify_line_item_id, shopify_variant_id, quantity, unit_price, custom_attributes').eq('shopify_order_id', o.shopify_order_id).in('shopify_variant_id', variantIds), 'line items');
    }
    if (!codes.length && !lineItems.length) continue;
    checked++;
    const { credited: rows } = await recordOrder({
      id: String(o.shopify_order_id).split('/').pop(), order_number: o.order_number, email: o.customer_email,
      discount_codes: codes, subtotal_price: o.subtotal_price, financial_status: o.financial_status,
    }, { lineItems, emit: false });
    credited += rows.length;
  }
  return { checked, credited };
}

module.exports = { recordOrder, reconcile, credit };
