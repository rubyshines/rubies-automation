/**
 * RUBIES Product Catalog Sync — Shopify → Supabase
 *
 * Fetches all products + variants from Shopify, upserts to Supabase,
 * and removes stale products that no longer exist in Shopify.
 * Detects price changes and logs them to price_history.
 *
 * Usage:
 *   node customer-service/sync/syncProducts.js
 *   npm run cs-sync-products
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { fetchAllProducts } = require('../lib/shopify');
const { getSupabaseClient } = require('../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') return [val];
  return [];
}

function extractRichText(val) {
  if (!val) return null;
  try {
    const rt = typeof val === 'string' ? JSON.parse(val) : val;
    if (rt.type === 'root' && rt.children) {
      return rt.children
        .map(c => (c.children || []).map(t => t.value || '').join(''))
        .filter(Boolean)
        .join(' | ');
    }
  } catch { /* not rich text */ }
  return typeof val === 'string' ? val : null;
}

function mapMetafields(metafields) {
  return {
    // Live Shopify keys are product_collection / product_category / product_age
    // (the older collections/categories/age_groups keys no longer exist, which
    // left these columns empty for every product). Column names kept as-is.
    collections: toArray(metafields.product_collection),
    categories: toArray(metafields.product_category),
    age_groups: toArray(metafields.product_age),
    kid_sizes: toArray(metafields.kid_sizes),
    adult_sizes: toArray(metafields.adult_sizes),
    kid_colors: toArray(metafields.kid_colors),
    adult_colors: toArray(metafields.adult_colors),
    bundle_product_1: metafields.bundle_product_1 || null,
    bundle_product_2: metafields.bundle_product_2 || null,
    labels: toArray(metafields.labels),
    discount_percent: metafields.discount_percent != null
      ? parseFloat(metafields.discount_percent)
      : null,
    fit_description: metafields.fit_description || null,
    best_for: metafields.best_for || null,
    comparison_notes: metafields.comparison_notes || null,
    materials_composition: extractRichText(metafields.materials_composition),
  };
}

// ---------------------------------------------------------------------------
// Price change detection
// ---------------------------------------------------------------------------

async function detectPriceChanges(supabase, newVariants) {
  // Fetch current prices from Supabase
  const { data: existing, error } = await supabase
    .from('product_variants')
    .select('shopify_variant_id, price, title, sku, shopify_product_id');
  if (error) throw error;
  if (!existing || !existing.length) return 0;

  const oldPrices = new Map();
  for (const v of existing) {
    oldPrices.set(v.shopify_variant_id, v);
  }

  // We need product titles for the log
  const { data: products } = await supabase
    .from('products')
    .select('shopify_product_id, title');
  const productTitles = new Map((products || []).map(p => [p.shopify_product_id, p.title]));

  const changes = [];
  for (const v of newVariants) {
    const old = oldPrices.get(v.shopify_variant_id);
    if (!old) continue;
    const oldPrice = parseFloat(old.price);
    const newPrice = parseFloat(v.price);
    if (oldPrice !== newPrice) {
      changes.push({
        variant_id: v.shopify_variant_id,
        sku: v.sku || null,
        product_title: productTitles.get(v.shopify_product_id) || v.title,
        variant_title: v.title,
        price: newPrice,
        previous_price: oldPrice,
      });
    }
  }

  if (!changes.length) return 0;

  console.log(`  Detected ${changes.length} price change(s), logging to price_history...`);
  const { error: insertError } = await supabase.from('price_history').insert(changes);
  if (insertError) throw insertError;
  return changes.length;
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Products Sync — starting');
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  // 1. Fetch all products from Shopify
  const allProducts = [];
  let cursor = null;
  while (true) {
    const { products, pageInfo } = await fetchAllProducts(cursor);
    allProducts.push(...products);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  // Sync ACTIVE and DRAFT products (exclude only ARCHIVED). Drafts are not on the
  // storefront but must be visible to internal tools while a new product is built.
  // Customer-facing surfaces (productCache, inventory projections, snapshots) filter
  // to status='ACTIVE' themselves, so drafts never reach customers.
  const activeProducts = allProducts.filter(p => p.status !== 'ARCHIVED');
  console.log(`  Fetched ${activeProducts.length} products from Shopify (active + draft)`);

  // 2. Build product rows
  const productRows = activeProducts.map(p => {
    const mf = mapMetafields(p.metafields || {});
    return {
      shopify_product_id: p.id,
      title: p.title,
      handle: p.handle,
      status: p.status,
      product_type: p.productType || null,
      vendor: p.vendor || null,
      description_html: p.descriptionHtml || null,
      tags: p.tags || [],
      seo_title: p.seo?.title || null,
      seo_description: p.seo?.description || null,
      ...mf,
      synced_at: now,
    };
  });

  // 3. Build variant rows
  const variantRows = [];
  for (const p of activeProducts) {
    for (const v of p.variants) {
      const vmf = v.metafields || {};
      const incoming = vmf.pre_order_incoming_us;
      variantRows.push({
        shopify_variant_id: v.id,
        shopify_product_id: p.id,
        shopify_inventory_item_id: v.inventoryItem?.id || null,
        title: v.title,
        sku: v.sku || null,
        price: parseFloat(v.price) || 0,
        inventory_quantity: v.inventoryQuantity ?? 0,
        selected_options: v.selectedOptions || [],
        pre_order_incoming: incoming != null ? parseInt(incoming, 10) : null,
        pre_order_date: vmf.pre_order_date_us || null,
        synced_at: now,
      });
    }
  }

  // 4. Detect price changes BEFORE upserting
  let priceChanges = 0;
  try {
    priceChanges = await detectPriceChanges(supabase, variantRows);
  } catch (err) {
    console.error(`  Price change detection failed: ${err.message}`);
  }

  // 5. Upsert products
  const BATCH = 50;
  for (let i = 0; i < productRows.length; i += BATCH) {
    const batch = productRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('products')
      .upsert(batch, { onConflict: 'shopify_product_id' });
    if (error) throw new Error(`Products upsert failed: ${error.message}`);
  }
  console.log(`  Upserted ${productRows.length} products`);

  // 6. Upsert variants (in batches)
  for (let i = 0; i < variantRows.length; i += BATCH) {
    const batch = variantRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('product_variants')
      .upsert(batch, { onConflict: 'shopify_variant_id' });
    if (error) throw new Error(`Variants upsert failed: ${error.message}`);
  }
  console.log(`  Upserted ${variantRows.length} variants`);

  // 6b. Remove orphan variants — rows for a SURVIVING product whose variant no
  // longer exists in Shopify (variants deleted/recreated on a live product).
  // Stale-product cleanup below only catches whole-product deletions; without
  // this pass, deleted variants linger in the mirror with stale variant ids
  // (observed: the Evey sports bra trimmed from 45 speculative variants to 9 —
  // the 36 leftovers made pre-order clears fail forever). Narrow per-product
  // NOT-IN delete, concurrency-safe alongside the upsert above.
  {
    const liveByProduct = new Map();
    for (const r of variantRows) {
      if (!liveByProduct.has(r.shopify_product_id)) liveByProduct.set(r.shopify_product_id, []);
      liveByProduct.get(r.shopify_product_id).push(r.shopify_variant_id);
    }
    let orphansRemoved = 0;
    for (const [productId, variantIds] of liveByProduct) {
      const { data: removed, error } = await supabase
        .from('product_variants')
        .delete()
        .eq('shopify_product_id', productId)
        .not('shopify_variant_id', 'in', `(${variantIds.map((id) => `"${id}"`).join(',')})`)
        .select('sku');
      if (error) throw new Error(`Orphan variant cleanup failed for ${productId}: ${error.message}`);
      if (removed && removed.length) {
        orphansRemoved += removed.length;
        console.log(`  Removed ${removed.length} orphan variant(s) of ${productId}: ${removed.map((r) => r.sku).join(', ')}`);
      }
    }
    if (!orphansRemoved) console.log('  No orphan variants');
  }

  // 7. Delete stale products (CASCADE removes their variants)
  const activeIds = new Set(activeProducts.map(p => p.id));
  const { data: existingProducts } = await supabase
    .from('products')
    .select('shopify_product_id');
  const staleIds = (existingProducts || [])
    .map(p => p.shopify_product_id)
    .filter(id => !activeIds.has(id));

  if (staleIds.length) {
    const { error } = await supabase
      .from('products')
      .delete()
      .in('shopify_product_id', staleIds);
    if (error) console.error(`  Stale product cleanup failed: ${error.message}`);
    else console.log(`  Removed ${staleIds.length} stale product(s)`);
  }

  if (priceChanges) console.log(`  Logged ${priceChanges} price change(s)`);
  console.log('RUBIES Products Sync — done');

  return {
    sources: {
      products: { success: true, rowsWritten: productRows.length, error: null },
      variants: { success: true, rowsWritten: variantRows.length, error: null },
    },
    status: 'success',
  };
}

module.exports = { run };

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (require.main === module) {
  run().catch(err => {
    console.error('RUBIES Products Sync — FAILED:', err.message);
    process.exit(1);
  });
}
