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

module.exports = {
  shouldExcludeSku,
  getSupplierBySku,
  getSupplierByName,
  getAllSupplierNames,
  clearCache,
  EXCLUDED_PREFIXES,
};
