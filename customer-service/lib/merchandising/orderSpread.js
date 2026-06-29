/**
 * Order-quantity rules applied to projection rows before a draft is written.
 *
 * Two rules, both locked in initiative_production_pipeline.md (Decision 6):
 *   1. Per-SKU production floor = 20 units (Kali's manufacturing minimum). Every
 *      committed size line is >= 20: thin sizes round UP to 20. A dead size
 *      (no projected need) is dropped, not floored — projection rows already
 *      exclude qty_to_order <= 0, so nothing dead reaches here.
 *   2. Founder unit override: order a target TOTAL for a style (e.g. Naomi 3000)
 *      and apply that style's size/color spread to the new total, instead of the
 *      projected need. The spread = the style's projected per-SKU proportions.
 *
 * Pure functions only (no Supabase / Sheets) so the math is unit-tested in
 * isolation; productionOrderLoop.js is the I/O orchestrator that calls these.
 */

const PER_SKU_FLOOR = 20;
// Overridden spreads are rounded to clean multiples of this many units per size.
const ORDER_STEP = 10;

/**
 * Distribute `target` units across items in proportion to `weights`, returning
 * integers that sum to the (step-rounded) target via largest-remainder
 * apportionment, with every line that has a positive weight >= `floor`. Items
 * with weight 0 stay 0. Every allocation is a multiple of `step` — the math runs
 * in whole `step` units and scales back, so the target is first rounded to the
 * nearest multiple of `step` (returned as `target` so the caller can flag it).
 *
 * Thin lines round up to the floor; the units needed to do so are reclaimed from
 * the largest lines (never dropping a donor below the floor). If even one step
 * unit per active line already meets/exceeds the target, the floor wins: every
 * active line is set to the floor and `infeasible` is true.
 *
 * @param {number[]} weights  proportional weight per line (e.g. projected qty)
 * @param {number}   target   desired total units
 * @param {number}   floor    minimum units for any nonzero line
 * @param {number}   step     allocations are rounded to multiples of this (default 1)
 * @returns {{ alloc: number[], infeasible: boolean, target: number }}
 */
function distributeWithFloor(weights, target, floor = PER_SKU_FLOOR, step = 1) {
  const n = weights.length;
  const active = weights.map((w) => w > 0);
  const activeCount = active.filter(Boolean).length;
  const W = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);

  if (activeCount === 0 || target <= 0) {
    return { alloc: weights.map(() => 0), infeasible: target > 0 && activeCount > 0, target: 0 };
  }

  // Work in whole `step` units so every allocation is a multiple of step, then
  // scale back at the end. T = target in steps; F = floor rounded up to a step.
  const unit = Math.max(1, Math.round(step));
  const T = Math.round(target / unit);
  const F = Math.max(1, Math.ceil(floor / unit));
  const roundedTarget = T * unit;

  // Floor alone meets or exceeds the target — can't spread below it. Floor wins.
  if (activeCount * F >= T) {
    return { alloc: weights.map((w) => (w > 0 ? F * unit : 0)), infeasible: true, target: roundedTarget };
  }

  // Largest-remainder proportional allocation that sums exactly to T (in steps).
  const ideal = weights.map((w) => (w > 0 ? (w / W) * T : 0));
  const alloc = ideal.map(Math.floor);
  const remainder = T - alloc.reduce((s, x) => s + x, 0);
  const byFrac = ideal
    .map((v, i) => ({ frac: v - Math.floor(v), w: weights[i], i }))
    .filter((o) => o.w > 0)
    .sort((a, b) => b.frac - a.frac || b.w - a.w);
  for (let k = 0; k < remainder; k++) alloc[byFrac[k % byFrac.length].i] += 1;

  // Enforce the floor: bump each sub-floor active line up to the floor and
  // reclaim the deficit from the largest above-floor lines, one step at a time.
  for (;;) {
    const bump = alloc.findIndex((q, i) => active[i] && q < F);
    if (bump === -1) break;
    let deficit = F - alloc[bump];
    alloc[bump] = F;
    while (deficit > 0) {
      let idx = -1;
      let max = F;
      for (let i = 0; i < n; i++) {
        if (i !== bump && alloc[i] > max) {
          max = alloc[i];
          idx = i;
        }
      }
      if (idx === -1) break; // unreachable given the feasibility guard above
      alloc[idx] -= 1;
      deficit -= 1;
    }
  }

  return { alloc: alloc.map((x) => x * unit), infeasible: false, target: roundedTarget };
}

/**
 * Split an override key into its style and optional color parts. A "/" qualifies
 * the style with a color code, so the founder can override a whole style ("naomi")
 * or a single color within it ("naomi/BLK", "AJ/SND").
 */
function parseStyleKey(key) {
  const raw = String(key || '').trim();
  const slash = raw.indexOf('/');
  if (slash === -1) return { style: raw, color: null };
  return { style: raw.slice(0, slash).trim(), color: raw.slice(slash + 1).trim() || null };
}

/**
 * Does a projection row belong to the style (and optional color) named by `key`?
 * The style matches either the SKU prefix exactly (e.g. "GAF") or a substring of
 * the product name (e.g. "naomi"); a "/COLOR" suffix further restricts to rows of
 * that color code (e.g. "naomi/BLK"). All matching is case-insensitive.
 */
function matchesStyle(row, key) {
  const { style, color } = parseStyleKey(key);
  const s = style.toLowerCase();
  if (!s) return false;
  const prefix = String(row.sku || '').split('-')[0].toLowerCase();
  const styleMatch = prefix === s || String(row.product_name || '').toLowerCase().includes(s);
  if (!styleMatch) return false;
  if (color) return String(row.color || '').toLowerCase() === color.toLowerCase();
  return true;
}

/**
 * Apply the ordering rules to projection rows ahead of drafting.
 *   - Overridden styles: rescale the style's spread to the requested total.
 *   - Everything else: floor each line up to the per-SKU minimum.
 * Returns new rows (originals untouched) plus human-readable warnings.
 *
 * @param {Array<{sku,product_name,color,size,qty_to_order}>} rows
 * @param {{ overrides?: Record<string, number>, floor?: number }} opts
 * @returns {{ rows: Array, warnings: string[] }}
 */
function applyOrderRules(rows, { overrides = {}, floor = PER_SKU_FLOOR } = {}) {
  const warnings = [];
  const overrideKeys = Object.keys(overrides || {});
  const matched = new Set();
  const out = rows.map((r) => ({ ...r }));

  // Check color-qualified keys first so a row prefers its specific color override
  // ("naomi/BLK") over a whole-style one ("naomi") when both are supplied.
  const orderedKeys = [...overrideKeys].sort(
    (a, b) => (parseStyleKey(b).color ? 1 : 0) - (parseStyleKey(a).color ? 1 : 0),
  );

  // Partition: overridden style groups vs. everything else (floored in place).
  const groups = new Map(); // key -> [row refs in `out`]
  for (const r of out) {
    const key = orderedKeys.find((k) => matchesStyle(r, k));
    if (key) {
      matched.add(key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    } else {
      r.qty_to_order = r.qty_to_order > 0 ? Math.max(r.qty_to_order, floor) : 0;
    }
  }

  // Rescale each overridden style to its target total.
  for (const [key, group] of groups) {
    const target = Math.round(Number(overrides[key]));
    if (!Number.isFinite(target) || target <= 0) {
      warnings.push(`Override "${key}": "${overrides[key]}" is not a positive number — skipped.`);
      group.forEach((r) => { r.qty_to_order = r.qty_to_order > 0 ? Math.max(r.qty_to_order, floor) : 0; });
      continue;
    }
    const { alloc, infeasible, target: usedTarget } = distributeWithFloor(group.map((r) => r.qty_to_order), target, floor, ORDER_STEP);
    group.forEach((r, i) => { r.qty_to_order = alloc[i]; });
    const got = alloc.reduce((s, x) => s + x, 0);
    if (infeasible) {
      warnings.push(`Override "${key}": target ${target} is below the ${floor}-unit floor across ${group.length} sizes — ordered ${got} (every size at the ${floor} floor).`);
    } else if (usedTarget !== target) {
      warnings.push(`Override "${key}": rounded ${target} to ${usedTarget} (sizes kept in multiples of ${ORDER_STEP}); distributed ${got}.`);
    } else if (got !== usedTarget) {
      warnings.push(`Override "${key}": distributed ${got} units vs requested ${target}.`);
    }
  }

  for (const key of overrideKeys) {
    if (!matched.has(key)) {
      warnings.push(`Override "${key}": no projection rows matched for this supplier — skipped. (A brand-new style with no projection needs the launch-quantity + analog-spread path, which is not built yet.)`);
    }
  }

  return { rows: out, warnings };
}

module.exports = { PER_SKU_FLOOR, ORDER_STEP, distributeWithFloor, matchesStyle, parseStyleKey, applyOrderRules };
