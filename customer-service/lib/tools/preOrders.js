/**
 * MCP Tool: sync_pre_orders
 *
 * Pushes incoming-inventory dates/quantities from the pre-order Google Sheet
 * to the website (Shopify pre-order metafields + inventory policy), and clears
 * variants whose incoming dates have passed. Enabling pre-order for a variant
 * not already live is an explicit `enable` step, decoupled from the sheet.
 * See lib/merchandising/preOrderSync.js.
 */

const { syncPreOrders } = require('../merchandising/preOrderSync');

function fmtRow(o) {
  return `${o.sku} → ${o.date} (${o.incoming} incoming)`;
}

async function handleSyncPreOrders({ sku_filter, enable, disable, dry_run } = {}) {
  const result = await syncPreOrders({
    skuFilter: sku_filter || null,
    enable: enable || [],
    disable: disable || [],
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
    lines.push('', '**Cleared (arrival passed, removed from sheet, or disabled):**',
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
      'Reconcile website pre-order state against the incoming-inventory Google Sheet. Variants ALREADY live on pre-order get their date/quantity metafields (pre_order_incoming_us / pre_order_date_us) refreshed, and variants whose arrival dates have passed (or were removed from the sheet) are cleared (inventory policy back to "deny"). A plain run never turns pre-order ON for a new variant — recording a production order in the sheet does not put products on pre-order. Turning pre-order ON is the explicit separate step: pass enable with SKU prefixes (e.g. ["GAF"]) once the operator decides to open pre-orders for those products. Pass disable to force pre-order OFF for live variants even though their arrivals are still upcoming (pausing a pre-order). Pass sku_filter to scope the whole run to a SKU prefix. Use dry_run=true to preview before applying.',
    inputSchema: {
      type: 'object',
      properties: {
        sku_filter: {
          type: 'string',
          description: 'Optional SKU prefix (case-insensitive). Only variants whose SKU starts with this are set/cleared (e.g. "MPAD", "AJ-BLK"). Omit to process the whole sheet.',
        },
        enable: {
          type: 'array',
          items: { type: 'string' },
          description: 'SKU prefixes to newly turn ON pre-order for (e.g. ["GAF"]; "*" = every sheet SKU). Only needed the first time a product goes on pre-order; already-live variants stay updated without it. Cannot be combined with disable.',
        },
        disable: {
          type: 'array',
          items: { type: 'string' },
          description: 'SKU prefixes to force pre-order OFF for (e.g. ["GAF"]; "*" = everything currently live), even though the sheet still shows upcoming arrivals. Cannot be combined with enable.',
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
