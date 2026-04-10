/**
 * Action Router — agentic tool-calling loop for operator commands.
 *
 * Works like Claude Code: gets the real MCP tool schemas, full RUBIES context,
 * and an agentic loop that calls tools and reasons about results.
 * The AI decides which tool to call and how — no manual routing.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getProductNickname, PRODUCT_NICKNAMES, _activeProducts, initCsConfig } = require('./csConfig');
const { KNOWN_SIZES_UPPER } = require('./sizeUtils');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// ---------------------------------------------------------------------------
// Load real tool schemas from the MCP tool modules
// ---------------------------------------------------------------------------

function loadToolSchemas() {
  const toolModules = [
    // Lookup & search tools (same ones Claude Code uses to gather info first)
    require('./tools/customerLookup'),
    require('./tools/productSearch'),
    require('./tools/draftOrders'),
    // Action tools
    require('./tools/exchangeOrder'),
    require('./tools/refundOrder'),
    require('./tools/editOrder'),
    require('./tools/orderNotes'),
    require('./tools/createOrder'),
  ];

  const tools = [];
  const handlers = {};

  for (const mod of toolModules) {
    for (const tool of mod) {
      // Convert MCP schema format (inputSchema) to Anthropic tool format (input_schema)
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
      handlers[tool.name] = tool.handler;
    }
  }

  return { tools, handlers };
}

// ---------------------------------------------------------------------------
// Build system prompt with full RUBIES context
// ---------------------------------------------------------------------------

function buildSystemPrompt(context) {
  const { customer_email, order_number, order_items, fulfillment_status, intake } = context;

  const itemList = (order_items || [])
    .map(i => `  - ${i.quantity || 1}x ${i.title} (SKU: ${i.sku}, size: ${i.variant || ''})`)
    .join('\n');

  // Build product nickname reference
  const nicknames = Object.entries(PRODUCT_NICKNAMES || {})
    .map(([k, v]) => `  ${v}: matches "${k}"`)
    .slice(0, 20)
    .join('\n');

  const advisorSuggestion = intake?.items?.length
    ? intake.items.map(i => `${i.product} ${i.size || ''} → ${i.resolved_size || '?'}`).join(', ')
    : 'none';

  return `You are an action executor for the RUBIES customer service dashboard. You execute exchanges, refunds, order edits, holds, and cancellations.

## Current Ticket Context
- Customer: ${customer_email}
- Order: #${order_number}
- Fulfillment: ${fulfillment_status || 'unknown'}
- Order items:
${itemList || '  (no items)'}

## AI Advisor Suggestion
${advisorSuggestion}

## RUBIES Product Knowledge
Product nicknames (use these for search queries, NOT full titles):
${nicknames || '  (not loaded)'}

Sizing systems:
- Youth numeric: 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16
- Adult letter: XXS, XXS+, XS, XS+, S, M, L, 1X, 2X, 3X, 4X
- Size aliases: XL=1X, XXL=2X, 3XL=3X, 4XL=4X
- Products with numeric sizing also have letter sizes

## How to Execute Actions

**Exchanges:** Use create_exchange_order. For items, prefer \`query\` (e.g. "Charlie 1X Black") over sku+target_size — it handles product name, size, AND color in one search. The customer_id is required — look it up first if needed.

**Refunds:** Use refund_order with the order number and item SKUs.

**Order edits:** Use edit_order with swap_items for modifications.

**Holds:** Use warehouse_hold / release_warehouse_hold / release_address_hold.

## Rules
- Always show a preview first (phase 1), then wait for operator confirmation before completing (phase 2).
- When the operator says "yes", "confirm", "do it", "go ahead" — proceed with phase 2 using the draft_order_id or _refund_data from phase 1.
- Be concise. Show what you did, not a wall of text.
- For search queries, use short product nicknames (e.g. "Charlie" not "THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR").
- If a color change is requested, include the color in the query (e.g. "Charlie 1X Black").`;
}

// ---------------------------------------------------------------------------
// Main entry point — agentic tool-calling loop
// ---------------------------------------------------------------------------

/**
 * @param {string} message - Operator command text
 * @param {object} context - { draft, customer_email, order_number, order_items, fulfillment_status, intake }
 * @param {Array} history - Prior conversation messages (for multi-turn)
 * @returns {{ response, tool_results, history }}
 */
/**
 * @param {function} [onEvent] - Optional callback for streaming: onEvent({ type, data })
 *   type: 'thinking' | 'tool_call' | 'tool_result' | 'text'
 */
async function routeAction(message, context, history = [], onEvent) {
  const { tools, handlers } = loadToolSchemas();
  const systemPrompt = buildSystemPrompt(context);
  const client = getAnthropic();

  let currentMessages = [...history, { role: 'user', content: message }];
  let finalResponse = '';
  let toolResults = [];
  const maxIterations = 10;
  const emit = onEvent || (() => {});

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages: currentMessages,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (textBlocks.length) {
      const text = textBlocks.map(b => b.text).join('\n');
      // Always capture the latest text — overwrite, don't accumulate intermediate chatter
      finalResponse = text;
      emit({ type: 'text', data: text });
    }

    if (toolUseBlocks.length === 0) break;

    // Execute tool calls
    const toolResultMessages = [];
    for (const toolUse of toolUseBlocks) {
      const handler = handlers[toolUse.name];
      let result;
      try {
        if (!handler) throw new Error(`Unknown tool: ${toolUse.name}`);
        emit({ type: 'tool_call', data: { tool: toolUse.name, input: toolUse.input } });

        // Auto-fix common Sonnet mistakes before calling the tool
        if (toolUse.name === 'create_exchange_order' && !toolUse.input.confirmed) {
          // Resolve customer_id: Sonnet may pass email or skip it
          if (!toolUse.input.customer_id || toolUse.input.customer_id.includes('@')) {
            const { searchCustomers } = require('./shopify');
            const customers = await searchCustomers(context.customer_email);
            if (customers?.[0]) toolUse.input.customer_id = customers[0].id;
          }
          // Strip original_order_id if Sonnet passed the order number (not a Shopify GID)
          // The tool auto-finds the correct fulfilled order when this is omitted
          if (toolUse.input.original_order_id && !String(toolUse.input.original_order_id).includes('gid://')) {
            delete toolUse.input.original_order_id;
          }
          // Convert sku+target_size items to query items (more reliable with Option 1/2 products)
          if (toolUse.input.items) {
            toolUse.input.items = toolUse.input.items.map(item => {
              if (item.sku && item.target_size && !item.query) {
                // Find the product name from the order context
                const orderItem = (context.order_items || []).find(oi => oi.sku === item.sku);
                const productName = orderItem ? (getProductNickname(orderItem.title) || orderItem.title) : item.sku;
                return { query: `${productName} ${item.target_size}`, quantity: item.quantity || 1 };
              }
              return item;
            });
          }
        }

        const toolResult = await handler(toolUse.input);
        const text = toolResult.content?.[0]?.text || JSON.stringify(toolResult);
        result = text;
        toolResults.push({ tool: toolUse.name, input: toolUse.input, result: text, _refund_data: toolResult._refund_data });
        emit({ type: 'tool_result', data: { tool: toolUse.name, result: text } });
      } catch (err) {
        result = JSON.stringify({ error: err.message });
        toolResults.push({ tool: toolUse.name, input: toolUse.input, error: err.message });
        emit({ type: 'tool_result', data: { tool: toolUse.name, error: err.message } });
      }

      toolResultMessages.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultMessages },
    ];

    if (response.stop_reason === 'end_turn') continue;
  }

  return {
    response: finalResponse,
    tool_results: toolResults,
    history: currentMessages,
  };
}

module.exports = { routeAction };
