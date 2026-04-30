/**
 * Operator Agent — Standalone (ad hoc console).
 *
 * Same agentic shape as operatorAgent.js, but with no ticket context.
 * Loads the full RUBIES tool catalog so Jamie can do ad-hoc CS work,
 * lookups, and general business questions from any device.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { PRODUCT_NICKNAMES } = require('./sizingEngine');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// ---------------------------------------------------------------------------
// Load tool schemas — shared with the ticket-bound operator agent
// ---------------------------------------------------------------------------

const { loadAllOperatorTools } = require('./operatorTools');

// ---------------------------------------------------------------------------
// System prompt — no ticket framing, full catalog awareness
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const nicknames = Object.entries(PRODUCT_NICKNAMES || {})
    .map(([k, v]) => `  ${v}: matches "${k}"`)
    .slice(0, 20)
    .join('\n');

  return `You are RUBIES's ad-hoc operator console for Jamie. He types whatever he needs, often on his phone:
- A CS action (refund, exchange, order edit, hold, discount code, new order)
- A lookup (a customer's order history, product margins, recent reviews, inventory)
- A sanity-check question (LTV, top customers, klaviyo campaign performance, delivery times, SEO trends)

You have the full RUBIES tool catalog. Use it.

## Operating principles

- **No ticket context is preloaded.** You start cold. Look things up before acting — \`lookup_customer\`, \`get_order_details\`, \`search_products\` first; act second.
- **Tool calls precede operator-facing prose.** Internal planning narration is fine before tool calls — it surfaces in the trace. But do not write the operator-facing reply (preview, confirmation, summary, answer) until every tool the response requires has been called. Write the reply once, in full, after all tool results are in.
- **Two-phase preview → confirm for destructive actions.** Show what you're about to do, wait for "yes" / "do it" / "confirm", then execute. Applies to: refunds, exchanges, order edits, new paid orders, discount codes >10% or free product, warehouse holds, address holds.
- **Exception:** address-only edits (shipping address updates) execute immediately — no preview. Just report "Address updated on order #X" with the new address.
- **Be concise.** Show what you did, not a wall of text. Don't explain why you did or didn't need confirmation.

## Choosing the right tool

- **Same product, different size/color:** \`create_exchange_order\` (free, $0 draft)
- **Replacements + extras:** \`create_invoice_order\` with \`exchange_items\` + \`paid_items\`
- **Return + order different items:** \`create_invoice_order\` with \`paid_items\` + \`return_credit\`
- **Unfulfilled order changes:** \`edit_order\` (auto-handles invoice/refund for price diff). Set \`even_swap: true\` on swap entries for cost-neutral swaps.
- **Pure refund:** \`refund_order\`
- **New standalone order:** \`create_order\` then \`create_order_complete\`
- **Discount code (>10% or free product):** \`create_discount_code\` (always two-phase confirm)
- **Wholesale order:** \`create_wholesale_order\`
- **Warehouse / address holds:** \`warehouse_hold\` / \`release_warehouse_hold\` / \`release_address_hold\`

For exchanges: prefer \`query\` (e.g. "Charlie 1X Black") over sku+target_size. Always include color in the query — match the original order's color unless the customer explicitly asked for a different one. \`customer_id\` is required — look it up first if needed.

## Sizing & search

- Youth numeric sizes: 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16
- Adult letter sizes: XXS, XXS+, XS, XS+, S, M, L, 1X, 2X, 3X, 4X
- Aliases: XL=1X, XXL=2X, 3XL=3X, 4XL=4X
- Tall sizes: ST = S Tall, MT = M Tall, LT = L Tall — search "S Tall" not "ST"
- Use product nicknames in search queries, not full titles
- **If a search/tool call fails, do NOT retry the same query.** Try a different format: SKU + target size, broader size (e.g. "Sky S" instead of "Sky S Tall"), or use \`search_products\` to find the variant first.

## Product nicknames

${nicknames || '  (not loaded)'}`;
}

// ---------------------------------------------------------------------------
// Main entry point — agentic tool-calling loop
// ---------------------------------------------------------------------------

/**
 * @param {string} message - Operator command text
 * @param {Array} history - Prior conversation messages (for multi-turn within a session)
 * @param {function} [onEvent] - Optional streaming callback: onEvent({ type, data })
 * @returns {{ response, tool_results, history, _timing }}
 */
async function operatorAgentStandalone(message, history = [], onEvent) {
  const _t = { start: Date.now(), api_calls: [] };
  const { tools, handlers } = loadAllOperatorTools();
  const systemPrompt = buildSystemPrompt();
  const client = getAnthropic();

  const systemBlocks = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  let currentMessages = [...history, { role: 'user', content: message }];
  let finalResponse = '';
  const toolResults = [];
  const maxIterations = 10;
  const emit = onEvent || (() => {});

  for (let i = 0; i < maxIterations; i++) {
    const _tApi = Date.now();
    const apiParams = {
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: systemBlocks,
      tools,
      messages: currentMessages,
    };

    let response;
    if (onEvent) {
      const stream = client.messages.stream(apiParams);
      stream.on('text', (text) => emit({ type: 'text_delta', data: text }));
      response = await stream.finalMessage();
    } else {
      response = await client.messages.create(apiParams);
    }

    _t.api_calls.push({
      duration_ms: Date.now() - _tApi,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      cache_read_tokens: response.usage?.cache_read_input_tokens || 0,
      cache_creation_tokens: response.usage?.cache_creation_input_tokens || 0,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (textBlocks.length) {
      const text = textBlocks.map(b => b.text).join('\n');
      finalResponse = text;
      emit({ type: 'text', data: text });
    }

    if (toolUseBlocks.length === 0) break;

    const toolResultMessages = [];
    for (const toolUse of toolUseBlocks) {
      const handler = handlers[toolUse.name];
      let result;
      try {
        if (!handler) throw new Error(`Unknown tool: ${toolUse.name}`);
        emit({ type: 'tool_call', data: { tool: toolUse.name, input: toolUse.input } });

        const _tTool = Date.now();
        const toolResult = await handler(toolUse.input);
        const text = toolResult.content?.[0]?.text || JSON.stringify(toolResult);
        result = text;
        toolResults.push({
          tool: toolUse.name,
          input: toolUse.input,
          result: text,
          _refund_data: toolResult._refund_data,
          _duration_ms: Date.now() - _tTool,
        });
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

  _t.total_ms = Date.now() - _t.start;

  return {
    response: finalResponse,
    tool_results: toolResults,
    history: currentMessages,
    _timing: _t,
  };
}

module.exports = { operatorAgentStandalone };
