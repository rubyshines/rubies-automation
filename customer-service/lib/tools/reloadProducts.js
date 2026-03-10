/**
 * Tool: reload_products — fetch fresh product catalog from Shopify and persist to disk
 */

const { loadProducts, getProducts } = require('../productCache');

const tools = [
  {
    name: 'reload_products',
    description: 'Reload the product catalog from Shopify and save to disk. Use this after adding or changing products.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      await loadProducts();
      const count = getProducts().length;
      return {
        content: [{ type: 'text', text: `Product catalog reloaded — ${count} active products cached.` }],
      };
    },
  },
];

module.exports = tools;
