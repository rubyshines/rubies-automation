/**
 * MCP tools: draft_production_order, submit_production_order
 * The draft -> edit-in-sheet -> GO loop for placing a production order.
 */

const { draftProductionOrder, createOrderFromTab } = require('../merchandising/productionOrderLoop');

async function handleDraft({ supplier }) {
  if (!supplier) return { content: [{ type: 'text', text: 'Error: `supplier` is required.' }] };
  const r = await draftProductionOrder({ supplier });
  if (r.empty) return { content: [{ type: 'text', text: `No SKUs with qty_to_order > 0 for ${r.supplier}. Run run_inventory_projection first.` }] };
  const md = [
    `## Draft production order — ${r.supplier}`,
    '',
    `Wrote tab **"${r.tabName}"** to the 2026 Production Numbers sheet.`,
    `**${r.skuCount}** SKUs · **${r.totalUnits.toLocaleString()}** units.`,
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
    description: 'Start a production order: write an editable draft tab to the 2026 Production Numbers Google Sheet from the supplier\'s current projections (qty_to_order > 0). Jamie edits the quantities in the sheet, then calls submit_production_order.',
    inputSchema: {
      type: 'object',
      properties: { supplier: { type: 'string', description: 'Supplier name (Kali, Queenas, JustMax, Wumes)' } },
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
