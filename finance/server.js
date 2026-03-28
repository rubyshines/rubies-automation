#!/usr/bin/env node

/**
 * RUBIES Finance MCP Server
 *
 * Provides QuickBooks Online financial analysis tools
 * via the Model Context Protocol (stdio transport).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// Import tool definitions
const financialSummaryTools = require('./lib/tools/financialSummary');
const expenseBreakdownTools = require('./lib/tools/expenseBreakdown');
const trendAnalysisTools = require('./lib/tools/trendAnalysis');
const marginAnalysisTools = require('./lib/tools/marginAnalysis');
const cashFlowAnalysisTools = require('./lib/tools/cashFlowAnalysis');
const accountDetailTools = require('./lib/tools/accountDetail');
const taxEstimateTools = require('./lib/tools/taxEstimate');
const runwayProjectionTools = require('./lib/tools/runwayProjection');
const financialHealthTools = require('./lib/tools/financialHealth');
const budgetVsActualTools = require('./lib/tools/budgetVsActual');

const allTools = [
  ...financialSummaryTools,
  ...expenseBreakdownTools,
  ...trendAnalysisTools,
  ...marginAnalysisTools,
  ...cashFlowAnalysisTools,
  ...accountDetailTools,
  ...taxEstimateTools,
  ...runwayProjectionTools,
  ...financialHealthTools,
  ...budgetVsActualTools,
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
    name: 'rubies-finance',
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

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[Finance MCP] Server running on stdio (${allTools.length} tools registered)`);
}

main().catch(err => {
  console.error('[Finance MCP] Fatal error:', err);
  process.exit(1);
});
