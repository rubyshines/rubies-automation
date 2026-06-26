/**
 * Supplier registry for inventory projections and production orders.
 * Loads from the `suppliers` Supabase table and caches in memory.
 *
 * Catch-all rule: any SKU prefix not explicitly in Queenas/JustMax/Wumes → Kali.
 * Exclusions: TADLT (tee, not ordering), RJL (old stock, never reordering).
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const EXCLUDED_PREFIXES = ['TADLT', 'RJL'];
const CATCHALL_SUPPLIER = 'Kali';

// Specific-match suppliers (anything else falls to Kali catch-all)
const SPECIFIC_SUPPLIERS = ['Queenas', 'JustMax', 'Wumes'];

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

async function getSupplierBySku(sku) {
  if (!sku) return null;
  const prefix = skuPrefix(sku);
  const suppliers = await loadSuppliers();

  // Check specific-match suppliers first (Queenas, JustMax, Wumes)
  for (const supplier of suppliers) {
    if (SPECIFIC_SUPPLIERS.includes(supplier.name) && supplier.sku_prefixes.includes(prefix)) {
      return supplier;
    }
  }

  // Catch-all: Kali
  return suppliers.find(s => s.name === CATCHALL_SUPPLIER) || null;
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
  getSupplierBySku,
  getSupplierByName,
  getAllSupplierNames,
  listSuppliers,
  upsertSupplier,
  clearCache,
  EXCLUDED_PREFIXES,
};
