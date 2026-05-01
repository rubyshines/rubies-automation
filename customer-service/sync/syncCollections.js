/**
 * RUBIES Collections Sync — Shopify → Supabase
 *
 * Fetches all collections (manual + smart) from Shopify, upserts to Supabase,
 * and removes stale collections that no longer exist in Shopify.
 *
 * Usage:
 *   node customer-service/sync/syncCollections.js
 *   npm run cs-sync-collections
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { fetchAllCollections } = require('../lib/shopify');
const { getSupabaseClient } = require('../../shared/supabaseClient');

async function run() {
  console.log('RUBIES Collections Sync — starting');
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  // 1. Fetch all collections from Shopify
  const all = [];
  let cursor = null;
  while (true) {
    const { collections, pageInfo } = await fetchAllCollections(cursor);
    all.push(...collections);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  console.log(`  Fetched ${all.length} collections from Shopify`);

  // 2. Build rows
  const rows = all.map(c => ({
    shopify_collection_id: c.id,
    handle: c.handle,
    title: c.title,
    description_html: c.descriptionHtml,
    seo_title: c.seo?.title || null,
    seo_description: c.seo?.description || null,
    is_smart: !!c.ruleSet,
    rule_set: c.ruleSet || null,
    product_handles: c.productHandles || [],
    products_count: c.productsCount,
    synced_at: now,
  }));

  // 3. Upsert in batches
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('collections')
      .upsert(batch, { onConflict: 'shopify_collection_id' });
    if (error) throw new Error(`Collections upsert failed: ${error.message}`);
  }
  console.log(`  Upserted ${rows.length} collections`);

  // 4. Delete stale
  const activeIds = new Set(all.map(c => c.id));
  const { data: existing } = await supabase
    .from('collections')
    .select('shopify_collection_id');
  const staleIds = (existing || [])
    .map(c => c.shopify_collection_id)
    .filter(id => !activeIds.has(id));
  if (staleIds.length) {
    const { error } = await supabase
      .from('collections')
      .delete()
      .in('shopify_collection_id', staleIds);
    if (error) console.error(`  Stale collection cleanup failed: ${error.message}`);
    else console.log(`  Removed ${staleIds.length} stale collection(s)`);
  }

  console.log('RUBIES Collections Sync — done');
  return {
    sources: {
      collections: { success: true, rowsWritten: rows.length, error: null },
    },
    status: 'success',
  };
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('RUBIES Collections Sync — FAILED:', err.message);
    process.exit(1);
  });
}
