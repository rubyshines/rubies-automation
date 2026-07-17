#!/usr/bin/env node
/**
 * CLI: pre-order delay notification wave (same logic as the
 * preorder_update_notice MCP tool).
 *
 *   node scripts/preorderUpdateNotice.js \
 *     --new-date "the end of August" \
 *     --target "Target availability middle of August, 2026." \
 *     --target "Will ship when in stock" \
 *     [--stale-target "Target availability beginning of April, 2026."] \
 *     [--exclude 32455] [--test-send | --send] [--resend] [--test-recipient x@y]
 *
 * Default is a dry run: prints counts, one example body per variant, and the
 * full would-send list. --test-send emails one example per variant to the test
 * recipient (default jamie@rubyshines.com). --send goes live and records each
 * send in preorder_notifications.
 *
 * Get the exact --target texts from scripts/preorderHygiene.js (waiting-by-
 * target section). Run hygiene first.
 */

const { sendPreOrderUpdateNotices } = require('../customer-service/lib/merchandising/preOrderLifecycle');

function collect(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  return out;
}
function single(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--send') ? 'send' : args.includes('--test-send') ? 'test_send' : 'dry_run';

  const summary = await sendPreOrderUpdateNotices({
    newDatePhrase: single(args, '--new-date'),
    waveTargets: collect(args, '--target'),
    staleTargets: collect(args, '--stale-target'),
    excludeOrders: collect(args, '--exclude').map(Number),
    mode,
    testRecipient: single(args, '--test-recipient') || undefined,
    resend: args.includes('--resend'),
    onProgress: (i, total, order) => {
      if (i % 10 === 0 || i === total) process.stderr.write(`  scanning ${i}/${total} (#${order})\n`);
    },
  });

  console.log(`[${summary.mode.toUpperCase()}] ${summary.total} orders matched ` +
    `(A pre-only: ${summary.byVariant.A_pre_only}, B mixed: ${summary.byVariant.B_mixed})\n`);
  if (summary.dedupeWarning) console.log(`WARNING: ${summary.dedupeWarning}\n`);

  if (summary.mode === 'dry_run') {
    for (const r of summary.results) {
      console.log('='.repeat(78));
      console.log(`#${r.order_number} [${r.variant}] → ${r.customer_email} (promised: ${r.promised.join('; ')})\n`);
      console.log(r.body);
      console.log();
    }
  } else {
    for (const r of summary.results) {
      const track = r.tracked === false ? ' (tracking write FAILED)' : '';
      console.log(`#${r.order_number} [${r.variant}] → ${r.to}: ${r.sent ? 'sent' : `FAILED ${r.error}`}${track}`);
    }
    console.log(`\n${summary.mode} complete: ${summary.sent} sent, ${summary.failed} failed.`);
    if (summary.failed) process.exitCode = 1;
  }

  if (summary.skipped.length) {
    console.log('\nSkipped:');
    for (const s of summary.skipped) console.log(`  ${s}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
