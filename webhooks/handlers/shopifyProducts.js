/**
 * Shopify products/create + products/update webhook handler
 *
 * Upserts product + variants to Supabase.
 * REST webhooks don't include metafields, so we fetch the full product
 * via GraphQL after receiving the webhook to get metafield data.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { normalizeProductRow, normalizeVariantRow, toGid } = require('../lib/normalize');

async function handle(topic, payload) {
  const supabase = getSupabaseClient();

  // Sync ACTIVE and DRAFT (drafts must be visible to internal tools while a new
  // product is built; customer-facing surfaces filter to ACTIVE themselves).
  // ARCHIVED products are removed from the cache, matching the batch sync cleanup.
  if (payload.status && payload.status.toLowerCase() === 'archived') {
    console.log(`[shopify-products] Removing archived product: ${payload.title}`);
    await supabase.from('products').delete().eq('shopify_product_id', toGid('Product', payload.id));
    return;
  }

  console.log(`[shopify-products] ${topic} "${payload.title}" (${payload.variants?.length || 0} variants)`);

  // Build product row from REST payload (without metafields)
  const productRow = normalizeProductRow(payload);

  // Try to fetch full product via GraphQL for metafields
  try {
    const { fetchProductById } = require('../../customer-service/lib/shopify');
    if (fetchProductById) {
      const fullProduct = await fetchProductById(payload.id);
      if (fullProduct?.metafields) {
        // Merge metafields into product row
        const { mapMetafields } = require('./productMetafields');
        Object.assign(productRow, mapMetafields(fullProduct.metafields));
      }
    }
  } catch (err) {
    // fetchProductById may not exist yet — fall back to REST-only data
    console.warn(`[shopify-products] Could not fetch metafields for "${payload.title}": ${err.message}`);
  }

  // Upsert product
  const { error: prodErr } = await supabase
    .from('products')
    .upsert(productRow, { onConflict: 'shopify_product_id' });

  if (prodErr) {
    throw new Error(`Product upsert failed: ${prodErr.message}`);
  }

  // Upsert variants
  const variantRows = (payload.variants || []).map(v => normalizeVariantRow(v, payload.id));

  if (variantRows.length > 0) {
    const { error: varErr } = await supabase
      .from('product_variants')
      .upsert(variantRows, { onConflict: 'shopify_variant_id' });

    if (varErr) {
      throw new Error(`Variants upsert failed: ${varErr.message}`);
    }
  }

  console.log(`[shopify-products] Upserted "${payload.title}" with ${variantRows.length} variants`);

  // Mirror product status onto product_cs_config (launch flips a product
  // ACTIVE here first), then refresh this process's advisor config maps.
  try {
    const { syncCsConfigStatus } = require('../../customer-service/lib/csConfigStatus');
    const changes = await syncCsConfigStatus(supabase);
    if (changes.length) {
      console.log(`[shopify-products] CS config status updated: ${changes.map(c => `${c.product_handle}→${c.status}`).join(', ')}`);
      const { initCsConfig } = require('../../customer-service/lib/sizingEngine');
      await initCsConfig();
    }
  } catch (err) {
    console.warn(`[shopify-products] CS config status sync failed: ${err.message}`);
  }
}

module.exports = { handle };
