/**
 * Shopify orders/create + orders/updated webhook handler
 *
 * Normalizes REST payload → Supabase rows, upserts order + line items.
 * Mirrors the upsert logic in customer-service/sync/syncAll.js.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { normalizeOrderRow, normalizeLineItemRows, toGid } = require('../lib/normalize');
const { upsertCustomerRow } = require('../lib/customerUpsert');

async function handle(topic, payload) {
  const supabase = getSupabaseClient();
  const orderRow = normalizeOrderRow(payload);

  console.log(`[shopify-orders] ${topic} #${orderRow.order_number} (${orderRow.customer_email || 'no email'})`);

  // Ensure customer exists (id-first upsert so an email change renames the
  // existing row instead of forking a duplicate — see lib/customerUpsert.js)
  if (orderRow.customer_email) {
    try {
      await upsertCustomerRow(supabase, {
        email: orderRow.customer_email,
        shopify_customer_id: payload.customer?.id ? toGid('Customer', payload.customer.id) : null,
        first_name: payload.customer?.first_name || null,
        last_name: payload.customer?.last_name || null,
        synced_at: new Date().toISOString(),
      });
    } catch (custErr) {
      console.error(`[shopify-orders] Customer upsert error: ${custErr.message}`);
    }
  }

  // Preserve fulfillment fields the REST webhook doesn't carry
  // (events, displayStatus, inTransitAt, deliveredAt, etc.) by merging from
  // the existing Supabase row. Without this, every orders/update would wipe
  // the rich fulfillment data populated by the GraphQL daily sync and the
  // fulfillments-update webhook.
  if (orderRow.fulfillments?.length) {
    const { data: existing } = await supabase
      .from('orders')
      .select('fulfillments')
      .eq('shopify_order_id', orderRow.shopify_order_id)
      .maybeSingle();
    const existingFulfillments = existing?.fulfillments || [];
    orderRow.fulfillments = orderRow.fulfillments.map(f => {
      const match = existingFulfillments.find(e => e.trackingNumber && e.trackingNumber === f.trackingNumber);
      if (!match) return f;
      return {
        ...match,
        ...f,
        deliveredAt: f.deliveredAt || match.deliveredAt || null,
        events: f.events?.length ? f.events : (match.events || []),
        displayStatus: f.displayStatus || match.displayStatus || null,
        inTransitAt: f.inTransitAt || match.inTransitAt || null,
        estimatedDeliveryAt: f.estimatedDeliveryAt || match.estimatedDeliveryAt || null,
      };
    });
  }

  // Upsert order
  const { error: orderErr } = await supabase
    .from('orders')
    .upsert(orderRow, { onConflict: 'shopify_order_id' });

  if (orderErr) {
    throw new Error(`Order upsert failed: ${orderErr.message}`);
  }

  // Idempotent line-item sync (race-safe under concurrent webhook deliveries):
  // upsert by shopify_line_item_id (stable per-line-item ID), then orphan-clean
  // any rows for this order whose IDs aren't in the current payload — also
  // catches legacy null-ID rows from before the migration.
  const lineItemRows = normalizeLineItemRows(payload);
  if (lineItemRows.length > 0) {
    const { error: liErr } = await supabase
      .from('order_line_items')
      .upsert(lineItemRows, { onConflict: 'shopify_line_item_id' });
    if (liErr) {
      console.error(`[shopify-orders] Line items upsert error: ${liErr.message}`);
    }
  }

  // Defensive orphan cleanup — only run when the current set is non-empty,
  // otherwise we'd wipe every line item row for the order on a payload that
  // happens to lack line_items (malformed webhook, future filter bug, etc).
  const currentLineItemIds = lineItemRows.map(r => r.shopify_line_item_id).filter(Boolean);
  if (currentLineItemIds.length > 0) {
    const { error: orphanErr } = await supabase
      .from('order_line_items')
      .delete()
      .eq('shopify_order_id', orderRow.shopify_order_id)
      .or(
        `shopify_line_item_id.is.null,shopify_line_item_id.not.in.(${currentLineItemIds.map(s => `"${s}"`).join(',')})`
      );
    if (orphanErr) {
      console.error(`[shopify-orders] Orphan cleanup error: ${orphanErr.message}`);
    }
  } else if (lineItemRows.length === 0) {
    console.warn(`[shopify-orders] Skipping orphan cleanup for #${orderRow.order_number} — payload had no line_items (defensive)`);
  }

  console.log(`[shopify-orders] Upserted order #${orderRow.order_number} with ${lineItemRows.length} line items`);
}

module.exports = { handle };
