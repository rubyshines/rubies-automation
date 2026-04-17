/**
 * Shared line-item resolver for order-creation MCP tools.
 *
 * Each input item must supply one of (in priority order):
 *   variant_id               direct variant lookup (most precise)
 *   sku + target_size        size exchange: same product, different size, same color
 *   sku                      exact replacement by SKU
 *   query                    fuzzy search fallback (least precise)
 *
 * Returns an array of resolved items with shape:
 *   { variantId, productTitle, variantTitle, sku, price, inventoryQuantity, quantity }
 * Or { error: string } on failure.
 *
 * Used by exchangeOrder, wholesaleOrder, createOrder, invoiceOrder.
 */

const { normalizeGid } = require('./shopify');
const {
  searchProducts,
  getVariantById,
  getVariantBySku,
  getVariantBySkuFuzzy,
  getSiblingVariant,
} = require('./productCache');

async function resolveLineItems(items) {
  const resolved = [];

  for (const item of items) {
    const quantity = item.quantity || 1;

    if (item.variant_id) {
      const variantGid = normalizeGid(item.variant_id, 'ProductVariant');
      const cached = getVariantById(variantGid);
      if (cached) {
        resolved.push({
          variantId: cached.variantId,
          productTitle: cached.productTitle,
          variantTitle: cached.variantTitle,
          sku: cached.sku,
          price: cached.price,
          inventoryQuantity: cached.inventoryQuantity,
          quantity,
        });
      } else {
        resolved.push({
          variantId: variantGid,
          productTitle: '(by ID)',
          variantTitle: item.variant_id,
          sku: null,
          price: item.price || '0',
          quantity,
        });
      }
    } else if (item.sku && item.target_size) {
      const sibling = getSiblingVariant(item.sku, item.target_size);
      if (!sibling) {
        return { error: `Could not find size "${item.target_size}" for SKU "${item.sku}". Check that the size exists for this product.` };
      }
      resolved.push({
        variantId: sibling.variantId,
        productTitle: sibling.productTitle,
        variantTitle: sibling.variantTitle,
        sku: sibling.sku,
        price: sibling.price,
        inventoryQuantity: sibling.inventoryQuantity,
        quantity,
      });
    } else if (item.sku) {
      // Exact lookup first, then segment-wise fuzzy fallback
      // (handles e.g. RUBY-BLK-4X → RUBY-BLK-4XL via size alias).
      const variant = getVariantBySku(item.sku) || getVariantBySkuFuzzy(item.sku);
      if (!variant) {
        return { error: `SKU "${item.sku}" not found in product catalog. It may be discontinued or misspelled.` };
      }
      resolved.push({
        variantId: variant.variantId,
        productTitle: variant.productTitle,
        variantTitle: variant.variantTitle,
        sku: variant.sku,
        price: variant.price,
        inventoryQuantity: variant.inventoryQuantity,
        quantity,
      });
    } else if (item.query) {
      const results = searchProducts(item.query);
      if (results.length === 0) {
        return { error: `No products found matching "${item.query}". Try a different search or use the SKU from the original order.` };
      }
      const best = results[0];
      resolved.push({
        variantId: best.variantId,
        productTitle: best.productTitle,
        variantTitle: best.variantTitle,
        sku: best.sku,
        price: best.price,
        inventoryQuantity: best.inventoryQuantity,
        quantity,
      });
    } else {
      return { error: 'Each item must have variant_id, sku, or query' };
    }
  }

  return resolved;
}

module.exports = { resolveLineItems };
