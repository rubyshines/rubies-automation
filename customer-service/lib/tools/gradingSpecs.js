/**
 * MCP tools: get_graded_specs, check_grading_consistency
 * Read the digitized tech-pack grading and run the consistency analysis.
 */

const { getGradedSpecs, checkGradingConsistency } = require('../merchandising/gradingSpecs');

function fmt(n) {
  return n == null ? '-' : String(n);
}

async function handleGetGradedSpecs({ product_handle, size }) {
  if (!product_handle) return { content: [{ type: 'text', text: 'Error: `product_handle` is required (e.g. "aj", "ruby").' }] };
  const { rows } = await getGradedSpecs({ product_handle, size });
  if (!rows.length) {
    return { content: [{ type: 'text', text: `No current graded specs for "${product_handle}"${size ? ` size ${size}` : ''}.` }] };
  }
  const lines = [`## Graded specs — ${product_handle}${size ? ` · size ${size}` : ''} (${rows.length} rows)`, '', '| POM | Name | Size | Target (cm) | Tol (±cm) |', '|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.pom_code} | ${r.pom_name || ''} | ${r.size} | ${fmt(r.target_cm)} | ${fmt(r.tolerance_cm)} |`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleCheckGradingConsistency({ product_handle }) {
  const { products, anomalies, summary } = await checkGradingConsistency({ product_handle });
  const high = anomalies.filter(a => a.severity === 'high');
  const low = anomalies.filter(a => a.severity !== 'high');

  const lines = [
    `## Grading consistency${product_handle ? ` — ${product_handle}` : ' — all products'}`,
    '',
    `Products: ${summary.products} · POMs: ${summary.poms} · High-severity anomalies: ${high.length} · Low (likely rounding): ${low.length}`,
    '',
  ];

  if (high.length) {
    lines.push('### ⚠️ Likely typos (review/correct)');
    for (const a of high) {
      const loc = a.size ? `size ${a.size}` : `${a.from}->${a.to}`;
      lines.push(`- **${a.product_handle}/${a.pom_code}** ${a.pom_name || ''} @ ${loc} — ${a.reason}`);
    }
    lines.push('');
  } else {
    lines.push('No high-severity anomalies. ✅', '');
  }

  // Per-product rule classification when a single product was requested
  if (product_handle && products[product_handle]) {
    lines.push('### Per-POM grading rule');
    for (const [pom, a] of Object.entries(products[product_handle])) {
      lines.push(`- ${pom} ${a.pom_name || ''}: **${a.pattern}**`);
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

module.exports = [
  {
    name: 'get_graded_specs',
    description: 'Get the current tech-pack graded measurement specs (POM, target cm, tolerance) for a product, optionally filtered to one size. Reads tech_pack_specs.',
    inputSchema: {
      type: 'object',
      properties: {
        product_handle: { type: 'string', description: 'Product handle, e.g. "aj", "ruby", "stella"' },
        size: { type: 'string', description: 'Optional single size, e.g. "M", "12"' },
      },
      required: ['product_handle'],
    },
    handler: handleGetGradedSpecs,
  },
  {
    name: 'check_grading_consistency',
    description: 'Analyze grading-step consistency for a product (or all products). Walks consecutive sizes per POM, classifies the rule FIXED/PATTERNED/ANOMALY, and flags likely typos (non-monotonic drops, value outliers) with severity. Omit product_handle to scan everything.',
    inputSchema: {
      type: 'object',
      properties: {
        product_handle: { type: 'string', description: 'Optional product handle to scope the check' },
      },
    },
    handler: handleCheckGradingConsistency,
  },
];
