#!/usr/bin/env node
/**
 * CLI: pre-order hygiene sweep (same logic as the preorder_hygiene MCP tool).
 *
 *   node scripts/preorderHygiene.js                    # read-only report
 *   node scripts/preorderHygiene.js --fix-attributes   # + backfill stale line attrs
 *   node scripts/preorderHygiene.js --fix-closed-drift # + stamp mirror drift
 *
 * Run this before every preorder_update_notice wave.
 */

const { preOrderHygiene, hygieneReportMarkdown } = require('../customer-service/lib/merchandising/preOrderLifecycle');

async function main() {
  const args = process.argv.slice(2);
  const report = await preOrderHygiene({
    fixAttributes: args.includes('--fix-attributes'),
    fixClosedDrift: args.includes('--fix-closed-drift'),
    onProgress: (i, total, order) => {
      if (i % 10 === 0 || i === total) process.stderr.write(`  scanning ${i}/${total} (#${order})\n`);
    },
  });
  console.log(hygieneReportMarkdown(report));
}

main().catch(e => { console.error(e); process.exit(1); });
