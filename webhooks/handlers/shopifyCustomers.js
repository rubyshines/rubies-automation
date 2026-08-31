/**
 * Shopify customers/update webhook handler
 *
 * Normalizes REST payload → customers table row, upserts.
 * Mirrors the enrichment logic in customer-service/sync/syncAll.js.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { normalizeCustomerRow } = require('../lib/normalize');
const { upsertCustomerRow } = require('../lib/customerUpsert');

async function handle(topic, payload) {
  const supabase = getSupabaseClient();
  const customerRow = normalizeCustomerRow(payload);

  if (!customerRow.email) {
    console.warn('[shopify-customers] Skipping customer with no email');
    return;
  }

  console.log(`[shopify-customers] ${topic} ${customerRow.email}`);

  // Resolves by shopify_customer_id first so a Shopify email change renames the
  // existing row instead of forking a duplicate keyed on the new email.
  await upsertCustomerRow(supabase, customerRow);

  console.log(`[shopify-customers] Upserted ${customerRow.email}`);
}

module.exports = { handle };
