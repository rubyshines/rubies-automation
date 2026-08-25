/**
 * Product catalog cache with fuzzy matching.
 * Loads from Supabase on startup (synced by syncProducts.js).
 * Reload on demand via reload_products tool.
 */

const { fetchAllProducts } = require('./shopify');
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const {
  KNOWN_SIZES, NUMERIC_TO_LETTER, TALL_ALIASES,
  normalizeSizeLower,
  getVariantSize, getVariantColor,
} = require('./sizeUtils');

let cachedProducts = [];

let cacheTimestamp = null;

/**
 * Load products + variants from Supabase and reshape into the same
 * in-memory format that the rest of the codebase expects.
 */
async function loadFromSupabase() {
  try {
    const supabase = getSupabaseClient();

    // Paginate both — product_variants routinely exceeds Supabase's 1000-row
    // default (many products × sizes × colors), so an unpaginated select
    // silently dropped variants from the advisor's product cache.
    const products = await fetchAllPaginated(() => supabase
      .from('products')
      .select('*')
      .eq('status', 'ACTIVE')
      .order('shopify_product_id', { ascending: true }));
    if (!products.length) return false;

    const variants = await fetchAllPaginated(() => supabase
      .from('product_variants')
      .select('*')
      .order('shopify_variant_id', { ascending: true }));

    // Curated customer-facing short names, keyed by handle. This is the same
    // column getProductNickname reads, so the two cannot disagree. Loaded here
    // (rather than reached for via sizingEngine) so renderVariantForCustomer
    // stays synchronous and refreshes on the catalog's own cadence.
    //
    // Deliberately unfiltered by status: an archived product's nickname is
    // still its name, and order history references products long after they
    // stop being ACTIVE.
    const { data: csConfig } = await supabase
      .from('product_cs_config')
      .select('product_handle, nickname');
    const nicknameByHandle = new Map(
      (csConfig || []).filter(r => r.product_handle && r.nickname)
        .map(r => [r.product_handle, r.nickname]));

    // Group variants by product
    const variantsByProduct = new Map();
    for (const v of variants) {
      if (!variantsByProduct.has(v.shopify_product_id)) {
        variantsByProduct.set(v.shopify_product_id, []);
      }
      variantsByProduct.get(v.shopify_product_id).push({
        id: v.shopify_variant_id,
        title: v.title,
        sku: v.sku,
        price: String(v.price),
        inventoryQuantity: v.inventory_quantity,
        preOrderDate: v.pre_order_date,
        selectedOptions: v.selected_options || [],
      });
    }

    cachedProducts = products.map(p => ({
      id: p.shopify_product_id,
      title: p.title,
      handle: p.handle,
      nickname: nicknameByHandle.get(p.handle) || null,
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

// Size constants, normalizeSize, getVariantSize, getVariantColor — imported from sizeUtils.js

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
    if (KNOWN_SIZES.has(token) || TALL_ALIASES[token]) {
      sizeTokens.push(normalizeSizeLower(token));
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
          // Bonus for exact word match in product title (stronger signal than SKU substring)
          const titleWords = productText.split(/\s+/);
          if (titleWords.includes(token)) score += 10;
          // Bonus for exact word match anywhere
          else if (searchableText.split(/\s+/).includes(token)) score += 5;
          // SKU bonus only for full SKU match (not substring — avoids "ruby" matching SKU "RUBY-PNK-8")
          if (skuText === token || skuText.startsWith(token + '-')) score += 10;
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

/**
 * Look up a variant by exact SKU. Returns null if not found.
 */
function getVariantBySku(sku) {
  if (!sku) return null;
  const normalSku = sku.trim().toUpperCase();
  for (const product of cachedProducts) {
    for (const variant of product.variants) {
      if ((variant.sku || '').trim().toUpperCase() === normalSku) {
        return {
          productId: product.id,
          productTitle: product.title,
          variantId: variant.id,
          variantTitle: variant.title,
          sku: variant.sku,
          price: variant.price,
          inventoryQuantity: variant.inventoryQuantity,
          preOrderDate: variant.preOrderDate,
          options: variant.selectedOptions,
        };
      }
    }
  }
  return null;
}

/**
 * Segment-wise SKU resolver for when exact SKU lookup misses.
 *
 * RUBIES SKUs follow a PREFIX-COLOR-SIZE convention (e.g. RUBY-BLK-4XL).
 * The size segment is sometimes written in a different alias than what the
 * caller typed: "4XL" in the SKU but a user types "4X"; "XS1" in the SKU but
 * a user types "XS+"; "XL" in the SKU but a user types "1X". This helper
 * splits both the query and candidate SKUs on "-", requires the same number
 * of segments, matches non-size segments literally (color codes, prefixes),
 * and applies normalizeSizeLower() to any segment that normalizes to a known
 * size. Returns the unique match or null if 0 / >1 candidates.
 *
 * Case-insensitive. Used by resolveLineItems.js as a fallback after the
 * exact getVariantBySku() miss.
 */
function getVariantBySkuFuzzy(sku) {
  if (!sku) return null;
  const querySegs = sku.trim().toUpperCase().split('-').filter(Boolean);
  if (querySegs.length < 2) return null;

  const candidates = [];

  for (const product of cachedProducts) {
    for (const variant of product.variants) {
      if (!variant.sku) continue;
      const vSegs = variant.sku.trim().toUpperCase().split('-').filter(Boolean);
      if (vSegs.length !== querySegs.length) continue;

      let allMatch = true;
      for (let i = 0; i < querySegs.length; i++) {
        if (vSegs[i] === querySegs[i]) continue;
        // Size-alias fallback: both segments normalize to the same canonical size
        const qNorm = normalizeSizeLower(querySegs[i]);
        const vNorm = normalizeSizeLower(vSegs[i]);
        if (qNorm && vNorm && qNorm === vNorm) continue;
        allMatch = false;
        break;
      }

      if (allMatch) {
        candidates.push({ product, variant });
      }
    }
  }

  if (candidates.length !== 1) return null; // 0 or ambiguous

  const { product, variant } = candidates[0];
  return {
    productId: product.id,
    productTitle: product.title,
    variantId: variant.id,
    variantTitle: variant.title,
    sku: variant.sku,
    price: variant.price,
    inventoryQuantity: variant.inventoryQuantity,
    options: variant.selectedOptions,
  };
}

/**
 * Given a SKU, find a sibling variant in the same product with a different size.
 * Used for size exchanges ("one size up/down").
 * Returns null if the SKU or target size isn't found.
 */
function getSiblingVariant(sku, targetSize) {
  if (!sku || !targetSize) return null;
  const normalSku = sku.trim().toUpperCase();
  const normalTarget = normalizeSizeLower(targetSize);

  for (const product of cachedProducts) {
    const match = product.variants.find(v => (v.sku || '').trim().toUpperCase() === normalSku);
    if (!match) continue;

    // Found the product — now find the variant with the target size
    for (const variant of product.variants) {
      const variantSize = getVariantSize(variant);
      if (!variantSize) continue;

      // Match the color from the original variant (handles both "Color" and "Option 1" naming)
      const originalColor = getVariantColor(match);
      const variantColor = getVariantColor(variant);

      if (originalColor && variantColor && originalColor !== variantColor) continue;

      if (variantSize === normalTarget) {
        return {
          productId: product.id,
          productTitle: product.title,
          variantId: variant.id,
          variantTitle: variant.title,
          sku: variant.sku,
          price: variant.price,
          inventoryQuantity: variant.inventoryQuantity,
          options: variant.selectedOptions,
        };
      }
    }

    // If we found the product but not the size, return null (don't search other products)
    return null;
  }
  return null;
}

function getCacheAgeHours() {
  if (!cacheTimestamp) return Infinity;
  return (Date.now() - new Date(cacheTimestamp).getTime()) / (1000 * 60 * 60);
}

/**
 * Render a customer-friendly product reference from a SKU.
 *
 * Examples:
 *   "HLA-SND-S"   -> "the Sassy in Sandstone, size S"
 *   "GAF-BLK-2XL" -> "the Naomi in Black, size 2X"
 *   "AJ-BLK-M"    -> "the AJ in Black, size M"
 *   "MPAD-S"      -> "the Magical, size S"   (size-only product)
 *
 * Why this exists: customer-facing text everywhere needs short, friendly product
 * names. Three traps the codebase has hit before:
 *   1. Some Shopify variant `selectedOptions` are named "Option 1" / "Option 2"
 *      generically, not "Color" / "Size" — don't rely on option names.
 *   2. The short name is CURATED (`product_cs_config.nickname`), never derived
 *      from the handle. A handle is an SEO slug describing the garment, not the
 *      product's name, and the two come apart constantly: the Serena lives at
 *      `the-shaping-shorty-shorts`, the Charlie at
 *      `the-extra-cute-shaping-underwear`, the Stella at
 *      `high-waisted-shaping-bikini-bottom`. Deriving from the first non-"the"
 *      segment called those the Shaping, the Extra and the High, and collapsed
 *      three separate products onto "Rubies" and three more onto "Progress" —
 *      measured wrong on 13 of 25 active products (2026-08-25). A handle can
 *      also be renamed for SEO at any time, which silently changes what we call
 *      a product to a customer.
 *   3. SKU prefix is a reliable cross-system key today (verified all unique
 *      across products as of Apr 2026). Don't try to parse SKU shape; use
 *      getVariantBySku() and read structured fields.
 *
 * Strategy: look up the variant by exact SKU, read the curated short name off
 * the product, derive color+size from variant.title (which is consistently
 * formatted as "Color / Size", or just "Size" for size-only products).
 *
 * Returns null if SKU is not found in the cache (caller decides fallback).
 */
function renderVariantForCustomer(sku) {
  if (!sku) return null;
  const target = String(sku).trim().toUpperCase();
  for (const product of cachedProducts) {
    for (const variant of product.variants) {
      if ((variant.sku || '').trim().toUpperCase() !== target) continue;
      return formatVariantReference(product, variant);
    }
  }
  return null;
}

function formatVariantReference(product, variant) {
  // Curated nickname, else the product's own title. Never the handle: a wrong
  // short name is indistinguishable from a real one to a customer, whereas a
  // verbose title only reads as clumsy. Same reasoning as getSizeList returning
  // null rather than falling through to a generic size run.
  const shortName = product.nickname
    || (product.title || '').replace(/^THE\s+/i, '').trim()
    || 'item';
  const variantTitle = (variant.title || '').trim();
  // Variant title patterns:
  //   "Black / S"          -> color=Black, size=S
  //   "Sandstone / 2X Tall"-> color=Sandstone, size=2X Tall
  //   "S"                  -> size only (e.g. chest pads)
  //   "Default Title"      -> no variant — fallback to just the short name
  if (!variantTitle || /^default(\s+title)?$/i.test(variantTitle)) {
    return `the ${shortName}`;
  }
  const parts = variantTitle.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) return `the ${shortName}, size ${parts[0]}`;
  if (parts.length >= 2) return `the ${shortName} in ${parts[0]}, size ${parts.slice(1).join(' / ')}`;
  return `the ${shortName}`;
}

/**
 * Which COLOURS of a set of same-size variants can actually ship, with counts.
 *
 * Pure. Takes the already-filtered variant matches for one product in one size
 * (the shape `searchProducts` returns) and reduces them to the colour breakdown.
 *
 * Why it exists: a summed size total answers "can we send something?" and NOT
 * "which colours can we send?", and those come apart constantly — the Sassy in
 * 1X reads 38 units, all of them Pink, with Black and Sandstone at zero. Any
 * caller holding only the sum has nothing truthful to say about colour, and a
 * model handed a sum plus some OTHER product's colour list will reach for the
 * list. That is exactly how a draft came to offer three colours of which two
 * could not be fulfilled (2026-08-24).
 *
 * Size-only products (chest pads: variant title "S", no " / ") have no colour
 * dimension at all, so they return [] rather than a colour named "S".
 *
 * @param {Array<{variantTitle?: string, title?: string, inventoryQuantity?: number}>} variants
 * @returns {Array<{color: string, inventory: number}>} in-stock colours only
 */
function colorsInStock(variants) {
  const byColor = new Map();
  for (const v of variants || []) {
    const title = (v.variantTitle || v.title || '').trim();
    // No slash means no colour axis. Guessing one would invent "size 1X" as a
    // colour, which reads as a real choice to a customer.
    if (!title.includes('/')) continue;
    const color = title.split('/')[0].trim();
    if (!color) continue;
    byColor.set(color, (byColor.get(color) || 0) + (v.inventoryQuantity || 0));
  }
  return [...byColor.entries()]
    .map(([color, inventory]) => ({ color, inventory }))
    .filter(c => c.inventory > 0);
}

/**
 * The mirror image of colorsInStock: which colours of a same-size variant set
 * are at ZERO, with the SKUs needed to look up whether anything is inbound.
 *
 * Why both halves are needed: a size total answers "can we send something",
 * colorsInStock answers "in which colours", and neither can answer "is the
 * colour they actually asked for coming back". The Sassy in 1X reads 38 units
 * and three colours exist; Black and Sandstone are both zero with a container
 * against them. Without this, a customer asking to exchange into Black 1X gets
 * either silence or an offer of Pink, when the true answer is "Black is a
 * couple of weeks out, want me to hold the exchange?".
 *
 * Pure and availability-only — it does not decide whether the wait is worth
 * offering. That judgement belongs to restockEta's offer window, applied
 * identically by every caller.
 */
function colorsOutOfStock(variants) {
  const byColor = new Map();
  for (const v of variants || []) {
    const title = (v.variantTitle || v.title || '').trim();
    if (!title.includes('/')) continue;
    const color = title.split('/')[0].trim();
    if (!color) continue;
    const entry = byColor.get(color) || { color, inventory: 0, skus: [] };
    entry.inventory += (v.inventoryQuantity || 0);
    if (v.sku) entry.skus.push(v.sku);
    byColor.set(color, entry);
  }
  return [...byColor.values()].filter(c => c.inventory <= 0);
}

module.exports = { loadFromSupabase, loadProducts, startRefresh, getProducts, searchProducts, getVariantById, getVariantBySku, getVariantBySkuFuzzy, getSiblingVariant, getCacheAgeHours, renderVariantForCustomer, colorsInStock, colorsOutOfStock, _formatVariantReferenceForTesting: formatVariantReference };
