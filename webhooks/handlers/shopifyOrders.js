/**
 * Shopify orders/create + orders/updated webhook handler
 *
 * Normalizes REST payload → Supabase rows, upserts order + line items.
 * Mirrors the upsert logic in customer-service/sync/syncAll.js.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { normalizeOrderRow, normalizeLineItemRows, toGid } = require('../lib/normalize');

async function handle(topic, payload) {
  const supabase = getSupabaseClient();
  const orderRow = normalizeOrderRow(payload);

  console.log(`[shopify-orders] ${topic} #${orderRow.order_number} (${orderRow.customer_email || 'no email'})`);

  // Ensure customer exists
  if (orderRow.customer_email) {
    const { error: custErr } = await supabase
      .from('customers')
      .upsert({
        email: orderRow.customer_email,
        shopify_customer_id: payload.customer?.id ? toGid('Customer', payload.customer.id) : null,
        first_name: payload.customer?.first_name || null,
        last_name: payload.customer?.last_name || null,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'email' });

    if (custErr) {
      console.error(`[shopify-orders] Customer upsert error: ${custErr.message}`);
    }
  }

  // Upsert order
  const { error: orderErr } = await supabase
    .from('orders')
    .upsert(orderRow, { onConflict: 'shopify_order_id' });

  if (orderErr) {
    throw new Error(`Order upsert failed: ${orderErr.message}`);
  }

  // Delete + re-insert line items (same strategy as syncAll.js)
  await supabase
    .from('order_line_items')
    .delete()
    .eq('shopify_order_id', orderRow.shopify_order_id);

  const lineItemRows = normalizeLineItemRows(payload);
  if (lineItemRows.length > 0) {
    const { error: liErr } = await supabase
      .from('order_line_items')
      .insert(lineItemRows);

    if (liErr) {
      console.error(`[shopify-orders] Line items error: ${liErr.message}`);
    }
  }

  console.log(`[shopify-orders] Upserted order #${orderRow.order_number} with ${lineItemRows.length} line items`);
}

module.exports = { handle };
