/**
 * Product catalog cache with fuzzy matching.
 * Persists to disk so startup is instant. Reload on demand via reload_products tool.
 */

const fs = require('fs');
const path = require('path');
const { fetchAllProducts } = require('./shopify');

const CACHE_FILE = path.resolve(__dirname, '../../product-cache.json');

let cachedProducts = [];

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const { products, savedAt } = JSON.parse(raw);
    cachedProducts = products;
    console.error(`[ProductCache] Loaded ${cachedProducts.length} products from disk (saved ${savedAt})`);
    return true;
  } catch {
    return false;
  }
}

async function loadProducts() {
  const allProducts = [];
  let cursor = null;

  while (true) {
    const { products, pageInfo } = await fetchAllProducts(cursor);
    allProducts.push(...products);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  cachedProducts = allProducts.filter(p => p.status === 'ACTIVE');
  const variantCount = cachedProducts.reduce((s, p) => s + p.variants.length, 0);
  console.error(`[ProductCache] Fetched ${cachedProducts.length} active products, ${variantCount} variants`);

  fs.writeFileSync(CACHE_FILE, JSON.stringify({ products: cachedProducts, savedAt: new Date().toISOString() }));
  console.error(`[ProductCache] Cache saved to disk`);
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

module.exports = { loadFromDisk, loadProducts, startRefresh, getProducts, searchProducts, getVariantById };
