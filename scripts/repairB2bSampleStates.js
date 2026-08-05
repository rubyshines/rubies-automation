#!/usr/bin/env node
/**
 * repairB2bSampleStates.js — one-off correction for companies whose "orders"
 * were only $0 sample kits.
 *
 * Sample kits go out as $0 Shopify orders (tagged `sample kit reach out`,
 * `wholesale-samples`). syncB2bCompanyState counted every non-cancelled order,
 * so 14 retailers sent samples on 2025-11-04 were promoted in_contact → active
 * and read as customers (order_count 1, total_sales $0). Meanwhile
 * samples_shipped_at stayed null, so the samples cadence never fired for anyone.
 *
 * The sync now excludes $0 orders and derives samples_shipped_at itself, but it
 * deliberately never downgrades 'active' and never clears last_order_date (a
 * transient email-match failure must not wipe a real date). Those two
 * corrections are this script's job, applied once, explicitly.
 *
 * Per company whose matched orders are ALL $0 samples:
 *   relationship_state 'active' → 'in_contact'   ('lost' left alone)
 *   last_order_date              → null
 *   order_count / total_sales    → 0
 *   samples_shipped_at           → earliest sample order (when not already set)
 *
 * Usage: node scripts/repairB2bSampleStates.js [--execute]
 *   Default is print-only.
 */
require('dotenv').config();

const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');
const {
  isSampleOrder, matchOrdersToCompanies, COMPANY_COLUMNS,
} = require('../b2b-outreach/sync/syncB2bCompanyState');

/**
 * Decide the repair for one company. Returns the update object, or null when
 * nothing is wrong. Pure — the whole decision is testable without Supabase.
 */
function computeSampleRepair(company, orders) {
  if (company.relationship_state === 'lost') return null;
  const valid = (orders || []).filter(o => !o.cancelled_at);
  const purchases = valid.filter(o => Number(o.total_price || 0) > 0);
  const samples = valid.filter(isSampleOrder);
  // Only companies whose entire order history is samples. A real purchase
  // anywhere means the sync's own numbers are right and this is not our case.
  if (purchases.length || !samples.length) return null;

  const upd = {};
  if (company.relationship_state === 'active') upd.relationship_state = 'in_contact';
  if (company.last_order_date) upd.last_order_date = null;
  if ((company.order_count || 0) !== 0) upd.order_count = 0;
  if (Number(company.total_sales || 0) !== 0) upd.total_sales = 0;
  if (!company.samples_shipped_at) {
    upd.samples_shipped_at = samples.map(o => o.created_at).sort()[0];
  }
  return Object.keys(upd).length ? upd : null;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const sb = getSupabaseClient();

  const companies = await fetchAllPaginated(() => sb.from('b2b_companies').select(COMPANY_COLUMNS));
  const ordersByCompany = await matchOrdersToCompanies(sb, companies);

  const repairs = [];
  for (const c of companies) {
    const upd = computeSampleRepair(c, ordersByCompany.get(c.id));
    if (upd) repairs.push({ company: c, upd });
  }

  if (!repairs.length) {
    console.log('Nothing to repair — no company\'s order history is samples-only.');
    return;
  }

  console.log(`${repairs.length} companies to repair${execute ? '' : ' (print-only — pass --execute to apply)'}:\n`);
  for (const { company, upd } of repairs) {
    const parts = Object.entries(upd).map(([k, v]) => `${k}=${v === null ? 'null' : v}`);
    console.log(`  ${company.name} [${company.relationship_type}] ${parts.join(' ')}`);
  }

  if (!execute) return;

  let applied = 0;
  for (const { company, upd } of repairs) {
    const { error } = await sb.from('b2b_companies')
      .update({ ...upd, updated_at: new Date().toISOString() }).eq('id', company.id);
    if (error) throw new Error(`update ${company.id} (${company.name}): ${error.message}`);
    applied++;
  }
  console.log(`\nApplied ${applied}/${repairs.length}.`);
}

module.exports = { computeSampleRepair };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
