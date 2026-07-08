/**
 * Shopify fulfillments/create + fulfillments/update webhook handler
 *
 * Updates the orders table with fulfillment status and tracking info.
 * Patches the fulfillments JSONB array on the order row.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { toGid } = require('../lib/normalize');

async function handle(topic, payload) {
  const supabase = getSupabaseClient();

  const orderIdNumeric = payload.order_id;
  if (!orderIdNumeric) {
    console.warn('[shopify-fulfillments] No order_id in payload — skipping');
    return;
  }

  const orderGid = toGid('Order', orderIdNumeric);
  console.log(`[shopify-fulfillments] ${topic} order=${orderIdNumeric} status=${payload.status}`);

  // Fetch existing order row
  const { data: existingOrder, error: fetchErr } = await supabase
    .from('orders')
    .select('fulfillments, fulfillment_status')
    .eq('shopify_order_id', orderGid)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Order fetch failed: ${fetchErr.message}`);
  }

  if (!existingOrder) {
    // Order not yet synced — will be caught by daily sync or orders webhook
    console.warn(`[shopify-fulfillments] Order ${orderIdNumeric} not in Supabase yet — skipping`);
    return;
  }

  // Build the new fulfillment entry
  const now = new Date().toISOString();
  const newFulfillment = {
    status: payload.status?.toUpperCase() || null,
    shipmentStatus: payload.shipment_status || null,
    lastEventAt: now,
    createdAt: payload.created_at || null,
    deliveredAt: payload.shipment_status === 'delivered' ? now : null,
    trackingNumber: payload.tracking_number || payload.tracking_numbers?.[0] || null,
    trackingUrl: payload.tracking_url || payload.tracking_urls?.[0] || null,
    trackingCompany: payload.tracking_company || null,
    locationId: payload.location_id ? String(payload.location_id) : null,
  };

  // Merge into existing fulfillments array
  const existingFulfillments = existingOrder.fulfillments || [];
  const fulfillmentId = String(payload.id);
  // Store the Shopify fulfillment id so later update events match this entry
  // even without a tracking number — tracking-only matching made no-tracking
  // fulfillments re-append a duplicate on every update event.
  newFulfillment.shopifyFulfillmentId = fulfillmentId;

  // Replace existing entry with same fulfillment id (or same tracking number,
  // for entries written before the id was stored) or append
  let found = false;
  const updatedFulfillments = existingFulfillments.map(f => {
    const idMatch = f.shopifyFulfillmentId && f.shopifyFulfillmentId === fulfillmentId;
    const trackingMatch = f.trackingNumber && f.trackingNumber === newFulfillment.trackingNumber;
    if (idMatch || trackingMatch) {
      found = true;
      // Preserve fields the REST payload doesn't carry: events, displayStatus,
      // inTransitAt, estimatedDeliveryAt (populated by daily GraphQL sync), and
      // deliveredAt (set by the Passport scraper when the carrier confirms).
      const merged = { ...f, ...newFulfillment };
      if (f.deliveredAt && !newFulfillment.deliveredAt) merged.deliveredAt = f.deliveredAt;
      if (f.events?.length) merged.events = f.events;
      if (f.displayStatus && !newFulfillment.displayStatus) merged.displayStatus = f.displayStatus;
      if (f.inTransitAt && !newFulfillment.inTransitAt) merged.inTransitAt = f.inTransitAt;
      if (f.estimatedDeliveryAt && !newFulfillment.estimatedDeliveryAt) merged.estimatedDeliveryAt = f.estimatedDeliveryAt;
      return merged;
    }
    return f;
  });
  if (!found) {
    updatedFulfillments.push(newFulfillment);
  }

  // Determine overall fulfillment status
  // If any fulfillment exists, mark as at least PARTIALLY_FULFILLED
  // A more accurate determination would need total items vs fulfilled items
  const fulfillmentStatus = payload.shipment_status === 'delivered'
    ? 'FULFILLED'
    : updatedFulfillments.length > 0
      ? (existingOrder.fulfillment_status === 'FULFILLED' ? 'FULFILLED' : 'PARTIALLY_FULFILLED')
      : 'UNFULFILLED';

  const updateData = {
    fulfillments: updatedFulfillments,
    synced_at: new Date().toISOString(),
  };

  // Only update fulfillment_status if we have higher confidence
  // (don't downgrade FULFILLED to PARTIALLY_FULFILLED)
  if (fulfillmentStatus === 'FULFILLED' || existingOrder.fulfillment_status === 'UNFULFILLED') {
    updateData.fulfillment_status = fulfillmentStatus;
  }

  // Set fulfilled_at if this is the first fulfillment
  if (!existingOrder.fulfillments?.length && newFulfillment.createdAt) {
    updateData.fulfilled_at = newFulfillment.createdAt;
  }

  const { error: updateErr } = await supabase
    .from('orders')
    .update(updateData)
    .eq('shopify_order_id', orderGid);

  if (updateErr) {
    throw new Error(`Order fulfillment update failed: ${updateErr.message}`);
  }

  console.log(`[shopify-fulfillments] Updated order ${orderIdNumeric} — ${updatedFulfillments.length} fulfillment(s)`);
}

module.exports = { handle };
