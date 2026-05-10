/**
 * Sync order_fulfillment_costs.customer_shipping_usd from orders.total_shipping.
 * Idempotent — only updates rows where the value differs.
 */
if (!process.env.SUPABASE_URL) require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

async function syncCustomerShippingFees() {
  const sb = getSupabaseClient();

  // Pull all orders -> total_shipping
  let orders = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('orders').select('order_number, total_shipping').range(from, from + 999);
    if (error) throw error;
    orders = orders.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`Orders: ${orders.length}`);
  const shipMap = {};
  for (const o of orders) shipMap[o.order_number] = +o.total_shipping || 0;

  // Pull all OFC rows
  let ofc = [];
  from = 0;
  while (true) {
    const { data, error } = await sb.from('order_fulfillment_costs').select('order_number, customer_shipping_usd').range(from, from + 999);
    if (error) throw error;
    ofc = ofc.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`OFC rows: ${ofc.length}`);

  // Build update list — only update where the new value differs
  const updates = [];
  for (const r of ofc) {
    const newVal = shipMap[r.order_number];
    if (newVal === undefined) continue; // order not in orders table
    const cur = +r.customer_shipping_usd || 0;
    if (Math.abs(newVal - cur) > 0.01) {
      updates.push({ order_number: r.order_number, customer_shipping_usd: newVal });
    }
  }
  console.log(`Updates needed: ${updates.length}`);

  let written = 0;
  for (const u of updates) {
    const { error } = await sb
      .from('order_fulfillment_costs')
      .update({ customer_shipping_usd: u.customer_shipping_usd })
      .eq('order_number', u.order_number);
    if (error) console.error(`  Failed #${u.order_number}: ${error.message}`);
    else written++;
    if (written % 500 === 0) process.stdout.write(`\r  Written ${written}/${updates.length}...`);
  }
  console.log(`\nDone! ${written}/${updates.length} updated.`);
}

if (require.main === module) {
  syncCustomerShippingFees().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { syncCustomerShippingFees };
