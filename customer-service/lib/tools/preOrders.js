/**
 * MCP Tool: sync_pre_orders
 *
 * Pushes incoming-inventory dates/quantities from the pre-order Google Sheet
 * to the website (Shopify pre-order metafields + inventory policy), and clears
 * variants whose incoming dates have passed. See lib/merchandising/preOrderSync.js.
 */

const { syncPreOrders } = require('../merchandising/preOrderSync');

function fmtRow(o) {
  return `${o.sku} → ${o.date} (${o.incoming} incoming)`;
}

async function handleSyncPreOrders({ sku_filter, dry_run } = {}) {
  const result = await syncPreOrders({
    skuFilter: sku_filter || null,
    dryRun: dry_run ?? false,
  });

  const scope = result.skuFilter ? ` (SKUs matching "${result.skuFilter}")` : '';
  const mode = result.dryRun ? 'Preview — no changes made' : 'Applied';

  const lines = [
    `## Pre-order sync${scope}`,
    `${mode} · ${result.today}`,
    '',
    `**${result.set.length}** set on pre-order · **${result.cleared.length}** cleared · **${result.skipped.length}** skipped · **${result.errors.length}** errors`,
  ];

  if (result.set.length) {
    lines.push('', '**Set / updated:**', ...result.set.map(o => `- ${fmtRow(o)}`));
  }
  if (result.cleared.length) {
    lines.push('', '**Cleared (incoming date passed / removed from sheet):**',
      ...result.cleared.map(o => `- ${o.sku}`));
  }
  if (result.skipped.length) {
    lines.push('', '**Skipped:**', ...result.skipped.map(o => `- ${o.sku} — ${o.reason}`));
  }
  if (result.errors.length) {
    lines.push('', '**Errors:**', ...result.errors.map(e => `- ${e.sku} (${e.op}): ${e.error}`));
  }
  if (!result.set.length && !result.cleared.length) {
    lines.push('', 'Website already matches the sheet — nothing to change.');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

module.exports = [
  {
    name: 'sync_pre_orders',
    description:
      'Push incoming-inventory dates and quantities from the pre-order Google Sheet to the website. For each variant with a future-dated arrival it sets the Shopify pre-order metafields (pre_order_incoming_us / pre_order_date_us) and flips inventory policy to "continue" so the product shows as available for pre-order. Also clears variants whose arrival dates have passed (or were removed from the sheet). Pass sku_filter to scope to a SKU prefix (e.g. "MPAD" does only MPAD-* variants). Use dry_run=true to preview before applying.',
    inputSchema: {
      type: 'object',
      properties: {
        sku_filter: {
          type: 'string',
          description: 'Optional SKU prefix (case-insensitive). Only variants whose SKU starts with this are set/cleared (e.g. "MPAD", "AJ-BLK"). Omit to process the whole sheet.',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, return the plan (what would be set/cleared) without writing to Shopify or Supabase. Default false.',
        },
      },
    },
    handler: handleSyncPreOrders,
  },
];
