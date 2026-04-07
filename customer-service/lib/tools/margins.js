/**
 * Margin & COGS MCP Tools
 *
 * Tools: get_product_margins, get_order_profitability, get_wholesale_margins
 */

const { searchProducts } = require('../productCache');
const { getOrderByNumber } = require('../shopify');
const { getOrderByNumberFromSupabase } = require('../supabaseQueries');
const { getCostForSku, getCostByPrefix, getAllCosts } = require('../costsCache');

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `$${Number(n).toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${(n * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Tool: get_product_margins
// ---------------------------------------------------------------------------

async function handleProductMargins({ query }) {
  const results = searchProducts(query);
  if (!results.length) {
    return { content: [{ type: 'text', text: `No products found for "${query}".` }] };
  }

  // Dedupe by variant to avoid repeats
  const seen = new Set();
  const rows = [];

  for (const r of results) {
    if (seen.has(r.variantId)) continue;
    seen.add(r.variantId);

    const cost = await getCostForSku(r.sku);
    const retail = parseFloat(r.price);
    const cogs = cost ? parseFloat(cost.total_landed_cost) : null;
    const marginDollar = cogs != null ? retail - cogs : null;
    const marginPct = cogs != null && retail > 0 ? marginDollar / retail : null;

    rows.push({
      product: r.productTitle,
      variant: r.variantTitle,
      sku: r.sku || '—',
      retail,
      cogs,
      marginDollar,
      marginPct,
    });
  }

  let md = `## Product Margins: "${query}"\n\n`;
  md += '| Product | Variant | SKU | Retail | COGS | Margin $ | Margin % |\n';
  md += '|---------|---------|-----|--------|------|----------|----------|\n';

  for (const r of rows) {
    md += `| ${r.product} | ${r.variant} | ${r.sku} | ${fmtCurrency(r.retail)} | ${fmtCurrency(r.cogs)} | ${fmtCurrency(r.marginDollar)} | ${fmtPct(r.marginPct)} |\n`;
  }

  if (rows.some(r => r.cogs == null)) {
    md += '\n*Some variants have no COGS data — run `npm run cs-sync-costs` to update.*';
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: get_order_profitability
// ---------------------------------------------------------------------------

async function handleOrderProfitability({ order_number }) {
  let order = await getOrderByNumberFromSupabase(order_number);
  if (!order) order = await getOrderByNumber(order_number);

  let totalRevenue = 0;
  let totalCogs = 0;
  let hasAllCosts = true;
  const lineRows = [];

  for (const li of order.lineItems) {
    const unitPrice = parseFloat(li.originalUnitPriceSet?.shopMoney?.amount || 0);
    const lineRevenue = unitPrice * li.quantity;
    totalRevenue += lineRevenue;

    const cost = await getCostForSku(li.sku);
    const unitCogs = cost ? parseFloat(cost.total_landed_cost) : null;
    const lineCogs = unitCogs != null ? unitCogs * li.quantity : null;

    if (lineCogs != null) {
      totalCogs += lineCogs;
    } else {
      hasAllCosts = false;
    }

    const lineMargin = lineCogs != null ? lineRevenue - lineCogs : null;
    const linePct = lineCogs != null && lineRevenue > 0 ? lineMargin / lineRevenue : null;

    lineRows.push({
      title: `${li.title}${li.variantTitle ? ` / ${li.variantTitle}` : ''}`,
      sku: li.sku || '—',
      qty: li.quantity,
      unitPrice,
      unitCogs,
      lineRevenue,
      lineCogs,
      lineMargin,
      linePct,
    });
  }

  const grossProfit = hasAllCosts ? totalRevenue - totalCogs : null;
  const overallMargin = hasAllCosts && totalRevenue > 0 ? grossProfit / totalRevenue : null;

  let md = `## Order Profitability: ${order.name}\n\n`;
  md += '| Item | SKU | Qty | Unit Price | Unit COGS | Line Revenue | Line COGS | Margin |\n';
  md += '|------|-----|-----|------------|-----------|--------------|-----------|--------|\n';

  for (const r of lineRows) {
    md += `| ${r.title} | ${r.sku} | ${r.qty} | ${fmtCurrency(r.unitPrice)} | ${fmtCurrency(r.unitCogs)} | ${fmtCurrency(r.lineRevenue)} | ${fmtCurrency(r.lineCogs)} | ${fmtPct(r.linePct)} |\n`;
  }

  md += '\n### Summary\n\n';
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Revenue | ${fmtCurrency(totalRevenue)} |\n`;
  md += `| Total COGS | ${hasAllCosts ? fmtCurrency(totalCogs) : 'Incomplete'} |\n`;
  md += `| Gross Profit | ${fmtCurrency(grossProfit)} |\n`;
  md += `| Margin % | ${fmtPct(overallMargin)} |\n`;

  if (!hasAllCosts) {
    md += '\n*Some line items have no COGS data — margin totals may be incomplete.*';
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: get_wholesale_margins
// ---------------------------------------------------------------------------

async function handleWholesaleMargins({ query, country_code }) {
  const results = searchProducts(query);
  if (!results.length) {
    return { content: [{ type: 'text', text: `No products found for "${query}".` }] };
  }

  // Determine applicable tier
  const isUsAu = country_code && ['US', 'AU'].includes(country_code.toUpperCase());
  const tierLabel = country_code
    ? (isUsAu ? '50% off (US/AU)' : '30% off (International)')
    : null;

  // Dedupe by product (show one representative variant per product)
  const seenProducts = new Set();
  const rows = [];

  for (const r of results) {
    if (seenProducts.has(r.productTitle)) continue;
    seenProducts.add(r.productTitle);

    const cost = await getCostForSku(r.sku);
    const retail = parseFloat(r.price);
    const cogs = cost ? parseFloat(cost.total_landed_cost) : null;

    const w50 = retail * 0.50;
    const w70 = retail * 0.70;
    const margin50 = cogs != null ? w50 - cogs : null;
    const margin70 = cogs != null ? w70 - cogs : null;
    const pct50 = cogs != null && w50 > 0 ? margin50 / w50 : null;
    const pct70 = cogs != null && w70 > 0 ? margin70 / w70 : null;

    rows.push({
      product: r.productTitle,
      sku: r.sku || '—',
      retail,
      cogs,
      w50, margin50, pct50,
      w70, margin70, pct70,
    });
  }

  let md = `## Wholesale Margins: "${query}"`;
  if (tierLabel) md += ` — ${tierLabel}`;
  md += '\n\n';

  md += '| Product | SKU | Retail | COGS | 50% Off Price | 50% Margin | 30% Off Price | 30% Margin |\n';
  md += '|---------|-----|--------|------|---------------|------------|---------------|------------|\n';

  for (const r of rows) {
    const highlight50 = isUsAu ? '**' : '';
    const highlight70 = country_code && !isUsAu ? '**' : '';
    md += `| ${r.product} | ${r.sku} | ${fmtCurrency(r.retail)} | ${fmtCurrency(r.cogs)} | ${highlight50}${fmtCurrency(r.w50)}${highlight50} | ${highlight50}${fmtCurrency(r.margin50)} (${fmtPct(r.pct50)})${highlight50} | ${highlight70}${fmtCurrency(r.w70)}${highlight70} | ${highlight70}${fmtCurrency(r.margin70)} (${fmtPct(r.pct70)})${highlight70} |\n`;
  }

  if (rows.some(r => r.cogs == null)) {
    md += '\n*Some products have no COGS data — run `npm run cs-sync-costs` to update.*';
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'get_product_margins',
    description: 'Show retail price vs COGS (landed cost) margins for products. Search by product name, SKU, or SKU prefix. Returns a table with retail price, COGS, margin $ and margin %.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Product name, SKU, or SKU prefix to search (e.g. "AJ", "Ruby", "UNW-M-BLK")',
        },
      },
      required: ['query'],
    },
    handler: handleProductMargins,
  },
  {
    name: 'get_order_profitability',
    description: 'Calculate profitability of a Shopify order. Shows per-line-item revenue, COGS, and margin, plus order totals. Uses landed costs from the COGS database.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: 'Shopify order number (e.g. "1042", "#1042")',
        },
      },
      required: ['order_number'],
    },
    handler: handleOrderProfitability,
  },
  {
    name: 'get_wholesale_margins',
    description: 'Show margins at wholesale pricing tiers (50% off for US/AU, 30% off for international). Compares wholesale price against COGS to show margin at each tier.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Product name, SKU, or SKU prefix to search',
        },
        country_code: {
          type: 'string',
          description: 'Optional 2-letter country code (e.g. "US", "AU", "GB") to highlight the applicable wholesale tier',
        },
      },
      required: ['query'],
    },
    handler: handleWholesaleMargins,
  },
];

module.exports = tools;
