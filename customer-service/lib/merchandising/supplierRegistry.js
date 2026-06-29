/**
 * Supplier registry for inventory projections and production orders.
 * Loads from the `suppliers` Supabase table and caches in memory.
 *
 * Mapping rule: a SKU goes to whichever supplier lists its prefix in
 * `sku_prefixes` (data-driven — e.g. RHW → Pigeons and Thread, SB → Queenas).
 * Anything no specific supplier claims falls to the Kali catch-all.
 * Exclusions: TADLT (tee, not ordering), RJL (old stock, never reordering).
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const EXCLUDED_PREFIXES = ['TADLT', 'RJL'];
const CATCHALL_SUPPLIER = 'Kali';

let _cache = null;

async function loadSuppliers() {
  if (_cache) return _cache;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('suppliers').select('*');
  if (error) throw new Error(`Failed to load suppliers: ${error.message}`);
  _cache = data || [];
  return _cache;
}

function skuPrefix(sku) {
  return (sku || '').split('-')[0].toUpperCase();
}

function shouldExcludeSku(sku) {
  return EXCLUDED_PREFIXES.includes(skuPrefix(sku));
}

// Pure matcher: a supplier (other than the catch-all) that lists this SKU's
// prefix wins; otherwise the catch-all. Data-driven — adding a prefix to a
// supplier's `sku_prefixes` is all it takes for a new mapping to work.
function matchSupplier(suppliers, sku) {
  if (!sku) return null;
  const prefix = skuPrefix(sku);
  const specific = (suppliers || []).find(
    s => s.name !== CATCHALL_SUPPLIER && Array.isArray(s.sku_prefixes) && s.sku_prefixes.includes(prefix),
  );
  if (specific) return specific;
  return (suppliers || []).find(s => s.name === CATCHALL_SUPPLIER) || null;
}

async function getSupplierBySku(sku) {
  if (!sku) return null;
  const suppliers = await loadSuppliers();
  return matchSupplier(suppliers, sku);
}

async function getSupplierByName(name) {
  if (!name) return null;
  const suppliers = await loadSuppliers();
  return suppliers.find(s => s.name.toLowerCase() === name.toLowerCase()) || null;
}

async function getAllSupplierNames() {
  const suppliers = await loadSuppliers();
  return suppliers.map(s => s.name);
}

// Clear cache (useful for testing or after DB changes)
function clearCache() {
  _cache = null;
}

// Full vendor list (uncached read), ordered for display.
async function listSuppliers() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('suppliers').select('*').order('type').order('name');
  if (error) throw new Error(`listSuppliers: ${error.message}`);
  return data || [];
}

// Upsert a vendor by name: UPDATE the matching row, else INSERT. Returns the row.
// `patch` is any subset of supplier columns; `name` is required.
async function upsertSupplier(patch) {
  if (!patch || !patch.name) throw new Error('upsertSupplier: name is required');
  const supabase = getSupabaseClient();
  const existing = await getSupplierByName(patch.name);
  let row;
  if (existing) {
    const { data, error } = await supabase
      .from('suppliers').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw new Error(`upsertSupplier update: ${error.message}`);
    row = data;
  } else {
    const insert = { sku_prefixes: [], ...patch };
    const { data, error } = await supabase
      .from('suppliers').insert(insert).select('*').single();
    if (error) throw new Error(`upsertSupplier insert: ${error.message}`);
    row = data;
  }
  clearCache();
  return { row, created: !existing };
}

module.exports = {
  shouldExcludeSku,
  matchSupplier,
  getSupplierBySku,
  getSupplierByName,
  getAllSupplierNames,
  listSuppliers,
  upsertSupplier,
  clearCache,
  EXCLUDED_PREFIXES,
};
