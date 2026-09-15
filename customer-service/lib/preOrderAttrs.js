/**
 * Pre-order line-item attributes for order-creation tools.
 *
 * The storefront Pre-Order Now app stamps every pre-order line item with a
 * `Pre-order` customAttribute (e.g. "Target availability end of August, 2026.").
 * Orders we create ourselves (exchanges, free/replacement orders, invoices,
 * split shipments) bypass the app, so a known pre-order line must carry the
 * same attribute — otherwise the daily unnotified-pre-order sweep
 * (reports/lib/unnotifiedPreOrder.js) sees an OOS line with no attribute and
 * drafts outreach to a customer who was already told.
 */

const productCache = require('./productCache');

const PRE_ORDER_ATTR_KEY = 'Pre-order';
const PRE_ORDER_FALLBACK_VALUE = 'Will ship when in stock';

/**
 * "2026-08-28" → "end of August, 2026" (beginning/middle/end by day of month).
 */
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

/**
 * Attribute value for a pre-order line — app-identical when a date is known,
 * generic fallback otherwise.
 *
 * `targetDate` (YYYY-MM-DD) is an operator-stated availability date and wins
 * over the variant's own pre-order date: the variant metafield is the promise
 * shown at checkout, and an order re-issued as a pre-order after the fact is
 * routinely stamped with a date the variant never carried (a free replacement
 * on a product not on web pre-order, say). An unparseable targetDate throws
 * rather than degrading to the fallback, because "Will ship when in stock" on
 * a line the operator just dated is a silent broken promise.
 */
function preOrderAttrValue(sku, { targetDate } = {}) {
  if (targetDate != null && targetDate !== '') {
    const formatted = formatPreOrderDate(targetDate);
    if (!formatted) throw new Error(`Invalid pre-order target date "${targetDate}" — expected YYYY-MM-DD.`);
    return `Target availability ${formatted}.`;
  }
  const variant = sku ? productCache.getVariantBySku(sku) : null;
  const formatted = formatPreOrderDate(variant?.preOrderDate);
  return formatted ? `Target availability ${formatted}.` : PRE_ORDER_FALLBACK_VALUE;
}

/**
 * customAttributes for a resolved line item when catalog stock can't cover the
 * requested quantity (the same signal the daily sweep keys on), else null.
 * Unknown inventory (custom items, by-ID misses) returns null — never guess.
 */
function preOrderLineAttributes({ sku, inventoryQuantity, quantity = 1 }) {
  if (inventoryQuantity == null || inventoryQuantity >= quantity) return null;
  return [{ key: PRE_ORDER_ATTR_KEY, value: preOrderAttrValue(sku) }];
}

module.exports = {
  PRE_ORDER_ATTR_KEY,
  PRE_ORDER_FALLBACK_VALUE,
  formatPreOrderDate,
  preOrderAttrValue,
  preOrderLineAttributes,
};
