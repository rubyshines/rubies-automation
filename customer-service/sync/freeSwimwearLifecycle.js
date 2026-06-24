/**
 * Free Swimwear lifecycle reconcile — replaces the legacy Apps Script's
 * registration/order/expire/resend passes. For every still-open application
 * (accepted/registered), look up the Shopify customer + orders and advance:
 *   accepted → registered (customer exists) → ordered (customer has an order)
 *   accepted/registered → expired (past the 30-day window)
 *   resend the acceptance email on the 7-day / <3-attempt cadence
 *
 * Idempotent; only touches rows needing work. Dry-run by default.
 *
 * Usage:
 *   node customer-service/sync/freeSwimwearLifecycle.js          # dry-run
 *   node customer-service/sync/freeSwimwearLifecycle.js --live   # apply + send resends
 */

require('dotenv').config();
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { searchCustomers, getCustomerOrders } = require('../lib/shopify');
const { decideLifecycle, sendResend } = require('../lib/freeSwimwear');

const TABLE = 'free_swimwear_requests';

async function lookupShopify(email) {
  const customers = await searchCustomers(`email:${email}`);
  const customer = customers[0] || null;
  if (!customer) return { customer: null, orders: [] };
  let orders = [];
  try {
    const res = await getCustomerOrders(customer.id, 10);
    orders = res.orders || [];
  } catch (_) { /* customer with no orders or transient — treat as none */ }
  return { customer: { id: customer.id, createdAt: customer.createdAt }, orders };
}

async function main() {
  const live = process.argv.slice(2).includes('--live');
  const now = new Date();
  const supabase = getSupabaseClient();

  const { data: rows, error } = await supabase
    .from(TABLE)
    .select('*')
    .in('status', ['accepted', 'registered']);
  if (error) throw new Error(error.message);

  console.log(`[freeSwimwearLifecycle] ${rows.length} open rows; ${live ? 'LIVE' : 'DRY RUN'}`);
  const counts = { registered: 0, ordered: 0, expired: 0, resend: 0, none: 0 };

  for (const row of rows) {
    const { customer, orders } = await lookupShopify(row.email);
    const { action, patch } = decideLifecycle(row, { customer, orders, now });
    counts[action] = (counts[action] || 0) + 1;
    if (action === 'none') continue;

    console.log(`  #${row.id} ${row.email} → ${action}`);
    if (!live) continue;

    if (action === 'resend') {
      const result = await sendResend(row, patch._daysLeft, now);
      await supabase.from(TABLE).update(result.patch).eq('id', row.id);
    } else {
      const { _daysLeft, ...dbPatch } = patch;
      if (Object.keys(dbPatch).length) await supabase.from(TABLE).update(dbPatch).eq('id', row.id);
    }
  }

  console.log('[freeSwimwearLifecycle] actions:', JSON.stringify(counts));
  if (!live) console.log('[freeSwimwearLifecycle] DRY RUN — pass --live to apply + send.');
}

main().catch(err => {
  console.error('[freeSwimwearLifecycle] FAILED:', err.message);
  process.exit(1);
});
