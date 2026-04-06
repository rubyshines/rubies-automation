/**
 * Product metafield mapper — reuses the logic from syncProducts.js
 *
 * Takes a metafields object (from GraphQL fetchProductById) and returns
 * the columns for the products table.
 */

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
    collections: toArray(metafields.collections),
    categories: toArray(metafields.categories),
    age_groups: toArray(metafields.age_groups),
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

module.exports = { mapMetafields };
