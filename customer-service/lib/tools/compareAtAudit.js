/**
 * Tool: audit_compare_at_prices — every live variant whose compare-at price
 * differs from its retail price, read from Shopify (not the Supabase mirror,
 * which carries no compare-at), grouped by product.
 *
 * Why it matters: the theme's cart drawer sums compare-at prices and prints
 * the difference from the cart total as "You save". A compare-at left below
 * the price after a price rise understates every discount on that product.
 *
 * Direction per variant:
 *   stale — compare-at below price (a leftover from before a price rise;
 *           a $0.00 compare-at counts here and is called out as zero)
 *   sale  — compare-at above price (an intended markdown)
 *
 * Read-only. Fix with set_product_prices (compare_at_price / clear_compare_at).
 */

const { fetchAllVariantPricing } = require('../shopify');
const { getVariantSize, getVariantColor } = require('../sizeUtils');

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function titleCase(s) {
  if (!s) return '';
  return String(s).split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Pure: turn Shopify product pricing into the audit report.
 * products: [{ id, title, status, variants: [{ id, sku, title, price, compareAtPrice, selectedOptions }] }]
 * Returns { products: [...differing products], totals }.
 */
function buildCompareAtReport(products, { includeArchived = false } = {}) {
  const totals = { products: 0, differing: 0, stale: 0, sale: 0, equal: 0, unset: 0, variants: 0 };
  const out = [];

  for (const p of products) {
    if (!includeArchived && p.status === 'ARCHIVED') continue;
    const rows = [];
    for (const v of p.variants || []) {
      totals.variants++;
      const price = parseFloat(v.price);
      if (v.compareAtPrice === null || v.compareAtPrice === undefined || v.compareAtPrice === '') {
        totals.unset++;
        continue;
      }
      const compareAt = parseFloat(v.compareAtPrice);
      if (compareAt === price) {
        totals.equal++;
        continue;
      }
      const direction = compareAt < price ? 'stale' : 'sale';
      totals.differing++;
      totals[direction]++;
      rows.push({
        variantId: v.id,
        sku: v.sku || null,
        size: getVariantSize(v),
        color: getVariantColor(v),
        price,
        compareAt,
        gap: Math.round((compareAt - price) * 100) / 100,
        direction,
      });
    }
    if (!rows.length) continue;
    totals.products++;
    out.push({
      productId: p.id,
      title: p.title,
      status: p.status,
      variantCount: (p.variants || []).length,
      stale: rows.filter(r => r.direction === 'stale').length,
      sale: rows.filter(r => r.direction === 'sale').length,
      rows,
    });
  }

  out.sort((a, b) => a.title.localeCompare(b.title));
  return { products: out, totals };
}

function describeRow(r) {
  if (r.compareAt === 0) {
    return `price ${money(r.price)}, compare-at $0.00 (zero, should be cleared)`;
  }
  const gapWord = r.direction === 'stale' ? 'below' : 'above';
  return `price ${money(r.price)}, compare-at ${money(r.compareAt)} (${money(Math.abs(r.gap))} ${gapWord}, ${r.direction})`;
}

/** Pure: render the report as the tool's text. */
function formatCompareAtReport(report) {
  const t = report.totals;
  const lines = [];
  lines.push(
    `**Compare-at audit** — ${t.differing} variant${t.differing === 1 ? '' : 's'} differ across ` +
    `${t.products} product${t.products === 1 ? '' : 's'} (${t.stale} stale, ${t.sale} on sale). ` +
    `Of ${t.variants} variants checked, ${t.equal} have compare-at equal to price and ${t.unset} have none.`
  );

  if (!report.products.length) {
    lines.push('', 'Nothing to fix: every compare-at is equal to its price or unset.');
    return lines.join('\n');
  }

  for (const p of report.products) {
    const parts = [];
    if (p.stale) parts.push(`${p.stale} stale`);
    if (p.sale) parts.push(`${p.sale} on sale`);
    lines.push('', `**${p.title}** [${p.status}] — ${parts.join(', ')} of ${p.variantCount} variant${p.variantCount === 1 ? '' : 's'}`);

    // One line when every differing variant shares the same numbers; otherwise
    // one line per variant.
    const distinct = new Set(p.rows.map(r => `${r.price}|${r.compareAt}`));
    if (distinct.size === 1 && p.rows.length > 1) {
      lines.push(`  ${p.rows.length} variants: ${describeRow(p.rows[0])}`);
      const sizes = [...new Set(p.rows.map(r => r.size).filter(Boolean))].map(s => s.toUpperCase());
      const colors = [...new Set(p.rows.map(r => r.color).filter(Boolean))].map(titleCase);
      if (sizes.length) lines.push(`  Sizes: ${sizes.join(', ')}`);
      if (colors.length) lines.push(`  Colours: ${colors.join(', ')}`);
    } else {
      for (const r of p.rows) {
        const desc = [r.color ? titleCase(r.color) : null, r.size ? r.size.toUpperCase() : null].filter(Boolean).join(' / ');
        lines.push(`  ${r.sku || r.variantId}${desc ? ` (${desc})` : ''}: ${describeRow(r)}`);
      }
    }
  }

  lines.push('', 'Fix with set_product_prices: compare_at_price equal to the price, or clear_compare_at: true. A product deliberately on sale keeps its compare-at above the price.');
  return lines.join('\n');
}

async function auditCompareAtPrices({ includeArchived = false } = {}) {
  const products = await fetchAllVariantPricing();
  return buildCompareAtReport(products, { includeArchived });
}

const tools = [
  {
    name: 'audit_compare_at_prices',
    description: 'Read-only audit of compare-at ("was") prices: lists every variant on the live store whose compare-at differs from its retail price, grouped by product, with the gap and direction (stale = compare-at below price, left over from a price rise; sale = above price, an intended markdown). Reads Shopify directly so it is current. Archived products are skipped unless include_archived is true. Fix findings with set_product_prices.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: {
          type: 'boolean',
          description: 'Include ARCHIVED products. Default false.',
        },
      },
    },
    handler: async ({ include_archived } = {}) => {
      const report = await auditCompareAtPrices({ includeArchived: include_archived === true });
      return { content: [{ type: 'text', text: formatCompareAtReport(report) }] };
    },
  },
];

module.exports = tools;
module.exports.buildCompareAtReport = buildCompareAtReport;
module.exports.formatCompareAtReport = formatCompareAtReport;
module.exports.auditCompareAtPrices = auditCompareAtPrices;
