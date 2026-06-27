/**
 * MCP tools: draft_production_order, submit_production_order
 * The draft -> edit-in-sheet -> GO loop for placing a production order.
 */

const { draftProductionOrder, createOrderFromTab } = require('../merchandising/productionOrderLoop');

function projectionLine(p) {
  return p.refreshed
    ? `📊 Projection **refreshed** (${p.reason}).`
    : `📊 Projection from **${p.run_date}**${p.age_days != null ? ` (${p.age_days}d old)` : ''}.`;
}

async function handleDraft({ supplier, force_refresh, max_age_days }) {
  if (!supplier) return { content: [{ type: 'text', text: 'Error: `supplier` is required.' }] };
  const opts = { supplier, forceRefresh: !!force_refresh };
  if (max_age_days != null) opts.maxAgeDays = max_age_days;
  const r = await draftProductionOrder(opts);
  if (r.empty) return { content: [{ type: 'text', text: `${projectionLine(r.projection)}\nNo SKUs with qty_to_order > 0 for ${r.supplier}.` }] };
  const md = [
    `## Draft production order — ${r.supplier}`,
    '',
    projectionLine(r.projection),
    `Wrote tab **"${r.tabName}"** to the 2026 Production Numbers sheet — **${r.skuCount}** SKUs · **${r.totalUnits.toLocaleString()}** units.`,
    '',
    `Edit the quantities in that tab, then call **submit_production_order** with \`tab_name: "${r.tabName}"\` to place the order (records to Supabase + emits a supplier .xlsx).`,
    `[Open the sheet](${r.url})`,
  ].join('\n');
  return { content: [{ type: 'text', text: md }] };
}

async function handleSubmit({ supplier, tab_name, expected_ship_date, expected_delivery_date, notes }) {
  if (!supplier || !tab_name) return { content: [{ type: 'text', text: 'Error: `supplier` and `tab_name` are required.' }] };
  const r = await createOrderFromTab({ supplier, tab_name, expected_ship_date, expected_delivery_date, notes });
  const md = [
    `## Production order placed — ${r.supplier}`,
    '',
    `**Code:** ${r.production_code} · **Order ID:** ${r.order_id}`,
    `**${r.sku_count}** SKUs · **${r.total_units.toLocaleString()}** units · **${r.payments}** payment installment(s) created`,
    `**Supplier file:** \`${r.xlsx_path}\` (send this to the supplier)`,
    r.warnings.length ? `\n⚠️ ${r.warnings.length} warning(s):\n` + r.warnings.map(w => `- ${w}`).join('\n') : '',
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text: md }] };
}

module.exports = [
  {
    name: 'draft_production_order',
    description: 'Start a production order: write an editable draft tab to the 2026 Production Numbers Google Sheet from the supplier\'s projections (qty_to_order > 0). Auto-refreshes the projection first if it is stale (older than max_age_days, default 3) so the draft is never based on old numbers. Jamie edits the quantities in the sheet, then calls submit_production_order.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name (Kali, Queenas, JustMax, Wumes)' },
        force_refresh: { type: 'boolean', description: 'Recompute the inventory projection before drafting, even if a recent one exists.' },
        max_age_days: { type: 'number', description: 'Max projection age (days) before auto-refresh. Default 3.' },
      },
      required: ['supplier'],
    },
    handler: handleDraft,
  },
  {
    name: 'submit_production_order',
    description: 'Place the order (the "GO" step): read the edited draft tab back as canonical, record production_orders + items + payments (from the supplier\'s payment terms), mint a production code, and write a supplier-ready .xlsx to ~/Downloads. Record-only — does not email the supplier.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name' },
        tab_name: { type: 'string', description: 'The draft tab name returned by draft_production_order' },
        expected_ship_date: { type: 'string', description: 'YYYY-MM-DD' },
        expected_delivery_date: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string' },
      },
      required: ['supplier', 'tab_name'],
    },
    handler: handleSubmit,
  },
];
