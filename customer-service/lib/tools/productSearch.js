/**
 * Product search tools: search_products + get_product_catalog
 */

const { searchProducts } = require('../productCache');
const { getSupabaseClient } = require('../../../shared/supabaseClient');

const tools = [
  {
    name: 'search_products',
    description: 'Search RUBIES product catalog by name, size, color, style, or SKU. Uses fuzzy matching. Example queries: "black 14 AJ", "tucking bikini S", "RB-AJ-BLK-14".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Product search query (name, size, color, SKU, etc.)',
        },
      },
      required: ['query'],
    },
    handler: async ({ query }) => {
      const results = searchProducts(query);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No products found matching "${query}"` }] };
      }
      const formatted = results.map(r => ({
        variantId: r.variantId,
        product: r.productTitle,
        variant: r.variantTitle,
        sku: r.sku,
        price: r.price,
        inventory: r.inventoryQuantity,
        options: r.options,
        collections: r.collections,
        categories: r.categories,
        ageGroups: r.ageGroups,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
      };
    },
  },
  {
    name: 'get_product_catalog',
    description: 'List all active RUBIES products with classifications (collections, categories, age groups), available sizes/colors, inventory totals, and price ranges. Optionally filter by collection, category, or age group.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'Filter by collection name (e.g. "Swimwear", "Tucking Underwear")',
        },
        category: {
          type: 'string',
          description: 'Filter by category (e.g. "bikini", "brief")',
        },
        age_group: {
          type: 'string',
          description: 'Filter by age group (e.g. "Kids", "Adults")',
        },
      },
    },
    handler: async ({ collection, category, age_group }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('get_product_catalog', {
        p_collection: collection || null,
        p_category: category || null,
        p_age_group: age_group || null,
      });

      if (error) {
        return { content: [{ type: 'text', text: `Error fetching catalog: ${error.message}` }], isError: true };
      }

      if (!data || !data.length) {
        const filters = [collection, category, age_group].filter(Boolean).join(', ');
        return { content: [{ type: 'text', text: filters ? `No products found matching filters: ${filters}` : 'No products in catalog' }] };
      }

      const formatted = data.map(p => ({
        productId: p.shopify_product_id,
        title: p.title,
        handle: p.handle,
        type: p.product_type,
        collections: p.collections,
        categories: p.categories,
        ageGroups: p.age_groups,
        kidSizes: p.kid_sizes,
        adultSizes: p.adult_sizes,
        kidColors: p.kid_colors,
        adultColors: p.adult_colors,
        variantCount: p.variant_count,
        totalInventory: p.total_inventory,
        priceRange: p.min_price === p.max_price
          ? `$${p.min_price}`
          : `$${p.min_price}–$${p.max_price}`,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
      };
    },
  },
];

module.exports = tools;
