/**
 * Grading-consistency analysis — "the first thing Jamie does with a new tech pack."
 *
 * For each (product, POM) it walks consecutive sizes, computes the grading STEP (delta),
 * and classifies the rule as:
 *   - FIXED       constant step across all sizes
 *   - PATTERNED   step varies but monotonic with no outliers (intentional grade-rule
 *                 changes at size breaks, e.g. youth->adult doubling, half-steps)
 *   - ANOMALY     a step that breaks the pattern — almost always a tech-pack typo
 *                 (decimal slip / dropped digit), surfaced for review
 *
 * Pure functions: deterministic output for a given grading map. The "intentional vs error"
 * judgment on flagged anomalies is left to the caller (advisor/Opus); this module is the
 * deterministic detector that proposes candidates with a reason.
 *
 * Input shape (matches the overnight grading-specs.json dump):
 *   { [product_handle]: { [pom_code]: { pom_name, tolerance_cm, sizes: { [size]: cm } } } }
 */

const { NUMERIC_SIZES, LETTER_SIZES, SIZE_ALIASES, parseSizeVariant } = require('../sizeUtils');

// Canonical rank for a size token. Numeric sizes sort before letter sizes. Returns -1 if
// unrecognized. Handles combined aliases like "12 / XS" by ranking on the first parseable token.
function sizeRank(size) {
  const raw = String(size == null ? '' : size).toUpperCase().trim();
  if (!raw) return -1;
  const tokens = raw.split(/[\/,]|\s+/).map(t => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    const { base } = parseSizeVariant(tok);
    const canonical = (base && (SIZE_ALIASES[base] || base)) || tok;
    const ni = NUMERIC_SIZES.indexOf(canonical);
    if (ni !== -1) return ni;
    const li = LETTER_SIZES.indexOf(canonical);
    if (li !== -1) return 100 + li;
  }
  return -1;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Order a POM's sizes canonically and pair each with its numeric target.
function orderedPoints(sizesMap) {
  return Object.entries(sizesMap || {})
    .map(([size, cm]) => ({ size, rank: sizeRank(size), target: toNumber(cm) }))
    .filter(p => p.rank !== -1 && p.target != null)
    .sort((a, b) => a.rank - b.rank);
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  // Tolerate stringy cells; a value the parser couldn't clean (e.g. "50..8", "33.") -> null + flag upstream
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

/**
 * Analyze a single POM's size run.
 * @returns { pattern, deltas, anomalies, medianStep, points }
 */
function analyzePom(sizesMap, tolerance) {
  const points = orderedPoints(sizesMap);
  if (points.length < 3) {
    return { pattern: 'INSUFFICIENT', deltas: [], anomalies: [], medianStep: 0, points };
  }
  const tol = (typeof tolerance === 'number' && tolerance > 0) ? tolerance : null;
  // A backward step smaller than this is almost certainly rounding noise, not a typo.
  const monoFloor = Math.max(1, tol ? 2 * tol : 1);

  const deltas = [];
  for (let i = 1; i < points.length; i++) {
    deltas.push({
      from: points[i - 1],
      to: points[i],
      delta: round2(points[i].target - points[i - 1].target),
    });
  }

  const anomalies = [];

  // (1) Monotonicity — garment measurements should grow with size. A decrease is a strong
  //     typo signal (a wrong value usually dips below its neighbours).
  for (const d of deltas) {
    if (d.delta < 0) {
      const mag = Math.abs(d.delta);
      anomalies.push({
        kind: 'non_monotonic',
        severity: mag > monoFloor ? 'high' : 'low',
        from: d.from.size, to: d.to.size,
        fromValue: d.from.target, toValue: d.to.target,
        delta: d.delta,
        reason: `measurement drops from ${d.from.size} (${d.from.target}) to ${d.to.size} (${d.to.target}); ${mag > monoFloor ? 'measurements should grow with size — likely a typo' : 'small dip within rounding range, probably fine'}`,
      });
    }
  }

  // (2) Value outlier — an interior measurement far from where its neighbours imply it should
  //     sit. Pinpoints a single bad cell (decimal slip / dropped digit) even when that value
  //     pollutes the deltas around it. Scale uses deltas NOT touching this point.
  const absDeltas = deltas.map(d => Math.abs(d.delta));
  const medianStep = median(deltas.map(d => d.delta).filter(x => x > 0));
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], cur = points[i], next = points[i + 1];
    const expected = (prev.target + next.target) / 2;
    const deviation = Math.abs(cur.target - expected);
    const others = absDeltas.filter((_, idx) => idx !== i - 1 && idx !== i);
    const typical = median(others);
    const threshold = Math.max(3, 3 * typical);
    if (deviation > threshold) {
      anomalies.push({
        kind: 'value_outlier',
        severity: 'high',
        size: cur.size,
        value: cur.target,
        expected: round2(expected),
        delta: round2(cur.target - expected),
        reason: `${cur.size} (${cur.target}) sits ${round2(deviation)}cm off the ~${round2(expected)} implied by neighbours ${prev.size}/${next.size}; likely a decimal/dropped-digit typo`,
      });
    }
  }

  // Only a HIGH-severity anomaly demotes the rule to ANOMALY; low-severity dips (rounding)
  // are still surfaced in the list but don't override an otherwise-clean pattern.
  const hasHigh = anomalies.some(a => a.severity === 'high');
  let pattern;
  if (hasHigh) {
    pattern = 'ANOMALY';
  } else {
    const allEqual = deltas.every(d => Math.abs(d.delta - deltas[0].delta) < 0.05);
    pattern = allEqual ? 'FIXED' : 'PATTERNED';
  }

  return { pattern, deltas, anomalies, medianStep, points };
}

/**
 * Analyze every product/POM in a grading map.
 * @returns { products: { [handle]: { [pom]: analysis } }, anomalies: [flat list], summary }
 */
function analyzeGrading(specsByProduct) {
  const products = {};
  const flatAnomalies = [];
  let pomCount = 0;

  for (const [handle, poms] of Object.entries(specsByProduct || {})) {
    products[handle] = {};
    for (const [pomCode, spec] of Object.entries(poms || {})) {
      pomCount += 1;
      const analysis = analyzePom(spec.sizes, spec.tolerance_cm);
      products[handle][pomCode] = { pom_name: spec.pom_name, ...analysis };
      for (const a of analysis.anomalies) {
        flatAnomalies.push({ product_handle: handle, pom_code: pomCode, pom_name: spec.pom_name, ...a });
      }
    }
  }

  const summary = {
    products: Object.keys(products).length,
    poms: pomCount,
    anomalies: flatAnomalies.length,
  };
  return { products, anomalies: flatAnomalies, summary };
}

module.exports = { sizeRank, analyzePom, analyzeGrading, orderedPoints };
