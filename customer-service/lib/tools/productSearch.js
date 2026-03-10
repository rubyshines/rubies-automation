/**
 * Product search tool: search_products
 */

const { searchProducts } = require('../productCache');

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
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
      };
    },
  },
];

module.exports = tools;
