/**
 * Delivery refresh — re-pull live Shopify fulfillment status for an order and
 * write it back to orders.fulfillments.
 *
 * Why this exists: syncAll's order sync is driven by a Shopify `updated_at`
 * high-water mark. A carrier DELIVERED event does not reliably bump an order's
 * `updated_at` (and can land moments after an unrelated bump like archiving),
 * so a delivery that arrives after the order's last sync is never re-fetched —
 * the row stays frozen mid-transit forever. That makes delivered orders look
 * "stuck"/"likely lost" in the daily report and makes the CS advisor tell
 * customers a delivered order is still in transit. This module re-fetches the
 * order directly (by name, not by the updated_at window) so stale rows self-heal.
 *
 * normalizeFulfillments is the single source of truth for the stored fulfillment
 * shape — syncAll uses it too, so the refresh can never drift from the sync.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

/**
 * Map Shopify GraphQL fulfillments onto our stored shape, merging against what's
 * already stored. Shopify is the base (carrier events incl. DELIVERED); stored
 * events whose timestamp Shopify doesn't have are Passport-scraper extras and are
 * preserved. Passport-only fields (lastLocation/localCarrier/customsCleared/…)
 * are preserved from the existing row because the GraphQL view doesn't carry them.
 *
 * @param {Array} shopifyFulfillments  raw `order.fulfillments` from the GraphQL query
 * @param {Array} existingFulfillments stored `orders.fulfillments` (for the merge)
 */
function normalizeFulfillments(shopifyFulfillments, existingFulfillments = []) {
  return (shopifyFulfillments || []).map(f => {
    const trackingNumber = f.trackingInfo?.[0]?.number || null;
    const shopifyEvents = (f.events?.edges || []).map(e => ({
      happenedAt: e.node.happenedAt,
      status: e.node.status,
      message: e.node.message,
    }));
    const existing = (existingFulfillments || []).find(e => e.trackingNumber && e.trackingNumber === trackingNumber);
    // Pure count comparison caused a race: DELIVERED arrived in Shopify at the
    // same sync run that advanced the high-water mark past these orders, so
    // stored.length >= shopify.length kept stale events indefinitely. Merge by
    // timestamp instead — Shopify base + stored extras Shopify never saw.
    const shopifyTimestamps = new Set(shopifyEvents.map(e => e.happenedAt));
    const scraperExtras = (existing?.events || []).filter(e => e.happenedAt && !shopifyTimestamps.has(e.happenedAt));
    const events = shopifyEvents.length > 0
      ? [...shopifyEvents, ...scraperExtras]
      : (existing?.events || []);
    return {
      status: f.status,
      displayStatus: f.displayStatus || existing?.displayStatus || null,
      createdAt: f.createdAt,
      deliveredAt: f.deliveredAt || existing?.deliveredAt || null,
      inTransitAt: f.inTransitAt || existing?.inTransitAt || null,
      estimatedDeliveryAt: f.estimatedDeliveryAt || existing?.estimatedDeliveryAt || null,
      trackingNumber,
      trackingUrl: f.trackingInfo?.[0]?.url || null,
      trackingCompany: f.trackingInfo?.[0]?.company || null,
      // getOrderByNumber doesn't fetch fulfillment.location, so preserve the
      // stored id rather than wiping it on a refresh.
      locationId: f.location?.legacyResourceId || existing?.locationId || null,
      // Passport-only extras (set by syncPassportDelivery; preserve here).
      lastLocation: existing?.lastLocation || null,
      localCarrier: existing?.localCarrier || null,
      localTrackingNumber: existing?.localTrackingNumber || null,
      customsCleared: typeof existing?.customsCleared === 'boolean' ? existing.customsCleared : null,
      events,
    };
  });
}

/**
 * Re-fetch one order's fulfillment state live from Shopify and persist it.
 * Fail-soft: on any Shopify/DB error returns the order's existing fulfillments
 * so the caller can carry on with stale-but-usable data.
 *
 * @returns {Promise<{refreshed:boolean, persisted?:boolean, fulfillments:Array, error?:string}>}
 */
async function refreshOrderDelivery(order, { supabase = getSupabaseClient(), getOrder } = {}) {
  const fetchOrder = getOrder || require('../shopify').getOrderByNumber;
  let live;
  try {
    live = await fetchOrder(order.order_number);
  } catch (err) {
    return { refreshed: false, fulfillments: order.fulfillments || [], error: err.message };
  }
  const normalized = normalizeFulfillments(live?.fulfillments, order.fulfillments || []);
  // Supabase returns { error } rather than throwing, so the old try/catch never
  // caught a failed write and always reported persisted:true. Check the error.
  let error;
  try {
    ({ error } = await supabase
      .from('orders')
      .update({ fulfillments: normalized.length ? normalized : null })
      .eq('shopify_order_id', order.shopify_order_id));
  } catch (err) {
    error = err;
  }
  if (error) {
    return { refreshed: true, persisted: false, fulfillments: normalized, error: error.message };
  }
  return { refreshed: true, persisted: true, fulfillments: normalized };
}

module.exports = { normalizeFulfillments, refreshOrderDelivery };
