#!/usr/bin/env node
/**
 * Compare-at price audit: every live variant whose compare-at differs from
 * its retail price, read from Shopify, grouped by product.
 *
 * Usage:
 *   node scripts/auditCompareAtPrices.js                    # text report, active + draft products
 *   node scripts/auditCompareAtPrices.js --include-archived
 *   node scripts/auditCompareAtPrices.js --json             # structured report
 *
 * Read-only. Same function as the audit_compare_at_prices MCP tool.
 */

require('dotenv').config();
const { auditCompareAtPrices, formatCompareAtReport } = require('../customer-service/lib/tools/compareAtAudit');

async function main() {
  const args = process.argv.slice(2);
  const report = await auditCompareAtPrices({ includeArchived: args.includes('--include-archived') });
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCompareAtReport(report));
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
