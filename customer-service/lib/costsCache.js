/**
 * In-memory COGS cache.
 * Lazy-loads from Supabase on first access, stays in memory for server lifetime.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

let costsMap = null; // Map<sku_prefix, cost row>

async function loadCosts() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('get_current_costs');
  if (error) throw new Error(`Failed to load costs: ${error.message}`);

  costsMap = new Map();
  for (const row of (data || [])) {
    costsMap.set(row.sku_prefix.toUpperCase(), row);
  }
  console.error(`[CostsCache] Loaded ${costsMap.size} cost entries`);
}

async function ensureLoaded() {
  if (!costsMap) await loadCosts();
}

/**
 * Get COGS for a full SKU like "AJ-12-BLK" → looks up prefix "AJ"
 */
async function getCostForSku(fullSku) {
  await ensureLoaded();
  if (!fullSku) return null;
  const prefix = fullSku.split('-')[0].toUpperCase();
  return costsMap.get(prefix) || null;
}

/**
 * Get COGS by SKU prefix directly (e.g. "AJ", "UNW")
 */
async function getCostByPrefix(prefix) {
  await ensureLoaded();
  if (!prefix) return null;
  return costsMap.get(prefix.toUpperCase()) || null;
}

async function getAllCosts() {
  await ensureLoaded();
  return Array.from(costsMap.values());
}

/**
 * Clear and reload the costs cache from Supabase.
 */
async function refreshCosts() {
  costsMap = null;
  await loadCosts();
  return costsMap.size;
}

module.exports = { loadCosts, getCostForSku, getCostByPrefix, getAllCosts, refreshCosts };
