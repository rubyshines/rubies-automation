#!/usr/bin/env node

/**
 * CLI: Publish active store locator entries to rubies-ecom-v4/assets/store-locators.json
 *
 * Usage:
 *   node customer-service/scripts/publishStoreLocators.js
 *   node customer-service/scripts/publishStoreLocators.js --dry-run
 *   node customer-service/scripts/publishStoreLocators.js --no-merge
 *   node customer-service/scripts/publishStoreLocators.js --out path/to/file.json
 *
 * Identical code path as the store_locator_publish MCP tool — both go
 * through lib/storeLocatorPublish.js.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { publishStoreLocators, DEFAULT_THEME_ASSET_PATH } = require('../lib/storeLocatorPublish');

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 && args[outIdx + 1]
    ? path.resolve(process.cwd(), args[outIdx + 1])
    : DEFAULT_THEME_ASSET_PATH;
  const dryRun = args.includes('--dry-run');
  const noMerge = args.includes('--no-merge');

  const result = await publishStoreLocators({ outPath, dry_run: dryRun, merge: !noMerge });
  console.log(`✓ Wrote ${result.count} stores to ${result.path}`);

  if (result.dryRun) {
    console.log('  (dry run — working tree only)');
  } else if (result.noOp) {
    console.log('  No content change vs origin/main — nothing pushed.');
  } else if (result.merged) {
    console.log(`  ✓ Merged ${result.prUrl} — Shopify deploying (~30s)`);
    console.log(`  Live: ${result.liveUrl}`);
    if (result.mergeWarning) console.log(`  Note: ${result.mergeWarning}`);
  } else if (result.mergeError) {
    console.log(`  Pushed ${result.branch} but auto-merge failed: ${result.mergeError}`);
  } else {
    console.log(`  Pushed ${result.branch} (merge skipped)`);
  }
}

main().catch(err => {
  console.error('Publish failed:', err.message);
  process.exit(1);
});
