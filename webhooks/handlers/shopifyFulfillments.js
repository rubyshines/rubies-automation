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
  const newFulfillment = {
    status: payload.status?.toUpperCase() || null,
    createdAt: payload.created_at || null,
    deliveredAt: null,
    trackingNumber: payload.tracking_number || payload.tracking_numbers?.[0] || null,
    trackingUrl: payload.tracking_url || payload.tracking_urls?.[0] || null,
    locationId: payload.location_id ? String(payload.location_id) : null,
  };

  // Merge into existing fulfillments array
  const existingFulfillments = existingOrder.fulfillments || [];
  const fulfillmentId = String(payload.id);

  // Replace existing entry with same ID or append
  let found = false;
  const updatedFulfillments = existingFulfillments.map(f => {
    // Match by tracking number since we don't store fulfillment ID
    if (f.trackingNumber && f.trackingNumber === newFulfillment.trackingNumber) {
      found = true;
      return { ...f, ...newFulfillment };
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
