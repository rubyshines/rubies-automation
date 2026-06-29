/**
 * MCP tools for the production-order loop:
 *   draft_order_review     — stage 1: write the editable projection review tab (overrides applied)
 *   draft_production_order  — stage 2: build the supplier tab from the edited review tab
 *   submit_production_order — stage 3: record to Supabase + emit the supplier .xlsx
 */

const { draftOrderReview, draftProductionOrder, createOrderFromTab } = require('../merchandising/productionOrderLoop');

function projectionLine(p) {
  return p.refreshed
    ? `📊 Projection **refreshed** (${p.reason}).`
    : `📊 Projection from **${p.run_date}**${p.age_days != null ? ` (${p.age_days}d old)` : ''}.`;
}

function warnBlock(warnings) {
  return warnings && warnings.length ? '\n⚠️ ' + warnings.join('\n⚠️ ') : '';
}

// --- Stage 1 ---------------------------------------------------------------
async function handleReview({ supplier, force_refresh, max_age_days, overrides }) {
  if (!supplier) return { content: [{ type: 'text', text: 'Error: `supplier` is required.' }] };
  const opts = { supplier, forceRefresh: !!force_refresh };
  if (max_age_days != null) opts.maxAgeDays = max_age_days;
  if (overrides && typeof overrides === 'object') opts.overrides = overrides;
  const r = await draftOrderReview(opts);
  if (r.empty) return { content: [{ type: 'text', text: `${projectionLine(r.projection)}\nNo projection rows for ${r.supplier}.` }] };
  const md = [
    `## Order review — ${r.supplier}`,
    '',
    projectionLine(r.projection),
    r.overrides && r.overrides.length ? `🎚️ Unit override applied to: **${r.overrides.join(', ')}** (spread rescaled to your total, multiples of 10).` : '',
    `Wrote review tab **"${r.tabName}"** to the inventory-projections sheet — **${r.skuCount}** SKUs to order · **${r.totalUnits.toLocaleString()}** units. Every ordered size respects the 20-unit floor.`,
    warnBlock(r.warnings),
    '',
    `Review and edit the **Qty to Order** column in that tab, then call **draft_production_order** with \`review_tab: "${r.tabName}"\` to build the supplier tab.`,
    `[Open the projections sheet](${r.url})`,
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text: md }] };
}

// --- Stage 2 ---------------------------------------------------------------
async function handleDraft({ supplier, review_tab }) {
  if (!supplier || !review_tab) return { content: [{ type: 'text', text: 'Error: `supplier` and `review_tab` are required.' }] };
  const r = await draftProductionOrder({ supplier, review_tab });
  const md = [
    `## Draft production order — ${r.supplier}`,
    '',
    `Built order tab **"${r.tabName}"** in the 2026 Production Numbers sheet from **"${r.sourceTab}"** — **${r.skuCount}** SKUs · **${r.totalUnits.toLocaleString()}** units.`,
    r.pricing ? `💰 Cost estimate (in the same tab): landed **$${Math.round(r.pricing.landed).toLocaleString()}** (COGS $${Math.round(r.pricing.cogs).toLocaleString()} · shipping $${Math.round(r.pricing.freight).toLocaleString()} · taxes $${Math.round(r.pricing.duty).toLocaleString()})${r.pricing.missing && r.pricing.missing.length ? ` · ⚠️ no cost on file for: ${r.pricing.missing.join(', ')}` : ''}.` : '',
    warnBlock(r.warnings),
    '',
    `Eyeball it, then call **submit_production_order** with \`tab_name: "${r.tabName}"\` to place the order (records to Supabase + emits a supplier .xlsx).`,
    `[Open the sheet](${r.url})`,
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text: md }] };
}

// --- Stage 3 ---------------------------------------------------------------
async function handleSubmit({ supplier, tab_name, expected_ship_date, expected_delivery_date, notes }) {
  if (!supplier || !tab_name) return { content: [{ type: 'text', text: 'Error: `supplier` and `tab_name` are required.' }] };
  const r = await createOrderFromTab({ supplier, tab_name, expected_ship_date, expected_delivery_date, notes });
  const md = [
    `## Production order placed — ${r.supplier}`,
    '',
    `**Code:** ${r.production_code} · **Order ID:** ${r.order_id}`,
    `**${r.sku_count}** SKUs · **${r.total_units.toLocaleString()}** units · **${r.payments}** payment installment(s) created`,
    `**Supplier file:** \`${r.xlsx_path}\` (send this to the supplier)`,
    r.warnings.length ? `\n⚠️ ${r.warnings.length} warning(s):\n` + r.warnings.map((w) => `- ${w}`).join('\n') : '',
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text: md }] };
}

module.exports = [
  {
    name: 'draft_order_review',
    description: 'Stage 1 of placing a production order: write an editable REVIEW tab to the inventory-projections Google Sheet for a supplier, with full context columns (on-hand, incoming, weeks cover, sales/week, priority) and a Qty to Order column. Auto-refreshes the projection if stale (older than max_age_days, default 3). Order rules are pre-applied to Qty to Order: every ordered size respects the 20-unit floor (thin sizes round up). Use `overrides` to force a total for a style and have its spread rescaled (multiples of 10). Jamie reviews/edits the Qty to Order column, then calls draft_production_order with this tab name.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name (Kali, Queenas, JustMax, Wumes)' },
        force_refresh: { type: 'boolean', description: 'Recompute the inventory projection first, even if a recent one exists.' },
        max_age_days: { type: 'number', description: 'Max projection age (days) before auto-refresh. Default 3.' },
        overrides: {
          type: 'object',
          description: 'Founder unit overrides: per-style TOTAL units to order, keyed by style name or SKU prefix, e.g. {"naomi": 3000} or {"GAF": 3000}. Add a "/COLOR" suffix to override a single color, e.g. {"AJ/BLK": 2000, "AJ/SND": 800}. The matched rows\' projected size spread is rescaled to that total, honoring the 20-unit floor and keeping every size a multiple of 10.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['supplier'],
    },
    handler: handleReview,
  },
  {
    name: 'draft_production_order',
    description: 'Stage 2: read the founder-edited Qty to Order from a projections review tab (from draft_order_review) and write the combined order tab to the 2026 Production Numbers Google Sheet — quantities plus a cost estimate (COGS / shipping / taxes / landed, from current product_costs). The tab is named "<date> - <supplier> <descriptor>" (e.g. "2026-06-29 - Kali Swim and Underwear"). Warns if any edited line is below the 20-unit floor or not a multiple of 10. Jamie eyeballs it, then calls submit_production_order with that tab name.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name' },
        review_tab: { type: 'string', description: 'The review tab name returned by draft_order_review (after you edited the Qty to Order column).' },
      },
      required: ['supplier', 'review_tab'],
    },
    handler: handleDraft,
  },
  {
    name: 'submit_production_order',
    description: 'Stage 3, the "GO" step: read the edited draft tab back as canonical, record production_orders + items + payments (from the supplier\'s payment terms), mint a production code, and write a supplier-ready .xlsx to ~/Downloads. Record-only — does not email the supplier.',
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
