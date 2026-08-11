/**
 * exchangeMath.js — deterministic price math for "exchange with a difference".
 *
 * Pure functions, no network. Given the new items the customer is getting, the
 * active managed_discounts (volume + sale), and the return credit (what they
 * actually paid for the returned items, from Shopify's refund calc), compute the
 * discounted new-item prices and the signed net difference.
 *
 * Combination rule (mirrors the storefront automatic-discount behavior, which
 * Shopify will NOT apply to API-created draft orders): per line item, the
 * effective discount is the HIGHER of the applicable volume % and the applicable
 * sale % — never stacked. Volume is per-SKU-prefix on summed quantity; sale is
 * treated as order-level (store-wide) flat or subtotal-tier.
 *
 * Direction:
 *   net > 0  → 'invoice' (customer owes the difference)
 *   net < 0  → 'refund'  (customer is owed the difference)
 *   net == 0 → 'even'
 */

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Highest volume-tier percentage whose quantity threshold is met (0 if none). */
function volumePctForQuantity(quantity, tiers = []) {
  let pct = 0;
  for (const t of tiers) {
    if (quantity >= t.threshold && t.percentage > pct) pct = t.percentage;
  }
  return pct;
}

/**
 * Applicable sale percentage for a store-wide sale, given the full-price subtotal.
 * Flat sale = single tier with threshold 0. Subtotal tiers pick the highest tier
 * whose threshold (subtotal floor) is met. Returns 0 when no sale.
 */
function salePctForSubtotal(sale, subtotalFullPrice) {
  if (!sale || !Array.isArray(sale.tiers)) return 0;
  let pct = 0;
  for (const t of sale.tiers) {
    if (subtotalFullPrice >= t.threshold && t.percentage > pct) pct = t.percentage;
  }
  return pct;
}

/** Find the volume discount row (if any) whose SKU prefix matches this sku. */
function volumeDiscountForSku(sku, volumeDiscounts = []) {
  const upper = String(sku || '').toUpperCase();
  return volumeDiscounts.find((d) =>
    (d.sku_prefixes || []).some((p) => upper.startsWith(String(p).toUpperCase())),
  ) || null;
}

/**
 * Compute discounted prices for the new items and the signed net difference.
 *
 * @param {Object} args
 * @param {Array<{sku:string, unitPrice:number, quantity:number}>} args.newItems
 * @param {number} args.returnCredit  Actual amount paid for returned items (Shopify refund calc).
 * @param {Array} [args.volumeDiscounts]  managed_discounts rows, kind='volume'.
 * @param {Object|null} [args.sale]  Active managed_discounts row, kind='sale', or null.
 * @returns {{lines:Array, newSubtotal:number, returnCredit:number, net:number, direction:string}}
 */
function computeExchangeDifference({ newItems = [], returnCredit = 0, volumeDiscounts = [], sale = null }) {
  // Full-price subtotal first — the sale's subtotal tiers key off the pre-discount total.
  const subtotalFullPrice = round2(
    newItems.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0),
  );
  const salePct = salePctForSubtotal(sale, subtotalFullPrice);

  // Sum quantity per matched volume-discount row, so the tier sees the whole order.
  const qtyByDiscount = new Map();
  for (const it of newItems) {
    const d = volumeDiscountForSku(it.sku, volumeDiscounts);
    if (d) qtyByDiscount.set(d, (qtyByDiscount.get(d) || 0) + it.quantity);
  }

  const lines = newItems.map((it) => {
    const d = volumeDiscountForSku(it.sku, volumeDiscounts);
    const volumePct = d ? volumePctForQuantity(qtyByDiscount.get(d) || 0, d.tiers) : 0;
    const effectivePct = Math.max(volumePct, salePct);
    const lineTotal = round2(it.unitPrice * it.quantity * (1 - effectivePct / 100));
    return {
      sku: it.sku,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      volumePct,
      salePct,
      effectivePct,
      lineTotal,
    };
  });

  const newSubtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const net = round2(newSubtotal - returnCredit);
  const direction = net > 0 ? 'invoice' : net < 0 ? 'refund' : 'even';

  return { lines, newSubtotal, returnCredit: round2(returnCredit), net, direction };
}

/**
 * Decide what to actually do, encoding the policy Jamie set:
 *   - straight swap (identical items) → free exchange, never a difference calc
 *   - net < 0 (customer is owed) → ALWAYS refund, no instruction needed
 *   - net > 0 (customer owes) → invoice ONLY if the operator explicitly asked;
 *     otherwise free exchange (we absorb the upcharge)
 *   - net == 0 → free exchange
 *
 * @returns {'free_exchange'|'invoice'|'refund'}
 */
function recommendExchangeAction({ net = 0, itemsIdentical = false, operatorRequestedInvoice = false }) {
  if (itemsIdentical) return 'free_exchange';
  if (net < 0) return 'refund';
  if (net > 0) return operatorRequestedInvoice ? 'invoice' : 'free_exchange';
  return 'free_exchange';
}

/**
 * Upcharge we absorb rather than chase, in USD. `net` comes from Shopify
 * shopMoney, which is the store's BASE currency (USD) regardless of what the
 * customer was presented — so this compares like with like. (Jamie, 2026-08-11:
 * "in general I let them slide if they are a small difference".)
 */
const EXCHANGE_WAIVE_THRESHOLD_USD = 15;

/**
 * The customer-facing settlement, decided in code so the advisor never has to
 * judge it — and never has to see a dollar figure it could paste into a draft.
 * This is the advisor's view of the same policy `recommendExchangeAction`
 * gives the operator agent, with the threshold standing in for the operator's
 * explicit ask:
 *   - identical items or net 0 → 'even'   (straight swap, say nothing)
 *   - net < 0                  → 'refund' (always, automatic)
 *   - 0 < net <= threshold     → 'waive'  (we absorb it; tell them not to worry)
 *   - net > threshold          → 'invoice'
 *
 * `customerAskedToPay` is a fact the advisor reads out of the conversation —
 * a customer who insists on paying gets to. It is an INPUT rather than an
 * exception the model has to remember to apply on top of a verdict: as a
 * trailing prompt rule it lost to the verdict on the first live run, which is
 * the documented failure mode of exceptions buried under positive rules.
 * It only ever turns a waive into an invoice; being owed money still refunds.
 *
 * @returns {'even'|'refund'|'waive'|'invoice'}
 */
function settleExchange({
  net = 0,
  itemsIdentical = false,
  customerAskedToPay = false,
  thresholdUsd = EXCHANGE_WAIVE_THRESHOLD_USD,
}) {
  if (itemsIdentical) return 'even';
  if (net < 0) return 'refund';
  if (net === 0) return 'even';
  if (customerAskedToPay) return 'invoice';
  return net > thresholdUsd ? 'invoice' : 'waive';
}

/** True when the returned set and the new set are the same SKUs at the same quantities. */
function itemSetsIdentical(returnItems = [], newItems = []) {
  const norm = (arr) => {
    const m = new Map();
    for (const it of arr) {
      const k = String(it.sku || '').toUpperCase();
      m.set(k, (m.get(k) || 0) + (it.quantity || 0));
    }
    return m;
  };
  const a = norm(returnItems);
  const b = norm(newItems);
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

module.exports = {
  computeExchangeDifference,
  recommendExchangeAction,
  settleExchange,
  EXCHANGE_WAIVE_THRESHOLD_USD,
  itemSetsIdentical,
  volumePctForQuantity,
  salePctForSubtotal,
  volumeDiscountForSku,
  round2,
};
