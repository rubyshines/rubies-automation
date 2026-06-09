/**
 * MCP Tools: run_inventory_projection, get_at_risk_skus
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { runProjection } = require('../merchandising/inventoryProjection');

const PRIORITY_EMOJI = {
  URGENT: '🔴',
  NEEDS_ATTENTION: '🟠',
  WATCH: '🟡',
  OK: '🔵',
  GOOD: '🟣',
  FULL_STOCK: '🟢',
};

// ---------------------------------------------------------------------------
// Tool: run_inventory_projection
// ---------------------------------------------------------------------------

async function handleRunInventoryProjection({ growth_factor, target_weeks, write_sheets, sku_prefixes }) {
  const result = await runProjection({
    growthFactor: growth_factor ?? 1.3,
    targetWeeks: target_weeks ?? 78,
    lookbackDays: 365,
    writeSheets: write_sheets ?? false,
    skuPrefixes: sku_prefixes ?? null,
  });

  const lines = [
    `## Inventory Projection — ${result.run_date}`,
    '',
    `**${result.sku_count}** SKUs projected · **${result.at_risk_count}** at risk (<26 weeks) · **${result.total_units_to_order.toLocaleString()}** units to order`,
    '',
    write_sheets ? '_Google Sheets updated._' : '_Use `get_at_risk_skus` to query results, or pass `write_sheets: true` to also write to Google Sheets._',
  ];

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ---------------------------------------------------------------------------
// Tool: get_at_risk_skus
// ---------------------------------------------------------------------------

async function handleGetAtRiskSkus({ weeks_horizon, supplier, include_incoming }) {
  const supabase = getSupabaseClient();
  const horizon = weeks_horizon ?? 26;
  const includeIncoming = include_incoming !== false; // default true

  let query = supabase
    .from('inventory_projections')
    .select('sku, product_name, color, size, age_range, current_inventory, total_incoming, total_inventory, weeks_until_no_stock, qty_to_order, priority, sales_per_week, run_date, suppliers(name)')
    .lt('weeks_until_no_stock', horizon)
    .order('weeks_until_no_stock', { ascending: true });

  // Filter by supplier name if given
  if (supplier) {
    // We need to join via supplier_id; filter after fetch
  }

  const { data, error } = await query;
  if (error) throw new Error(`get_at_risk_skus: ${error.message}`);

  let rows = data || [];

  // Supplier filter (in-memory since we can't easily filter on embedded relation)
  if (supplier) {
    const sup = supplier.toLowerCase();
    rows = rows.filter(r => r.suppliers?.name?.toLowerCase() === sup);
  }

  if (!rows.length) {
    return {
      content: [{
        type: 'text',
        text: `No SKUs at risk within ${horizon} weeks${supplier ? ` for supplier "${supplier}"` : ''}.`,
      }],
    };
  }

  // If include_incoming=false, recalculate weeks_until_no_stock using current_inventory only
  if (!includeIncoming) {
    rows = rows.map(r => {
      const velocity = r.sales_per_week || 0;
      const weeks = velocity > 0 ? r.current_inventory / (velocity * 1.3) : 9999;
      return { ...r, _recalc_weeks: Math.round(weeks * 10) / 10 };
    }).filter(r => r._recalc_weeks < horizon)
      .sort((a, b) => a._recalc_weeks - b._recalc_weeks);
  }

  const effectiveHorizonLabel = includeIncoming ? '' : ' *(incoming excluded)*';
  const supplierLabel = supplier ? ` — ${supplier}` : '';
  const runDate = rows[0]?.run_date || '?';

  let md = `## At-Risk SKUs (<${horizon}w)${supplierLabel}${effectiveHorizonLabel}\n`;
  md += `_Last projection: ${runDate}_\n\n`;

  for (const r of rows) {
    const weeks = r._recalc_weeks ?? r.weeks_until_no_stock;
    const emoji = PRIORITY_EMOJI[r.priority] || '';
    const weeksDisplay = weeks === 9999 ? '∞' : weeks.toFixed(1);
    const incomingNote = !includeIncoming ? '' : (r.total_incoming > 0 ? ` (+${r.total_incoming} incoming)` : '');
    const supplierName = r.suppliers?.name || '?';

    md += `**${r.sku}** — ${r.product_name} ${r.color || ''} ${r.size || ''}\n`;
    md += `  ${emoji} ${weeksDisplay}w · ${r.current_inventory} on hand${incomingNote} · order ${r.qty_to_order} · ${supplierName}\n\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

module.exports = [
  {
    name: 'run_inventory_projection',
    description: 'Run inventory velocity projection for all active SKUs. Computes OOS-adjusted sales velocity, weeks-until-stockout, and qty-to-order. Writes results to inventory_projections table. Run before get_at_risk_skus to get fresh data.',
    inputSchema: {
      type: 'object',
      properties: {
        growth_factor: { type: 'number', description: 'Growth multiplier for velocity (default 1.3 = 30% growth)' },
        target_weeks: { type: 'number', description: 'Target weeks of stock to maintain (default 78 = 18 months)' },
        write_sheets: { type: 'boolean', description: 'If true, also write Sales Data by SKU sheet to Google Sheets (requires INVENTORY_PLANNING_SHEET_ID env var)' },
        sku_prefixes: { type: 'array', items: { type: 'string' }, description: 'Optional list of SKU prefixes to project (e.g. ["GAF","SB"]). Omit to project all SKUs.' },
      },
    },
    handler: handleRunInventoryProjection,
  },
  {
    name: 'get_at_risk_skus',
    description: 'Query inventory_projections for SKUs at risk of stockout within a given horizon. Use after run_inventory_projection. Key use case: "what swimwear SKUs run out in 6 months if the Kali order is delayed?" → weeks_horizon=26, supplier="Kali", include_incoming=false.',
    inputSchema: {
      type: 'object',
      properties: {
        weeks_horizon: { type: 'number', description: 'Flag SKUs with fewer than this many weeks of stock (default 26 = 6 months)' },
        supplier: { type: 'string', description: 'Filter to a specific supplier name (e.g. "Kali", "Queenas", "Wumes")' },
        include_incoming: { type: 'boolean', description: 'If false, recalculate using current_inventory only — answers "what if this shipment is fully delayed?" (default true)' },
      },
    },
    handler: handleGetAtRiskSkus,
  },
];
