/**
 * Build the QC review VIEW written to the "2026 Production Numbers" Google Sheet —
 * the founder's decision surface for a production order's QC results. Supabase
 * stays the source of truth; this tab is a rewritten-on-demand view, same pattern
 * as "Reconcile — <code>".
 *
 * Sections: header · AQL inspection results (per product, pass/fail + findings) ·
 * coverage warnings · flagged out-of-tolerance measurement groups (worst first)
 * with an AI-triaged Verdict + Why, and an empty Decision column for Jamie
 * (OK / REWORK / DISCUSS). Pure — takes assembled review data, no DB/AI calls.
 */

// Verdict cell colors: what kind of problem each flag is.
const VERDICT_COLORS = {
  real_deviation: { red: 0.96, green: 0.80, blue: 0.80 },      // red — garment is off
  stale_sheet_target: { red: 1, green: 0.95, blue: 0.75 },     // yellow — sheet Orig is wrong, garment likely fine
  data_entry_suspect: { red: 1, green: 0.88, blue: 0.75 },     // orange — measurement looks mistyped
  unclear: { red: 0.92, green: 0.92, blue: 0.92 },             // grey
};

const VERDICT_LABELS = {
  real_deviation: 'REAL DEVIATION',
  stale_sheet_target: 'STALE SHEET TARGET',
  data_entry_suspect: 'DATA-ENTRY SUSPECT',
  unclear: 'UNCLEAR',
};

// "BLK: 43.5/44/44 · PNK: 45/44.8" — compact per-color sample rendering.
function renderSamples(samples) {
  const byColor = new Map();
  for (const s of samples) {
    if (!byColor.has(s.color)) byColor.set(s.color, []);
    byColor.get(s.color).push(s.measured_cm);
  }
  return [...byColor.entries()].map(([c, vals]) => `${c}: ${vals.join('/')}`).join(' · ');
}

const fmtDiff = (d) => (d == null ? '' : `${d > 0 ? '+' : ''}${d}`);

/**
 * @param review {
 *   order, totals, inspections, aql: [{product_name, category, passed, majors, minors, findings: [string]}],
 *   packing_status, coverage, groups: [{ product, tab, size, pom_code, pom_name, tolerance_cm,
 *     sheet_target, spec_target, samples: [{color, measured_cm, diff_cm}], worst_diff,
 *     verdict, why }]  — worst-first
 * }
 * @returns { values, boldRows, flagCells, flagColors, ncol }
 */
function buildQcReviewRows(review, dateStr) {
  const rows = [];
  const boldRows = [];
  const flagCells = [];
  const NCOL = 11;
  const VERDICT_COL = 8; // 0-based: Product,Size,POM,Tol,SheetTarget,SpecTarget,Samples,WorstDiff,Verdict,Why,Decision

  boldRows.push(rows.length);
  rows.push([
    `QC Review — ${review.order.production_code} (as of ${dateStr}) · ${review.totals.measurements.toLocaleString()} measurements · ${review.totals.skus_measured} SKUs sampled · ${review.totals.out_of_tolerance} out of tolerance`,
  ]);
  rows.push([]);

  // --- AQL inspection results ------------------------------------------------
  boldRows.push(rows.length);
  rows.push(['📋 AQL INSPECTION' + (review.inspector ? ` (${review.inspector})` : '')]);
  for (const p of review.aql) {
    rows.push([
      `${p.passed ? '✅ PASSED' : '❌ FAILED'}  ${p.product_name}`,
      `majors ${p.majors ?? 0} / minors ${p.minors ?? 0}`,
      p.findings.join('; ') || 'no defects found',
    ]);
    if (!p.passed) flagCells.push({ row: rows.length - 1, col: 0, flag: 'real_deviation' });
  }
  if (review.packing_status) rows.push([`Packing: ${review.packing_status}`]);
  rows.push([]);

  // --- Coverage ----------------------------------------------------------------
  const cov = review.coverage || {};
  if ((cov.not_sampled || []).length || (cov.sampled_not_ordered || []).length) {
    boldRows.push(rows.length);
    rows.push(['🔍 COVERAGE']);
    if ((cov.not_sampled || []).length) rows.push([`Ordered but NOT sampled: ${cov.not_sampled.join(', ')}`]);
    if ((cov.sampled_not_ordered || []).length) rows.push([`Sampled but NOT on this order: ${cov.sampled_not_ordered.join(', ')}`]);
    rows.push([]);
  }

  // --- Flagged measurement groups ------------------------------------------------
  boldRows.push(rows.length);
  rows.push([`⚠ FLAGGED MEASUREMENTS — ${review.groups.length} out-of-tolerance groups, worst first`]);
  rows.push(['Mark Decision: OK (accept) / REWORK / DISCUSS. Verdict + Why are AI triage — check anything marked REAL DEVIATION first.']);
  boldRows.push(rows.length);
  rows.push(['Product', 'Size', 'POM', 'Tolerance', 'Sheet Target', 'Spec Target', 'Samples (cm)', 'Worst Diff', 'Verdict', 'Why', 'Decision']);

  for (const g of review.groups) {
    rows.push([
      g.product,
      g.size,
      `${g.pom_code}${g.pom_name ? ` — ${g.pom_name}` : ''}`,
      g.tolerance_cm == null ? '' : `±${g.tolerance_cm}`,
      g.sheet_target ?? '',
      g.spec_target ?? '',
      renderSamples(g.samples),
      fmtDiff(g.worst_diff),
      VERDICT_LABELS[g.verdict] || (g.verdict || ''),
      g.why || '',
      '',
    ]);
    if (g.verdict) flagCells.push({ row: rows.length - 1, col: VERDICT_COL, flag: g.verdict });
  }
  if (!review.groups.length) rows.push(['None — every measured sample within tolerance.']);

  rows.push([]);
  boldRows.push(rows.length);
  rows.push(['✍️ When done: run approve_production_qc (per category — swimwear and underwear approve independently).']);

  return { values: rows, boldRows, flagCells, flagColors: VERDICT_COLORS, ncol: NCOL };
}

module.exports = { buildQcReviewRows, renderSamples, VERDICT_COLORS, VERDICT_LABELS };
