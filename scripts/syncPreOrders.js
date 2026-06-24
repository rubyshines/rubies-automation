#!/usr/bin/env node
/**
 * Sync pre-order info from the incoming-inventory Google Sheet to the website.
 *
 * Usage:
 *   node scripts/syncPreOrders.js                 # preview ALL skus (dry run)
 *   node scripts/syncPreOrders.js MPAD            # preview only MPAD-* (dry run)
 *   node scripts/syncPreOrders.js MPAD --send     # apply only MPAD-*
 *   node scripts/syncPreOrders.js --send          # apply ALL
 *
 * Default is print-only; pass --send to write to Shopify + Supabase.
 */

require('dotenv').config();
const { syncPreOrders } = require('../customer-service/lib/merchandising/preOrderSync');

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const skuFilter = args.find(a => !a.startsWith('--')) || null;

  console.log(
    `Pre-order sync — ${send ? 'LIVE (writing)' : 'DRY RUN (preview only)'}` +
    `${skuFilter ? ` · filter: ${skuFilter}` : ' · all SKUs'}\n`
  );

  const r = await syncPreOrders({
    skuFilter,
    dryRun: !send,
    onProgress: msg => console.log(msg),
  });
  console.log('');

  console.log(`Today (ET): ${r.today}`);
  console.log(`Set/updated: ${r.set.length}  Cleared: ${r.cleared.length}  Skipped: ${r.skipped.length}  Errors: ${r.errors.length}\n`);

  if (r.set.length) {
    console.log('SET / UPDATE:');
    for (const o of r.set) console.log(`  ${o.sku.padEnd(16)} → ${o.date}  (${o.incoming} incoming)`);
    console.log('');
  }
  if (r.cleared.length) {
    console.log('CLEAR (incoming date passed / removed from sheet):');
    for (const o of r.cleared) console.log(`  ${o.sku}`);
    console.log('');
  }
  if (r.skipped.length) {
    console.log('SKIPPED:');
    for (const o of r.skipped) console.log(`  ${o.sku} — ${o.reason}`);
    console.log('');
  }
  if (r.errors.length) {
    console.log('ERRORS:');
    for (const e of r.errors) console.log(`  ${e.sku} (${e.op}): ${e.error}`);
    console.log('');
  }
  if (!send && (r.set.length || r.cleared.length)) {
    console.log('Re-run with --send to apply these changes.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
