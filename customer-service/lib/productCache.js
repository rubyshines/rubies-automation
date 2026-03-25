/**
 * Product catalog cache with fuzzy matching.
 * Loads from Supabase on startup (synced by syncProducts.js).
 * Reload on demand via reload_products tool.
 */

const { fetchAllProducts } = require('./shopify');
const { getSupabaseClient } = require('../../shared/supabaseClient');

let cachedProducts = [];

let cacheTimestamp = null;

/**
 * Load products + variants from Supabase and reshape into the same
 * in-memory format that the rest of the codebase expects.
 */
async function loadFromSupabase() {
  try {
    const supabase = getSupabaseClient();

    const { data: products, error: pErr } = await supabase
      .from('products')
      .select('*')
      .eq('status', 'ACTIVE');
    if (pErr) throw pErr;
    if (!products || !products.length) return false;

    const { data: variants, error: vErr } = await supabase
      .from('product_variants')
      .select('*');
    if (vErr) throw vErr;

    // Group variants by product
    const variantsByProduct = new Map();
    for (const v of (variants || [])) {
      if (!variantsByProduct.has(v.shopify_product_id)) {
        variantsByProduct.set(v.shopify_product_id, []);
      }
      variantsByProduct.get(v.shopify_product_id).push({
        id: v.shopify_variant_id,
        title: v.title,
        sku: v.sku,
        price: String(v.price),
        inventoryQuantity: v.inventory_quantity,
        selectedOptions: v.selected_options || [],
      });
    }

    cachedProducts = products.map(p => ({
      id: p.shopify_product_id,
      title: p.title,
      handle: p.handle,
      status: p.status,
      productType: p.product_type,
      vendor: p.vendor,
      descriptionHtml: p.description_html,
      tags: p.tags || [],
      metafields: {
        collections: p.collections || [],
        categories: p.categories || [],
        age_groups: p.age_groups || [],
        kid_sizes: p.kid_sizes || [],
        adult_sizes: p.adult_sizes || [],
        kid_colors: p.kid_colors || [],
        adult_colors: p.adult_colors || [],
        bundle_product_1: p.bundle_product_1,
        bundle_product_2: p.bundle_product_2,
        labels: p.labels || [],
        discount_percent: p.discount_percent,
      },
      variants: variantsByProduct.get(p.shopify_product_id) || [],
    }));

    cacheTimestamp = products[0]?.synced_at ? new Date(products[0].synced_at) : new Date();
    console.error(`[ProductCache] Loaded ${cachedProducts.length} products from Supabase (synced ${cacheTimestamp.toISOString()})`);
    return true;
  } catch (err) {
    console.error(`[ProductCache] Failed to load from Supabase: ${err.message}`);
    return false;
  }
}

/**
 * Fetch from Shopify, sync to Supabase, then reload cache from Supabase.
 */
async function loadProducts() {
  // Sync to Supabase via the sync script
  const { run: syncProducts } = require('../sync/syncProducts');
  await syncProducts();

  // Reload from Supabase
  await loadFromSupabase();
}

// No-op kept for compatibility but no longer called automatically
function startRefresh() {}

function getProducts() {
  return cachedProducts;
}

/**
 * Size normalization for wholesale and search.
 *
 * RUBIES uses two sizing systems:
 *   - "Youth Size" (numeric): 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16
 *     Used by AJ, Charlie, Brooke, Ruby bikini bottoms
 *   - "Size" (letter): XXS, XXS+, XS, XS+, S, M, L, 1X, 2X, 3X, 4X
 *     Used by Ava, Cheeky, Sassy, and newer products
 *
 * Products with numeric sizing ALSO have letter sizes (XS–4X).
 * Products with letter-only sizing do NOT have numeric sizes,
 * so numeric input must be converted: 10→XXS, 11→XXS+, 12→XS, 13→XS+, 14→S, 16→M
 */
const SIZE_ALIASES = {
  'xl': '1x', 'xxl': '2x', '3xl': '3x', '4xl': '4x', '5xl': '5x',
};

const NUMERIC_TO_LETTER = {
  '10': 'xxs', '11': 'xxs+', '12': 'xs', '13': 'xs+', '14': 's', '16': 'm',
};

const KNOWN_SIZES = new Set([
  '4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16',
  'xxs', 'xxs+', 'xs', 'xs+', 's', 'm', 'l', '1x', '2x', '3x', '4x', '5x',
  'xl', 'xxl', '3xl', '4xl', '5xl',
]);

function normalizeSize(s) {
  const lower = s.toLowerCase().trim();
  return SIZE_ALIASES[lower] || lower;
}

function getVariantSize(variant) {
  const sizeOpt = (variant.selectedOptions || []).find(o =>
    o.name.toLowerCase().includes('size')
  );
  return sizeOpt ? sizeOpt.value.toLowerCase().trim() : null;
}

/**
 * Fuzzy search products and variants by query string.
 * Tokenizes query and scores against product title, variant title, SKU, and tags.
 * Size tokens are matched exactly against variant size options, with automatic
 * normalization (XL→1X, XXL→2X, etc.) and numeric-to-letter fallback for
 * products that only use letter sizing.
 */
function searchProducts(query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // Separate size tokens from descriptive tokens
  const sizeTokens = [];
  const otherTokens = [];
  for (const token of tokens) {
    if (KNOWN_SIZES.has(token)) {
      sizeTokens.push(normalizeSize(token));
    } else {
      otherTokens.push(token);
    }
  }

  // Merge "tall" modifier into size tokens so "L Tall" matches variant size "l tall"
  // instead of matching "L" (non-tall) as size and "tall" as a descriptive word
  const tallIdx = otherTokens.indexOf('tall');
  if (tallIdx !== -1 && sizeTokens.length > 0) {
    otherTokens.splice(tallIdx, 1);
    for (let i = 0; i < sizeTokens.length; i++) {
      sizeTokens[i] = sizeTokens[i] + ' tall';
    }
  }

  const results = [];

  for (const product of cachedProducts) {
    const productText = normalize(product.title);
    const productTags = (product.tags || []).map(t => normalize(t)).join(' ');

    // Check if this product uses numeric sizing (has any variant with a pure numeric size)
    const usesNumericSizing = product.variants.some(v => {
      const sz = getVariantSize(v);
      return sz && /^\d+$/.test(sz);
    });

    for (const variant of product.variants) {
      const variantText = normalize(variant.title);
      const skuText = normalize(variant.sku || '');
      const searchableText = `${productText} ${variantText} ${skuText} ${productTags}`;
      const variantSize = getVariantSize(variant);

      let score = 0;
      let matched = 0;

      // Score descriptive tokens (product name, color, etc.)
      for (const token of otherTokens) {
        if (searchableText.includes(token)) {
          matched++;
          score += 10;
          // Bonus for exact word match
          if (searchableText.split(/\s+/).includes(token)) score += 5;
          // Bonus for SKU match
          if (skuText.includes(token)) score += 10;
        } else {
          // Partial match (token is substring of a word)
          const words = searchableText.split(/\s+/);
          const partial = words.some(w => w.includes(token) || token.includes(w));
          if (partial) {
            matched++;
            score += 3;
          }
        }
      }

      // Size matching — exact only, with normalization
      if (sizeTokens.length > 0 && variantSize) {
        let sizeMatched = false;
        for (const sizeToken of sizeTokens) {
          // Direct match (e.g., "l" matches "l", "10" matches "10", "1x" matches "1x")
          if (variantSize === sizeToken) {
            sizeMatched = true;
            break;
          }
          // Numeric-to-letter fallback for products without numeric sizing
          // e.g., Ava/Cheeky: query "10" → try "xxs" against variant size
          if (/^\d+$/.test(sizeToken) && !usesNumericSizing && NUMERIC_TO_LETTER[sizeToken]) {
            if (variantSize === NUMERIC_TO_LETTER[sizeToken]) {
              sizeMatched = true;
              break;
            }
          }
        }

        if (sizeMatched) {
          matched++;
          score += 50; // Strong bonus for exact size match
        } else {
          score = -1; // Eliminate variants with wrong size
        }
      }

      const totalTokens = otherTokens.length + sizeTokens.length;
      if (matched >= Math.ceil(totalTokens / 2) && score > 0) {
        // Bonus for matching more tokens
        score += (matched / totalTokens) * 10;

        results.push({
          productId: product.id,
          productTitle: product.title,
          variantId: variant.id,
          variantTitle: variant.title,
          sku: variant.sku,
          price: variant.price,
          inventoryQuantity: variant.inventoryQuantity,
          options: variant.selectedOptions,
          collections: product.metafields?.collections || [],
          categories: product.metafields?.categories || [],
          ageGroups: product.metafields?.age_groups || [],
          score,
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

function tokenize(str) {
  return normalize(str).split(/[\s,/\-_]+/).filter(Boolean);
}

function normalize(str) {
  return String(str || '').toLowerCase().trim();
}

function getVariantById(variantGid) {
  for (const product of cachedProducts) {
    for (const variant of product.variants) {
      if (variant.id === variantGid) {
        return {
          productTitle: product.title,
          variantTitle: variant.title,
          variantId: variant.id,
          sku: variant.sku,
          price: variant.price,
        };
      }
    }
  }
  return null;
}

function getCacheAgeHours() {
  if (!cacheTimestamp) return Infinity;
  return (Date.now() - new Date(cacheTimestamp).getTime()) / (1000 * 60 * 60);
}

module.exports = { loadFromSupabase, loadProducts, startRefresh, getProducts, searchProducts, getVariantById, getCacheAgeHours };
