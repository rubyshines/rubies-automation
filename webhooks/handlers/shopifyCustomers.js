/**
 * Shopify customers/update webhook handler
 *
 * Normalizes REST payload → customers table row, upserts.
 * Mirrors the enrichment logic in customer-service/sync/syncAll.js.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { normalizeCustomerRow } = require('../lib/normalize');

async function handle(topic, payload) {
  const supabase = getSupabaseClient();
  const customerRow = normalizeCustomerRow(payload);

  if (!customerRow.email) {
    console.warn('[shopify-customers] Skipping customer with no email');
    return;
  }

  console.log(`[shopify-customers] ${topic} ${customerRow.email}`);

  const { error } = await supabase
    .from('customers')
    .upsert(customerRow, { onConflict: 'email' });

  if (error) {
    throw new Error(`Customer upsert failed: ${error.message}`);
  }

  console.log(`[shopify-customers] Upserted ${customerRow.email}`);
}

module.exports = { handle };
