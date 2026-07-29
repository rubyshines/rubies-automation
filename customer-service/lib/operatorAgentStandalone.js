/**
 * Operator Agent — Standalone (ad hoc console).
 *
 * Same agentic shape as operatorAgent.js, but with no ticket context.
 * Loads the full RUBIES tool catalog so Jamie can do ad-hoc CS work,
 * lookups, and general business questions from any device.
 */

const { MODELS } = require('../../shared/aiPricing');
const { PRODUCT_NICKNAMES } = require('./sizingEngine');
const { runToolLoop } = require('./runToolLoop');

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
- **Attachments come in two shapes — read each correctly.**
  - **Images / screenshots** (defect photos, order screenshots, competitor pages, emails). Look at them, extract order numbers / SKUs / customer details, and act on what you see.
  - **PDFs and text files** (wholesale invoices, customer-supplied order forms, exported reports). The server already extracts the text and inlines it inside the user message between \`--- Attached file: NAME.pdf ---\` and \`--- End of NAME.pdf ---\` markers. Treat that block as parsed text data — quote line items, addresses, totals from it directly. Do NOT call it an "image" or "screenshot" in your reasoning; it's already-extracted text. Only fall back to image-style language if you literally cannot find a \`--- Attached file: ---\` block for the named file.
- **Investigate fulfillment issues before asking back.** When the operator flags a specific order as having a problem (backordered, delayed, stuck, on hold, "something's wrong with #X"), call \`get_order_details\` and \`get_order_allocation\` first. \`get_order_allocation\` returns hold reasons + per-line-item stock state (on_hand / allocated / available / backordered) — name the stuck item from the data rather than asking the operator which item is the issue. For SKU-level questions beyond a specific order, use \`inventory_allocation\` (live 3PL stock) alongside \`get_inventory_snapshot\` (Shopify-side daily snapshot).
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
- **Invalidate one discount code, or explain why a code won't apply:** \`revoke_discount_code\`. Removes only that customer's code — the other codes on the same discount (bulk email pools, the shared "Thank You N" buckets) keep working. Call without \`confirmed\` first for the lookup + diagnosis, then with \`confirmed: true\`. Refunds nothing.
- **Wholesale order:** \`create_wholesale_order\`. For transitional retailers quoted on pre-Apr-16 2026 prices, set \`pre_increase_pricing: true\`; per-line \`use_current_pricing: true\` keeps individual items at current price (e.g. items the customer never ordered before). When the tool's preview/confirmation output contains a "Price changes for customer" or "Customer notice — prices going up next order" block, ALWAYS include that block verbatim in your reply. Jamie copies it to the customer to disclose the upcoming price change — never paraphrase it away or assume it's redundant with the item table.
- **Donation partners:** \`donation_partner_*\` tools manage the partner registry that feeds both CS routing and the live donation page. The full preview from \`donation_partner_create_from_survey\` / \`donation_partner_create\` (which starts with a \`## Preview — ...\` heading and lists every auto-derived field — geocoded lat/lng, country/region/city, mailing_address block, description, size range, website, logo) MUST be shown verbatim in your reply — Jamie reviews those fields before confirming, and paraphrasing strips out exactly what he needs to verify. Use your own prose only to flag issues or ask follow-up questions AFTER the verbatim preview block. The \`donation_partner_list_submissions\` table output should also be shown verbatim so the in/out/blank status, contact info, and submission date are visible at a glance.
- **Store locator:** \`store_locator_*\` tools manage the retail partner entries on the rubyshines.com/pages/store-locator map. The preview from \`store_locator_create\` (which starts with a \`## Preview — ...\` heading and lists every field — display name, address, description, hours, products, lat/lng, logo) MUST be shown verbatim in your reply before Jamie confirms. Use your own prose only to flag issues AFTER the verbatim preview block. \`store_locator_list\` output should also be shown verbatim.
- **Warehouse / address holds:** \`warehouse_hold\` / \`release_warehouse_hold\` / \`release_address_hold\`
- **Proactive outbound to a customer about their order:** \`create_outreach_ticket\` — when Jamie wants to reach out FIRST about an order issue (back-order heads-up, shipping delay he wants to disclose, defect notification, post-purchase feedback ask). The tool composes a draft and stages it for his review in the dashboard. NO Gorgias ticket and NO email is created until he opens the staged ticket and clicks send. Pass the order_number plus a free-form steer that captures the intent. If he only named a customer, look up their orders FIRST (\`lookup_customer\`, \`get_customer_orders\`) and confirm which order before calling.

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
 * @param {object} [opts]
 * @param {Array<{media_type:string, data:string}>} [opts.images] - Base64 image attachments
 * @param {Array<{media_type:string, data:string, name?:string}>} [opts.pdfs] - Base64 PDF attachments (native document blocks)
 * @returns {{ response, tool_results, history, _timing }}
 */
async function operatorAgentStandalone(message, history = [], onEvent, opts = {}) {
  const _t = { start: Date.now(), api_calls: [] };
  const { tools, handlers } = loadAllOperatorTools();
  const systemPrompt = buildSystemPrompt();

  const systemBlocks = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const images = Array.isArray(opts.images) ? opts.images : [];
  const pdfs = Array.isArray(opts.pdfs) ? opts.pdfs : [];
  let userContent;
  if (images.length || pdfs.length) {
    userContent = [
      ...pdfs.map(pdf => ({
        type: 'document',
        source: { type: 'base64', media_type: pdf.media_type || 'application/pdf', data: pdf.data },
        ...(pdf.name ? { title: pdf.name } : {}),
      })),
      ...images.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      })),
      { type: 'text', text: message },
    ];
  } else {
    userContent = message;
  }

  let finalResponse = '';
  const toolResults = [];
  const emit = onEvent || (() => {});

  const { messages: currentMessages } = await runToolLoop({
    messages: [...history, { role: 'user', content: userContent }],
    maxIterations: 10,
    buildApiParams: () => ({
      component: 'cs_operator_standalone',
      model: MODELS.OPUS,
      max_tokens: 1024,
      system: systemBlocks,
      tools,
      ...(onEvent ? { stream: true, onText: (text) => emit({ type: 'text_delta', data: text }) } : {}),
    }),
    dispatchTool: async (name, input) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      emit({ type: 'tool_call', data: { tool: name, input } });
      return handler(input);
    },
    formatToolResult: (raw) => raw.content?.[0]?.text || JSON.stringify(raw),
    onResponse: (response, { durationMs }) => {
      _t.api_calls.push({
        duration_ms: durationMs,
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
        cache_read_tokens: response.usage?.cache_read_input_tokens || 0,
        cache_creation_tokens: response.usage?.cache_creation_input_tokens || 0,
      });
      const textBlocks = response.content.filter(b => b.type === 'text');
      if (textBlocks.length) {
        const text = textBlocks.map(b => b.text).join('\n');
        finalResponse = text;
        emit({ type: 'text', data: text });
      }
    },
    onToolResult: (entry) => {
      if (entry.error) {
        toolResults.push({ tool: entry.tool, input: entry.input, error: entry.error });
        emit({ type: 'tool_result', data: { tool: entry.tool, error: entry.error } });
      } else {
        toolResults.push({
          tool: entry.tool,
          input: entry.input,
          result: entry.content,
          _refund_data: entry.raw?._refund_data,
          _duration_ms: entry.duration_ms,
        });
        emit({ type: 'tool_result', data: { tool: entry.tool, result: entry.content } });
      }
    },
  });

  _t.total_ms = Date.now() - _t.start;

  return {
    response: finalResponse,
    tool_results: toolResults,
    history: currentMessages,
    _timing: _t,
  };
}

module.exports = { operatorAgentStandalone };
