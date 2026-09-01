/**
 * MCP tools: preorder_hygiene + preorder_update_notice
 *
 * The recurring pre-order operating loop (run hygiene first, then notify):
 *   1. preorder_hygiene — reconcile open unfulfilled orders against live
 *      Shopify + Warehance before communicating anything.
 *   2. preorder_update_notice — email every open order promised an earlier
 *      date when a production order slips. dry_run → test_send → send.
 *
 * Logic lives in lib/merchandising/preOrderLifecycle.js.
 */

const {
  preOrderHygiene,
  hygieneReportMarkdown,
  sendPreOrderUpdateNotices,
} = require('../merchandising/preOrderLifecycle');

async function handleHygiene({ fix_attributes, fix_closed_drift } = {}) {
  const report = await preOrderHygiene({
    fixAttributes: fix_attributes ?? false,
    fixClosedDrift: fix_closed_drift ?? false,
  });
  return hygieneReportMarkdown(report);
}

function noticeSummaryMarkdown(summary) {
  const lines = [
    `## Pre-order update notice — ${summary.mode.toUpperCase()}`,
    '',
    `**${summary.total}** orders matched (A pre-only: ${summary.byVariant.A_pre_only}, B mixed: ${summary.byVariant.B_mixed})`,
  ];
  if (summary.dedupeWarning) lines.push('', `⚠️ ${summary.dedupeWarning}`);

  if (summary.mode === 'dry_run') {
    // Show one full body per variant, then the recipient list — the operator
    // needs to read the copy once, not 48 times.
    for (const variant of ['A_pre_only', 'B_mixed']) {
      const example = summary.results.find(r => r.variant === variant);
      if (example) {
        lines.push('', `**Example ${variant} (#${example.order_number}):**`, '```', example.body, '```');
      }
    }
    if (summary.results.length) {
      lines.push('', '**Would send to:**',
        ...summary.results.map(r => `- #${r.order_number} [${r.variant}] ${r.customer_email} (promised: ${r.promised.join('; ')})`));
    }
  } else {
    lines.push('', `Sent: ${summary.sent} · Failed: ${summary.failed}`);
    for (const r of summary.results) {
      const track = r.tracked === false ? ' (tracking write FAILED)' : '';
      lines.push(`- #${r.order_number} [${r.variant}] → ${r.to}: ${r.sent ? 'sent' : `FAILED ${r.error}`}${track}`);
    }
  }
  if (summary.skipped.length) {
    lines.push('', '**Skipped:**', ...summary.skipped.map(s => `- ${s}`));
  }
  return lines.join('\n');
}

async function handleUpdateNotice(args = {}) {
  const summary = await sendPreOrderUpdateNotices({
    newDatePhrase: args.new_date_phrase,
    waveTargets: args.wave_targets,
    staleTargets: args.stale_targets || [],
    excludeOrders: args.exclude_orders || [],
    offerRefund: args.offer_refund ?? false,
    mode: args.mode || 'dry_run',
    testRecipient: args.test_recipient || undefined,
    resend: args.resend ?? false,
  });
  return noticeSummaryMarkdown(summary);
}

module.exports = [
  {
    name: 'preorder_hygiene',
    description:
      'Reconcile all open unfulfilled orders against live Shopify and Warehance before running a pre-order notification wave. Reports: mirror drift (orders live Shopify says are fulfilled/closed/cancelled but the Supabase mirror shows open), refunded-but-open orders to archive, orders Warehance says are ready but unshipped, stuck orders (not ready, no hold, no pre-order line), operator holds, line-item attribute drift, and the healthy waiting-pre-order population grouped by promised text (use those exact texts as wave_targets for preorder_update_notice). Read-only unless a fix flag is passed. Run this FIRST, fix what it surfaces, then send notices.',
    inputSchema: {
      type: 'object',
      properties: {
        fix_attributes: {
          type: 'boolean',
          description: 'Backfill order_line_items.custom_attributes from live Shopify where the mirror is stale (older orders synced before 2026-05-01 have nulls). Default false.',
        },
        fix_closed_drift: {
          type: 'boolean',
          description: 'Stamp mirror orders whose live Shopify state is closed/cancelled/fulfilled so they stop appearing open. Default false.',
        },
      },
    },
    handler: handleHygiene,
  },
  {
    name: 'preorder_update_notice',
    description:
      'Email open pre-orders an updated availability date when a production order slips. Give it the exact promised texts to update (wave_targets, from preorder_hygiene\'s waiting-by-target section) and the new date phrase (e.g. "the end of August"). Composes two variants in RUBIES voice: pre-order-only orders get a swap offer, mixed orders get split-or-swap. Sends plain email from care@rubyshines.com (no ticket; replies create tickets via normal intake). Every candidate is verified not-ready-to-ship in Warehance, and orders already told the same date are skipped (tracked in preorder_notifications). ALWAYS run mode=dry_run first, then mode=test_send (sends one example per variant to the test recipient), then mode=send after operator approval.',
    inputSchema: {
      type: 'object',
      properties: {
        new_date_phrase: {
          type: 'string',
          description: 'The updated availability, phrased to read inline: "...will ship closer to {phrase}." Example: "the end of August".',
        },
        wave_targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact Pre-order attribute texts being updated, e.g. ["Target availability middle of August, 2026.", "Will ship when in stock"]. Get the live list from preorder_hygiene.',
        },
        stale_targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Promised texts whose stock already arrived and is reserved on the orders (operator judgment) — those lines are treated as in-stock, not waiting.',
        },
        exclude_orders: {
          type: 'array',
          items: { type: 'number' },
          description: 'Order numbers to leave out (e.g. handled individually).',
        },
        offer_refund: {
          type: 'boolean',
          description: 'Add a full-refund option and an upfront apology to the emails (use when the slip is big). Default false (swap/split offer only).',
        },
        mode: {
          type: 'string',
          enum: ['dry_run', 'test_send', 'send'],
          description: 'dry_run (default): report only. test_send: one example per variant to test_recipient. send: live emails to customers + tracking rows.',
        },
        test_recipient: {
          type: 'string',
          description: 'Where test_send examples go. Default jamie@rubyshines.com.',
        },
        resend: {
          type: 'boolean',
          description: 'Include orders already told this same date (default false — they are skipped).',
        },
      },
      required: ['new_date_phrase', 'wave_targets'],
    },
    handler: handleUpdateNotice,
  },
];
