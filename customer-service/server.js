#!/usr/bin/env node

/**
 * RUBIES Customer Service MCP Server
 *
 * Provides Shopify customer lookup, product search, and order creation tools
 * via the Model Context Protocol (stdio transport).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { loadFromSupabase, loadProducts, getCacheAgeHours } = require('./lib/productCache');

// Import tool definitions
const customerLookupTools = require('./lib/tools/customerLookup');
const productSearchTools = require('./lib/tools/productSearch');
const exchangeOrderTools = require('./lib/tools/exchangeOrder');
const wholesaleOrderTools = require('./lib/tools/wholesaleOrder');
const invoiceOrderTools = require('./lib/tools/invoiceOrder');
const reloadProductsTools = require('./lib/tools/reloadProducts');
const seoTrendsTools = require('./lib/tools/seoTrends');
const klaviyoTools = require('./lib/tools/klaviyo');
const csHistoryTools = require('./lib/tools/csHistory');
const csKnowledgeTools = require('./lib/tools/csKnowledge');
const csAdminTools = require('./lib/tools/csAdmin');
const marginsTools = require('./lib/tools/margins');
const reviewsTools = require('./lib/tools/reviews');
const inventoryTools = require('./lib/tools/inventory');
const blogResearchTools = require('./lib/tools/blogResearch');
const draftOrderTools = require('./lib/tools/draftOrders');
const adminTools = require('./lib/tools/adminTools');
const ltvTools = require('./lib/tools/ltv');
const createOrderTools = require('./lib/tools/createOrder');
const exchangeAdvisorTools = require('./lib/tools/exchangeAdvisor');
const conversationTesterTools = require('./lib/tools/conversationTester');
const refundOrderTools = require('./lib/tools/refundOrder');
const shippingLookupTools = require('./lib/tools/shippingLookup');
const orderNotesTools = require('./lib/tools/orderNotes');
const deliveryEstimateTools = require('./lib/tools/deliveryEstimate');
const editOrderTools = require('./lib/tools/editOrder');

const allTools = [
  ...customerLookupTools,
  ...productSearchTools,
  ...exchangeOrderTools,
  ...wholesaleOrderTools,
  ...invoiceOrderTools,
  ...reloadProductsTools,
  ...seoTrendsTools,
  ...klaviyoTools,
  ...csHistoryTools,
  ...csKnowledgeTools,
  ...csAdminTools,
  ...marginsTools,
  ...reviewsTools,
  ...inventoryTools,
  ...blogResearchTools,
  ...draftOrderTools,
  ...adminTools,
  ...ltvTools,
  ...createOrderTools,
  ...exchangeAdvisorTools,
  ...conversationTesterTools,
  ...refundOrderTools,
  ...shippingLookupTools,
  ...orderNotesTools,
  ...deliveryEstimateTools,
  ...editOrderTools,
];

/**
 * Convert a JSON Schema property definition to a Zod schema.
 */
function jsonSchemaToZod(prop) {
  let schema;
  switch (prop.type) {
    case 'string':
      schema = z.string();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'array':
      schema = z.array(
        prop.items ? jsonSchemaToZod(prop.items) : z.any()
      );
      break;
    case 'object':
      if (prop.properties) {
        const shape = {};
        for (const [key, val] of Object.entries(prop.properties)) {
          shape[key] = jsonSchemaToZod(val).optional();
        }
        schema = z.object(shape).passthrough();
      } else {
        schema = z.object({}).passthrough();
      }
      break;
    default:
      schema = z.any();
  }
  if (prop.description) {
    schema = schema.describe(prop.description);
  }
  return schema;
}

async function main() {
  const server = new McpServer({
    name: 'rubies-cs',
    version: '1.0.0',
  });

  // Register all tools
  for (const tool of allTools) {
    const properties = tool.inputSchema?.properties || {};
    const required = tool.inputSchema?.required || [];

    // Build Zod shape from JSON Schema properties
    const shape = {};
    for (const [key, prop] of Object.entries(properties)) {
      let zodSchema = jsonSchemaToZod(prop);
      if (!required.includes(key)) {
        zodSchema = zodSchema.optional();
      }
      shape[key] = zodSchema;
    }

    server.tool(tool.name, tool.description, shape, async (params) => {
      try {
        return await tool.handler(params);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  // Load product CS config (nicknames, categories, size overrides) from Supabase
  const { initCsConfig } = require('./lib/decisionTree');
  await initCsConfig();

  // Load product catalog from Supabase (async but fast), fall back to Shopify fetch if empty
  const hasCache = await loadFromSupabase();

  // Connect transport — handshake happens immediately
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[CS MCP] Server running on stdio');

  // Refresh products if no cache or cache is older than 7 days
  const cacheAge = getCacheAgeHours();
  if (!hasCache) {
    console.error('[CS MCP] No products in Supabase, fetching from Shopify...');
    loadProducts().catch(err => {
      console.error('[CS MCP] Warning: Failed to load product cache:', err.message);
    });
  } else if (cacheAge > 168) { // 7 days
    console.error(`[CS MCP] Product cache is ${Math.round(cacheAge / 24)} days old, refreshing in background...`);
    loadProducts().catch(err => {
      console.error('[CS MCP] Warning: Background refresh failed:', err.message);
    });
  }
}

main().catch(err => {
  console.error('[CS MCP] Fatal error:', err);
  process.exit(1);
});
