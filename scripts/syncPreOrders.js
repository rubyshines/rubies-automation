#!/usr/bin/env node
/**
 * Sync pre-order info from the incoming-inventory Google Sheet to the website.
 *
 * A plain run only refreshes variants already live on pre-order and clears
 * stale ones — it never newly enables. Enabling is the explicit step:
 *
 * Usage:
 *   node scripts/syncPreOrders.js                     # preview reconcile, ALL skus (dry run)
 *   node scripts/syncPreOrders.js MPAD                # preview only MPAD-* (dry run)
 *   node scripts/syncPreOrders.js --enable GAF --send # turn pre-order ON for GAF-*
 *   node scripts/syncPreOrders.js --disable '*' --send # force pre-order OFF everywhere
 *   node scripts/syncPreOrders.js --send              # apply reconcile only
 *
 * --enable / --disable take comma-separated SKU prefixes ('*' = all).
 * Default is print-only; pass --send to write to Shopify + Supabase.
 */

require('dotenv').config();
const { syncPreOrders } = require('../customer-service/lib/merchandising/preOrderSync');

function flagList(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return [];
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a comma-separated prefix list (or '*')`);
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const enable = flagList(args, '--enable');
  const disable = flagList(args, '--disable');
  const flagValues = new Set([...enable.length ? [args[args.indexOf('--enable') + 1]] : [],
    ...disable.length ? [args[args.indexOf('--disable') + 1]] : []]);
  const skuFilter = args.find(a => !a.startsWith('--') && !flagValues.has(a)) || null;

  console.log(
    `Pre-order sync — ${send ? 'LIVE (writing)' : 'DRY RUN (preview only)'}` +
    `${skuFilter ? ` · filter: ${skuFilter}` : ' · all SKUs'}` +
    `${enable.length ? ` · enable: ${enable.join(', ')}` : ''}` +
    `${disable.length ? ` · disable: ${disable.join(', ')}` : ''}\n`
  );

  const r = await syncPreOrders({
    skuFilter,
    enable,
    disable,
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
    console.log('CLEAR (arrival passed, removed from sheet, or disabled):');
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
