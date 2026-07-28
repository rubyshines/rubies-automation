/**
 * Keep product_cs_config.status in lockstep with the Shopify product status.
 *
 * The advisor only knows products whose config row is 'active' (the
 * get_cs_product_config RPC filters on it), but create_product seeds the row
 * as 'draft' and nothing in the launch flow flipped it — so a newly launched
 * product stayed invisible to the advisor until someone edited the row by
 * hand (the Evey sports bra launch, 2026-07). This reconcile makes the row
 * derive from the product mirror: ACTIVE product → 'active' config; DRAFT or
 * missing product → 'draft' config.
 *
 * Called from the daily product sync, the products webhook, and the
 * reload_products tool. Callers with a live advisor in-process should re-run
 * sizingEngine.initCsConfig() when this reports changes.
 */

const { fetchAllPaginated } = require('../../shared/supabaseClient');

/**
 * Pure diff: which config rows need their status changed to mirror the
 * product catalog. products: [{handle, status}], configRows: [{product_handle, status}].
 */
function computeCsConfigStatusChanges(products, configRows) {
  const productStatus = new Map(products.map(p => [p.handle, p.status]));
  const changes = [];
  for (const row of configRows) {
    const desired = productStatus.get(row.product_handle) === 'ACTIVE' ? 'active' : 'draft';
    if (row.status !== desired) {
      changes.push({ product_handle: row.product_handle, status: desired });
    }
  }
  return changes;
}

async function syncCsConfigStatus(supabase) {
  const products = await fetchAllPaginated(() => supabase
    .from('products')
    .select('handle, status')
    .order('handle'));
  const configRows = await fetchAllPaginated(() => supabase
    .from('product_cs_config')
    .select('product_handle, status')
    .order('product_handle'));

  const changes = computeCsConfigStatusChanges(products || [], configRows || []);
  for (const change of changes) {
    const { error } = await supabase
      .from('product_cs_config')
      .update({ status: change.status, updated_at: new Date().toISOString() })
      .eq('product_handle', change.product_handle);
    if (error) throw new Error(`CS config status sync failed for ${change.product_handle}: ${error.message}`);
  }
  return changes;
}

module.exports = { syncCsConfigStatus, computeCsConfigStatusChanges };
