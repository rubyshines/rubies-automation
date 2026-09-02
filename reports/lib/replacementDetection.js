/**
 * Replacement-order detection for stuck shipments.
 *
 * When a shipment goes bad (undeliverable, returned to sender, lost), the
 * operator's normal fix is to duplicate the order in Shopify admin and ship
 * the copy free. That copy carries no link back to the original — Shopify
 * doesn't record "reship of" — so the stuck order kept alerting until someone
 * resolved it by hand. The fingerprint is strong enough to close the loop:
 * a newer, non-cancelled order for the same customer that covers every line
 * (SKU + quantity) of the stuck order.
 *
 *   - $0 total → unambiguous reship → auto-resolve the stuck alert
 *   - paid     → could be a reship the customer was charged for, or just a
 *                repeat purchase → tag the alert for the operator, never resolve
 *
 * A $0 same-SKU order can't be confused with an exchange: exchanges swap to a
 * DIFFERENT variant, so their SKU set never covers the original's.
 *
 * Pure matching lives here; the queries and the note write stay in
 * checkShippingDelays() so this file is testable without a database.
 */

/** SKU → total quantity across lines. Lines without a SKU are ignored. */
function lineMultiset(lines) {
  const m = new Map();
  for (const li of lines || []) {
    if (!li || !li.sku) continue;
    m.set(li.sku, (m.get(li.sku) || 0) + (li.quantity || 0));
  }
  return m;
}

/**
 * True when the candidate's lines include every (SKU, quantity) of the
 * original's. Coverage, not equality: a reship sometimes adds an extra item.
 * An original with no SKU data can never claim coverage — an empty set is
 * trivially "covered" by anything, which would auto-resolve on no evidence.
 */
function coversAllLines(originalLines, candidateLines) {
  const orig = lineMultiset(originalLines);
  if (orig.size === 0) return false;
  const cand = lineMultiset(candidateLines);
  for (const [sku, qty] of orig) {
    if ((cand.get(sku) || 0) < qty) return false;
  }
  return true;
}

/**
 * Match stuck orders against the customer's newer orders.
 *
 * @param {Object} args
 * @param {Array} args.stuckOrders     — orders behind active stuck-shipment
 *   alerts: { order_number, shopify_order_id, customer_email, created_at }
 * @param {Array} args.candidateOrders — the same customers' other orders:
 *   { order_number, shopify_order_id, customer_email, created_at, total_price,
 *     fulfillment_status, cancelled_at }
 * @param {Object} args.linesByShopifyId — shopify_order_id → [{ sku, quantity }]
 *   for every stuck AND candidate order
 * @param {Set}   args.alertNums — order numbers currently alerting themselves;
 *   a paid candidate that is itself stuck is a second delayed purchase, not a
 *   replacement, so it never tags. ($0 stuck candidates still resolve: a
 *   reship that is itself delayed is still the reship.)
 * @returns {Array<{ order_number, action: 'resolve'|'tag', replacement }>}
 */
function matchReplacements({ stuckOrders, candidateOrders, linesByShopifyId, alertNums = new Set() }) {
  const results = [];

  for (const stuck of stuckOrders || []) {
    const email = (stuck.customer_email || '').toLowerCase();
    if (!email || !stuck.created_at) continue;
    const stuckLines = linesByShopifyId[stuck.shopify_order_id] || [];

    const matches = (candidateOrders || []).filter(c =>
      c.order_number !== stuck.order_number &&
      !c.cancelled_at &&
      (c.customer_email || '').toLowerCase() === email &&
      c.created_at && c.created_at > stuck.created_at &&
      coversAllLines(stuckLines, linesByShopifyId[c.shopify_order_id] || []),
    );
    if (!matches.length) continue;

    const free = matches
      .filter(c => Number(c.total_price) === 0)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (free.length) {
      // Earliest free match = the reship that answered this incident.
      results.push({ order_number: stuck.order_number, action: 'resolve', replacement: pick(free[0], 'reshipped_free') });
      continue;
    }

    const paid = matches
      .filter(c => !alertNums.has(c.order_number))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (paid.length) {
      results.push({ order_number: stuck.order_number, action: 'tag', replacement: pick(paid[0], 'paid_lookalike') });
    }
  }

  return results;
}

function pick(order, kind) {
  return {
    order_number: order.order_number,
    created_at: order.created_at,
    total_price: order.total_price,
    fulfillment_status: order.fulfillment_status,
    kind,
  };
}

module.exports = { lineMultiset, coversAllLines, matchReplacements };
