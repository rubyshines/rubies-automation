/**
 * Production-order pricing estimate. For each order line, look up the CURRENT
 * cost for its SKU prefix in `product_costs` (latest effective_date) and compute
 * the extended landed cost, broken into goods (COGS), shipping (freight), and
 * taxes (duties). These are our stored per-unit numbers — no external assumptions.
 *
 * computePricing is pure (costMap injected) so the math is unit-tested; the sheet
 * write lives in productionOrderLoop.js alongside the order-tab writer.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const skuPrefix = (sku) => String(sku || '').split('-')[0].toUpperCase();

// Map of SKU prefix -> current cost row (latest effective_date wins).
async function fetchCurrentCosts() {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('product_costs')
    .select('sku_prefix, unit_cost, freight, duties_amount, duties_rate, total_landed_cost, effective_date')
    .order('effective_date', { ascending: false });
  if (error) throw new Error(`fetchCurrentCosts: ${error.message}`);
  const map = new Map();
  for (const r of (data || [])) {
    const p = String(r.sku_prefix || '').toUpperCase();
    if (p && !map.has(p)) map.set(p, r); // first seen = latest effective_date
  }
  return map;
}

/**
 * @param {Array<{sku,qty,product_name,color}>} items
 * @param {Map<string,object>} costMap  prefix -> cost row
 * @returns {{ groups:Array, grand:object, missing:string[] }}
 */
function computePricing(items, costMap) {
  const groups = new Map();
  const missing = new Set();

  for (const it of (items || [])) {
    const prefix = skuPrefix(it.sku);
    const c = costMap.get(prefix);
    if (!c) missing.add(prefix);
    const u = c || { unit_cost: 0, freight: 0, duties_amount: 0, total_landed_cost: 0 };
    const qty = Number(it.qty) || 0;
    const line = {
      sku: it.sku,
      qty,
      // per-unit cost components (what's used in the calc)
      unit_cogs: u.unit_cost || 0,
      unit_freight: u.freight || 0,
      unit_duty: u.duties_amount || 0,
      unit_landed: u.total_landed_cost || 0,
      // extended (qty x unit)
      cogs: round2(qty * (u.unit_cost || 0)),
      freight: round2(qty * (u.freight || 0)),
      duty: round2(qty * (u.duties_amount || 0)),
      landed: round2(qty * (u.total_landed_cost || 0)),
      costKnown: !!c,
    };
    const key = `${it.product_name}|||${it.color || ''}`;
    if (!groups.has(key)) groups.set(key, { product_name: it.product_name, color: it.color || '', lines: [] });
    groups.get(key).lines.push(line);
  }

  const groupArr = [...groups.values()].sort((a, b) => {
    const pa = skuPrefix(a.lines[0]?.sku), pb = skuPrefix(b.lines[0]?.sku);
    return pa !== pb ? pa.localeCompare(pb) : (a.color || '').localeCompare(b.color || '');
  });

  const grand = { qty: 0, cogs: 0, freight: 0, duty: 0, landed: 0 };
  for (const g of groupArr) {
    for (const l of g.lines) {
      grand.qty += l.qty; grand.cogs += l.cogs; grand.freight += l.freight;
      grand.duty += l.duty; grand.landed += l.landed;
    }
  }
  for (const k of ['cogs', 'freight', 'duty', 'landed']) grand[k] = round2(grand[k]);

  return { groups: groupArr, grand, missing: [...missing] };
}

module.exports = { fetchCurrentCosts, computePricing, skuPrefix, round2 };
