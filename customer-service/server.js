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
const { loadFromDisk, loadProducts } = require('./lib/productCache');

// Import tool definitions
const customerLookupTools = require('./lib/tools/customerLookup');
const productSearchTools = require('./lib/tools/productSearch');
const exchangeOrderTools = require('./lib/tools/exchangeOrder');
const wholesaleOrderTools = require('./lib/tools/wholesaleOrder');
const invoiceOrderTools = require('./lib/tools/invoiceOrder');
const reloadProductsTools = require('./lib/tools/reloadProducts');
const seoTrendsTools = require('./lib/tools/seoTrends');

const allTools = [
  ...customerLookupTools,
  ...productSearchTools,
  ...exchangeOrderTools,
  ...wholesaleOrderTools,
  ...invoiceOrderTools,
  ...reloadProductsTools,
  ...seoTrendsTools,
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
        schema = z.record(z.any());
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

  // Load from disk instantly (no network), fall back to Shopify fetch if no cache yet
  const hasDiskCache = loadFromDisk();

  // Connect transport — handshake happens immediately
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[CS MCP] Server running on stdio');

  // If no disk cache exists yet, fetch from Shopify in background
  if (!hasDiskCache) {
    console.error('[CS MCP] No disk cache found, fetching from Shopify...');
    loadProducts().catch(err => {
      console.error('[CS MCP] Warning: Failed to load product cache:', err.message);
    });
  }
}

main().catch(err => {
  console.error('[CS MCP] Fatal error:', err);
  process.exit(1);
});
