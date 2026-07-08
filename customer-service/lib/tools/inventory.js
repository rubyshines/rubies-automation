/**
 * Inventory MCP Tools — query synced inventory snapshots from Supabase
 *
 * Tools: get_inventory_snapshot
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Tool: get_inventory_snapshot
// ---------------------------------------------------------------------------

async function handleGetInventory({ product_handle, sku, days_back }) {
  const supabase = getSupabaseClient();
  const daysBack = days_back || 1;

  // Get the most recent date in the table
  const { data: latest, error: latestErr } = await supabase
    .from('inventory_snapshots')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);

  if (latestErr) throw new Error(`Supabase error: ${latestErr.message}`);
  if (!latest || !latest.length) {
    return { content: [{ type: 'text', text: 'No inventory data found. Run `npm run daily-inventory-tracking` first.' }] };
  }

  const latestDate = latest[0].date;

  if (daysBack === 1) {
    // Current snapshot only
    const data = await fetchAllPaginated(() => {
      let query = supabase
        .from('inventory_snapshots')
        .select('*')
        .eq('date', latestDate)
        .order('product_handle')
        .order('sku')
        .order('variant_id');

      if (product_handle) query = query.eq('product_handle', product_handle);
      if (sku) query = query.ilike('sku', `%${sku}%`);
      return query;
    });
    if (!data || !data.length) {
      return { content: [{ type: 'text', text: 'No inventory rows match your filters.' }] };
    }

    // Group by product_handle for readability
    const byProduct = {};
    let totalUnits = 0;
    for (const row of data) {
      const key = row.product_handle || 'unknown';
      if (!byProduct[key]) byProduct[key] = [];
      byProduct[key].push(row);
      totalUnits += row.inventory_quantity;
    }

    let md = `## Inventory Snapshot — ${latestDate}\n\n`;
    md += `**${data.length} variants** · **${totalUnits.toLocaleString()} total units**\n\n`;

    for (const [handle, variants] of Object.entries(byProduct)) {
      const productTotal = variants.reduce((s, v) => s + v.inventory_quantity, 0);
      md += `### ${handle} (${productTotal} units)\n\n`;
      md += `| SKU | Qty | Price |\n`;
      md += `|-----|-----|-------|\n`;
      for (const v of variants) {
        md += `| ${v.sku || '—'} | ${v.inventory_quantity} | $${Number(v.price).toFixed(2)} |\n`;
      }
      md += '\n';
    }

    return { content: [{ type: 'text', text: md }] };
  }

  // Multi-day trend
  const startDate = new Date(latestDate);
  startDate.setDate(startDate.getDate() - daysBack + 1);
  const startStr = startDate.toISOString().split('T')[0];

  // ~500 variant rows/day, so any multi-day trend blows past the 1000-row cap.
  const data = await fetchAllPaginated(() => {
    let query = supabase
      .from('inventory_snapshots')
      .select('date, product_handle, inventory_quantity')
      .gte('date', startStr)
      .lte('date', latestDate)
      .order('date')
      .order('variant_id');

    if (product_handle) query = query.eq('product_handle', product_handle);
    if (sku) query = query.ilike('sku', `%${sku}%`);
    return query;
  });
  if (!data || !data.length) {
    return { content: [{ type: 'text', text: 'No inventory data for the requested period.' }] };
  }

  // Aggregate by date
  const byDate = {};
  for (const row of data) {
    if (!byDate[row.date]) byDate[row.date] = 0;
    byDate[row.date] += row.inventory_quantity;
  }

  const dates = Object.keys(byDate).sort();
  const filter = product_handle || sku || 'all products';

  let md = `## Inventory Trend — ${dates[0]} to ${dates[dates.length - 1]} (${filter})\n\n`;
  md += `| Date | Total Units | Change |\n`;
  md += `|------|-------------|--------|\n`;

  let prev = null;
  for (const d of dates) {
    const qty = byDate[d];
    let change = '—';
    if (prev !== null) {
      const diff = qty - prev;
      change = diff > 0 ? `+${diff}` : `${diff}`;
    }
    md += `| ${d} | ${qty.toLocaleString()} | ${change} |\n`;
    prev = qty;
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: inventory_velocity
// ---------------------------------------------------------------------------

async function handleInventoryVelocity({ days_back, product_handle, min_sold }) {
  const supabase = getSupabaseClient();
  const daysBack = days_back || 30;
  const minSold = min_sold || 0;

  // Get date range for inventory
  const { data: latest } = await supabase
    .from('inventory_snapshots')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);

  if (!latest || !latest.length) {
    return { content: [{ type: 'text', text: 'No inventory data found.' }] };
  }

  const latestDate = latest[0].date;
  const startDate = new Date(latestDate);
  startDate.setDate(startDate.getDate() - daysBack);
  const startStr = startDate.toISOString().split('T')[0];

  // Fetch first and last snapshots in period
  let startQuery = supabase
    .from('inventory_snapshots')
    .select('product_handle, sku, inventory_quantity, price')
    .eq('date', startStr);
  let endQuery = supabase
    .from('inventory_snapshots')
    .select('product_handle, sku, inventory_quantity, price')
    .eq('date', latestDate);

  if (product_handle) {
    startQuery = startQuery.eq('product_handle', product_handle);
    endQuery = endQuery.eq('product_handle', product_handle);
  }

  // If exact start date doesn't exist, find closest
  let { data: startSnap } = await startQuery;
  if (!startSnap || !startSnap.length) {
    const { data: closestDate } = await supabase
      .from('inventory_snapshots')
      .select('date')
      .gte('date', startStr)
      .order('date', { ascending: true })
      .limit(1);

    if (closestDate && closestDate.length) {
      let retryQuery = supabase
        .from('inventory_snapshots')
        .select('product_handle, sku, inventory_quantity, price')
        .eq('date', closestDate[0].date);
      if (product_handle) retryQuery = retryQuery.eq('product_handle', product_handle);
      const { data: retryData } = await retryQuery;
      startSnap = retryData || [];
    }
  }

  const { data: endSnap } = await endQuery;

  if (!endSnap || !endSnap.length) {
    return { content: [{ type: 'text', text: 'No inventory data for the current date.' }] };
  }

  // Build maps: product_handle -> { totalStart, totalEnd, skus }
  const startMap = {};
  for (const row of (startSnap || [])) {
    const key = row.product_handle || 'unknown';
    if (!startMap[key]) startMap[key] = { total: 0, skus: {} };
    startMap[key].total += row.inventory_quantity;
    startMap[key].skus[row.sku] = row.inventory_quantity;
  }

  const products = {};
  for (const row of endSnap) {
    const key = row.product_handle || 'unknown';
    if (!products[key]) {
      products[key] = {
        handle: key,
        currentQty: 0,
        startQty: startMap[key]?.total || 0,
        price: row.price,
        skuDetails: [],
      };
    }
    products[key].currentQty += row.inventory_quantity;

    const skuStart = startMap[key]?.skus[row.sku] || 0;
    const skuDiff = skuStart - row.inventory_quantity;
    products[key].skuDetails.push({
      sku: row.sku,
      current: row.inventory_quantity,
      start: skuStart,
      sold: Math.max(0, skuDiff), // Negative means restock
      restocked: Math.max(0, -skuDiff),
    });
  }

  // Calculate velocity per product
  const productList = Object.values(products).map(p => {
    const netSold = Math.max(0, p.startQty - p.currentQty);
    const dailyVelocity = netSold / daysBack;
    const daysOfStock = dailyVelocity > 0 ? Math.round(p.currentQty / dailyVelocity) : Infinity;

    // Find low stock SKUs
    const lowStockSkus = p.skuDetails.filter(s => s.current > 0 && s.current <= 5);
    const outOfStockSkus = p.skuDetails.filter(s => s.current <= 0);

    return {
      ...p,
      netSold,
      dailyVelocity: Math.round(dailyVelocity * 100) / 100,
      daysOfStock,
      lowStockSkus,
      outOfStockSkus,
      revenueEstimate: netSold * Number(p.price || 0),
    };
  });

  // Filter and sort
  const filtered = productList
    .filter(p => p.netSold >= minSold)
    .sort((a, b) => b.netSold - a.netSold);

  if (!filtered.length) {
    return { content: [{ type: 'text', text: `No products found with ${minSold}+ units sold in the last ${daysBack} days.` }] };
  }

  let md = `## Inventory Velocity Report (${daysBack} days)\n`;
  md += `Period: ${startStr} to ${latestDate}\n\n`;

  // Summary table
  md += '| Product | Current | Sold | Daily Velocity | Days of Stock | Est. Revenue | Alerts |\n';
  md += '|---------|---------|------|----------------|---------------|--------------|--------|\n';

  for (const p of filtered) {
    const alerts = [];
    if (p.outOfStockSkus.length) alerts.push(`${p.outOfStockSkus.length} OOS`);
    if (p.lowStockSkus.length) alerts.push(`${p.lowStockSkus.length} low`);
    if (p.daysOfStock < 30 && p.daysOfStock !== Infinity) alerts.push(`<30d left`);

    const dosLabel = p.daysOfStock === Infinity ? '∞' : `${p.daysOfStock}d`;
    const alertStr = alerts.length ? alerts.join(', ') : '—';

    md += `| ${p.handle} | ${p.currentQty} | ${p.netSold} | ${p.dailyVelocity}/day | ${dosLabel} | $${p.revenueEstimate.toFixed(0)} | ${alertStr} |\n`;
  }

  // Alerts section
  const criticalProducts = filtered.filter(p => p.daysOfStock < 30 && p.daysOfStock !== Infinity);
  const oosProducts = filtered.filter(p => p.outOfStockSkus.length > 0);

  if (criticalProducts.length || oosProducts.length) {
    md += '\n### Alerts\n\n';

    if (criticalProducts.length) {
      md += '**Low stock (< 30 days at current velocity):**\n';
      for (const p of criticalProducts) {
        md += `- **${p.handle}**: ${p.currentQty} units left, selling ${p.dailyVelocity}/day → ~${p.daysOfStock} days\n`;
      }
      md += '\n';
    }

    if (oosProducts.length) {
      md += '**Out-of-stock SKUs:**\n';
      for (const p of oosProducts) {
        for (const s of p.outOfStockSkus) {
          md += `- **${p.handle}** ${s.sku}: was ${s.start}, now ${s.current}\n`;
        }
      }
    }
  }

  // Totals
  const totalSold = filtered.reduce((s, p) => s + p.netSold, 0);
  const totalRevenue = filtered.reduce((s, p) => s + p.revenueEstimate, 0);
  const totalCurrent = filtered.reduce((s, p) => s + p.currentQty, 0);
  md += `\n**Totals:** ${totalSold} units sold, ~$${totalRevenue.toFixed(0)} est. revenue, ${totalCurrent} units in stock\n`;

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'get_inventory_snapshot',
    description: 'Get current inventory levels or trends over time. Filter by product handle or SKU. Use days_back > 1 to see trends.',
    inputSchema: {
      type: 'object',
      properties: {
        product_handle: {
          type: 'string',
          description: 'Filter by Shopify product handle (e.g. "charlie-boxer-brief")',
        },
        sku: {
          type: 'string',
          description: 'Filter by SKU (partial match, e.g. "RUB-CH")',
        },
        days_back: {
          type: 'number',
          description: 'Number of days to look back (default 1 = current snapshot only, use higher for trends)',
        },
      },
      required: [],
    },
    handler: handleGetInventory,
  },
  {
    name: 'inventory_velocity',
    description: 'Inventory velocity analysis: units sold per product, daily sell-through rate, days-of-stock remaining, out-of-stock and low-stock alerts. Compares inventory snapshots over time to estimate demand.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: {
          type: 'number',
          description: 'Period to analyze (default: 30 days)',
        },
        product_handle: {
          type: 'string',
          description: 'Filter by product handle (e.g. "charlie-boxer-brief")',
        },
        min_sold: {
          type: 'number',
          description: 'Only show products with at least this many units sold (default: 0)',
        },
      },
      required: [],
    },
    handler: handleInventoryVelocity,
  },
];

module.exports = tools;
