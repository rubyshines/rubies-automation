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

const SEVERITY_ICONS = { high: '❗', medium: '⚠️', low: '·' };

/**
 * @param review {
 *   order, totals, inspections, aql: [{product_name, category, passed, majors, minors, findings: [string]}],
 *   packing_status, coverage,
 *   findings: [{title, verdict, severity, scope, evidence, action, group_ids}] — the generalities,
 *   groups: [{ product, tab, size, pom_code, pom_name, tolerance_cm, sheet_target, spec_target,
 *     samples: [{color, measured_cm, diff_cm}], worst_diff, verdict, why }]  — worst-first detail
 * }
 * Layout is findings-first: the founder reviews and decides on ~a dozen
 * generalities; the per-group detail sits at the bottom as reference only.
 * @returns { values, boldRows, flagCells, flagColors, ncol }
 */
function buildQcReviewRows(review, dateStr) {
  const rows = [];
  const boldRows = [];
  const flagCells = [];
  const NCOL = 7;
  const findings = review.findings || [];

  boldRows.push(rows.length);
  rows.push([
    `QC Review — ${review.order.production_code} (as of ${dateStr}) · ${review.totals.measurements.toLocaleString()} measurements · ${review.totals.skus_measured} SKUs sampled · ${review.totals.out_of_tolerance} out of tolerance`,
  ]);
  rows.push([]);

  // --- Key findings — the decision surface ------------------------------------
  const FINDING_VERDICT_COL = 4; // #,Finding,Scope,Evidence,Verdict,Action,Decision
  boldRows.push(rows.length);
  rows.push([`🎯 KEY FINDINGS (${findings.length}) — decide here; per-measurement detail is at the bottom for reference`]);
  rows.push(['Mark Decision: OK (accept) / REWORK / DISCUSS.']);
  if (findings.length) {
    boldRows.push(rows.length);
    rows.push(['#', 'Finding', 'Scope', 'Evidence', 'Verdict', 'Suggested action', 'Decision']);
    findings.forEach((f, i) => {
      rows.push([
        `${SEVERITY_ICONS[f.severity] || ''} F${i + 1}`,
        f.title,
        f.scope,
        f.evidence,
        VERDICT_LABELS[f.verdict] || (f.verdict || ''),
        f.action,
        '',
      ]);
      if (f.verdict) flagCells.push({ row: rows.length - 1, col: FINDING_VERDICT_COL, flag: f.verdict });
    });
  } else if (!review.groups.length) {
    rows.push(['None — every measured sample within tolerance.']);
  } else {
    rows.push([`(untriaged run — ${review.groups.length} out-of-tolerance groups in the detail section below)`]);
  }
  rows.push([]);
  boldRows.push(rows.length);
  rows.push(['✍️ When done: run approve_production_qc (per category — swimwear and underwear approve independently).']);
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

  // --- Detail (reference only) -------------------------------------------------
  if (review.groups.length) {
    // Finding id per group, so detail rows trace back to the finding they support.
    const findingByGroup = new Map();
    findings.forEach((f, i) => (f.group_ids || []).forEach((gid) => findingByGroup.set(gid, `F${i + 1}`)));
    rows.push([]);
    boldRows.push(rows.length);
    rows.push([`📎 FULL DETAIL — ${review.groups.length} out-of-tolerance groups, worst first (reference; decisions go in KEY FINDINGS above)`]);
    boldRows.push(rows.length);
    rows.push(['Finding', 'Product', 'Size', 'POM', 'Tolerance', 'Sheet Target', 'Spec Target', 'Samples (cm)', 'Worst Diff', 'Triage']);
    for (const g of review.groups) {
      rows.push([
        findingByGroup.get(g.id) || '',
        g.product,
        g.size,
        `${g.pom_code}${g.pom_name ? ` — ${g.pom_name}` : ''}`,
        g.tolerance_cm == null ? '' : `±${g.tolerance_cm}`,
        g.sheet_target ?? '',
        g.spec_target ?? '',
        renderSamples(g.samples),
        fmtDiff(g.worst_diff),
        g.why || '',
      ]);
    }
  }

  return { values: rows, boldRows, flagCells, flagColors: VERDICT_COLORS, ncol: NCOL };
}

module.exports = { buildQcReviewRows, renderSamples, VERDICT_COLORS, VERDICT_LABELS };
