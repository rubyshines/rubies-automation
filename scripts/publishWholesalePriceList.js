#!/usr/bin/env node
/**
 * Print the wholesale price list the storefront page would show; land it with
 * --publish (commit to the theme repo via worktree + auto-merge PR → live in
 * ~30s). --no-merge pushes the branch and leaves the merge to you.
 *
 *   node scripts/publishWholesalePriceList.js             # print only
 *   node scripts/publishWholesalePriceList.js --publish   # publish + merge
 *   node scripts/publishWholesalePriceList.js --publish --no-merge
 *   node scripts/publishWholesalePriceList.js --json      # print the payload as JSON
 */
require('dotenv').config();

const { buildWholesalePricingPayload, publishWholesalePricing } = require('../customer-service/lib/wholesalePriceListPublish');

const args = new Set(process.argv.slice(2));

(async () => {
  const payload = await buildWholesalePricingPayload();
  if (args.has('--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`RUBIES Wholesale Price List (${payload.discount_percent}% off retail, ${payload.currency})`);
    for (const s of payload.sections) {
      console.log(`\n${s.name}`);
      for (const p of s.products) {
        console.log(`  ${p.product}${p.image ? '' : '   (no image)'}`);
        for (const b of p.bands) {
          console.log(`      ${b.sizes.padEnd(34)} $${b.retail.toFixed(2).padStart(6)}  →  $${b.wholesale.toFixed(2).padStart(6)}`);
        }
      }
    }
    console.log('\nTerms');
    for (const t of payload.terms) console.log(`  ${t}`);
  }
  if (!args.has('--publish')) {
    // stderr, so `--json > file` yields a file that is only the JSON.
    console.error('\n(print only — pass --publish to land it on the theme)');
    return;
  }
  const result = await publishWholesalePricing({ merge: !args.has('--no-merge') });
  console.log('\n' + JSON.stringify(result, null, 2));
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
