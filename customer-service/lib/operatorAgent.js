/**
 * Operator Agent — agentic tool-calling loop for operator commands.
 *
 * Works like Claude Code: gets the real MCP tool schemas, full RUBIES context,
 * and an agentic loop that calls tools and reasons about results.
 * The AI decides which tool to call and how — no manual routing.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { PRODUCT_NICKNAMES, _activeProducts, initCsConfig } = require('./sizingEngine');
const { KNOWN_SIZES_UPPER } = require('./sizeUtils');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// Parse + remove the automation-only `AUTO_CONFIRM: SAFE | HOLD — reason` verdict
// the operator agent appends to phase-1 previews. Returns the clean operator-facing
// text plus the structured verdict ({ safe, reason } | null when absent).
const AUTO_CONFIRM_RE = /\n*[ \t]*AUTO_CONFIRM:\s*(SAFE|HOLD)\b[ \t]*(?:[—–-]+\s*([^\n]*))?/i;
function stripAutoConfirm(text) {
  const raw = text || '';
  const m = raw.match(AUTO_CONFIRM_RE);
  if (!m) return { clean: raw, verdict: null };
  const verdict = { safe: /^safe$/i.test(m[1]), reason: (m[2] || '').trim() || null };
  const clean = raw.replace(AUTO_CONFIRM_RE, '').trimEnd();
  return { clean, verdict };
}

// ---------------------------------------------------------------------------
// Load tool schemas — shared with the ad hoc standalone agent
// ---------------------------------------------------------------------------

const { loadAllOperatorTools } = require('./operatorTools');

// ---------------------------------------------------------------------------
// Build system prompt with full RUBIES context
// ---------------------------------------------------------------------------

function buildSystemPrompt(context) {
  const { customer_email, order_number, order_items, fulfillment_status, intake, draft } = context;
  const draftResponse = draft?.draft_response || '';

  // Detect whether this order already has a warehouse hold in place by looking
  // at the timeline only. `draft.action_type === 'warehouse_hold'` is the
  // advisor's *proposal*, not an execution — trusting it as a "hold is placed"
  // signal causes the agent to skip the real tool and falsely report success
  // (the intake pipeline now auto-executes the hold and files a real action
  // entry when it succeeds, so this signal is reliable on its own).
  const holdAlreadyPlaced = Array.isArray(draft?.actions)
    && draft.actions.some(a => a.action_type === 'warehouse_hold');

  const itemList = (order_items || [])
    .map(i => `  - ${i.quantity || 1}x ${i.title} (SKU: ${i.sku}, size: ${i.variant || ''})`)
    .join('\n');

  // Build product nickname reference
  const nicknames = Object.entries(PRODUCT_NICKNAMES || {})
    .map(([k, v]) => `  ${v}: matches "${k}"`)
    .slice(0, 20)
    .join('\n');

  // Build advisor suggestion with full detail: product, size, color, product swaps
  const advisorSuggestion = intake?.items?.length
    ? intake.items.map(i => {
        const target = i.resolved_size || i.desired_size || '?';
        const toProduct = i.resolved_product || i.product || '';
        // Color: explicit from advisor, or inferred from order items by nickname match
        let color = i.resolved_color || '';
        if (!color) {
          const match = (order_items || []).find(oi =>
            (oi.title || '').toLowerCase().includes((i.product || '').toLowerCase()));
          if (match) {
            const parts = (match.variant || '').split(/\s*\/\s*/);
            if (parts.length >= 2) color = parts[0].trim();
          }
        }
        const colorSuffix = color ? ` ${color}` : '';
        return toProduct !== (i.product || '')
          ? `${i.product} ${i.size || ''} → ${toProduct} ${target}${colorSuffix}`
          : `${i.product || ''} ${i.size || ''} → ${target}${colorSuffix}`;
      }).join(', ')
    : 'none';

  return `You are an action executor for the RUBIES customer service dashboard. You execute exchanges, refunds, order edits, holds, and cancellations.

## Current Ticket Context
- Customer: ${customer_email}
- Order: #${order_number}
- Fulfillment: ${fulfillment_status || 'unknown'}
- Warehouse hold: ${holdAlreadyPlaced ? 'ALREADY PLACED — do NOT call warehouse_hold again' : 'not placed'}
- Order items:
${itemList || '  (no items)'}

## Authority Order (CRITICAL)
1. **The operator's command is final.** The operator types directly into the action box, often correcting or extending the AI's draft. If the command says "2 AJs and 1 Flo" and the draft says "3 AJs", do what the operator says.
2. **If the executed action diverges from what the draft promises the customer**, include a brief one-line "⚠️ Note:" at the bottom of the preview message — e.g. "⚠️ Note: draft text says 3 AJs but executed 2 AJs + 1 Flo. You may want to update the draft before sending." This is a heads-up, not a refusal. The two-phase preview→confirm flow lets the operator catch the discrepancy and either update the draft or proceed. Do NOT lecture or argue.
3. The AI draft below is reference context — useful when the operator's command is terse (e.g. operator says "exchange like the draft"). Read the draft to fill gaps the operator's command leaves implicit. Never override explicit operator instructions.
4. The structured hint is the weakest signal — informational only.

Gap filling: if the operator's command leaves something unspecified that the draft addresses (e.g. operator says "exchange the AJ" without specifying size, draft promised size 8), use the draft. If the operator was explicit and the draft disagrees, the operator wins — execute and flag.

## AI Draft Reply (reference — what the customer will receive)
${draftResponse ? `"""\n${draftResponse}\n"""` : '(no draft)'}

## Structured Hint (advisor's items array — may be incomplete)
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

**Exchanges:** Use create_exchange_order for pure exchanges (same number of items, all free). For items, prefer \`query\` (e.g. "Charlie 1X Black") over sku+target_size — it handles product name, size, AND color in one search. The customer_id is required — look it up first if needed. IMPORTANT: Always include the color in the query to match the original order (check the order items above for the color). If the customer ordered Pink, search for "AJ 2X Pink" not just "AJ 2X". Only use a different color if the customer explicitly asked for one.

**Exchange + invoice (extra items):** When the customer is exchanging AND adding extra items, or when the operator says "invoice for the difference", use create_invoice_order. Put the replacement items in \`exchange_items\` (free, 100% discount) and the extra items in \`paid_items\` (full price). This creates ONE order with both free and paid items, then sends an invoice for the paid portion. Example: exchanging 3 items but customer wants 4 → 3 in exchange_items, 1 in paid_items.

**Return + new order (credit against invoice):** When the customer is returning items from a previous order AND ordering different items (not a size swap), use create_invoice_order with \`return_credit\`. Put ALL the new items in \`paid_items\` (full price) and set \`return_credit\` to the dollar value of the items being returned. Set \`return_credit_note\` to describe the credit (e.g. "Stella return credit from order #20335"). The invoice total = new items - return credit. One email to the customer with the net amount. Do NOT process a separate refund — the credit IS the refund, applied as a discount.

**New orders:** Use create_order for paid orders, free replacements, samples, or gifts. Use create_order_complete to finalize (mark as paid for free orders, send invoice for paid orders).

**Refunds:** Use refund_order with the order number and item SKUs.

**Order edits:** Use edit_order with swap_items for modifications. When swapping items and the edit should be cost-neutral (no charge to customer), set \`even_swap: true\` on each swap entry — the tool auto-calculates the exact discount. You can also apply custom discounts with \`discount: { percent: 100 }\` (free) or \`discount: { fixed_amount: 5.00 }\` (dollars off).

**Holds:** Use warehouse_hold / release_warehouse_hold / release_address_hold. **Never call warehouse_hold defensively or "to be safe" when another tool will run** — it's a separate action, not a precondition. If the "Warehouse hold" context line says ALREADY PLACED, skip the tool entirely (the dashboard already filed it). Calling it redundantly clears the action-chat history mid-flow and breaks Phase 2 confirmations on edit_order / create_invoice_order / cancel_order. Only call warehouse_hold when the operator explicitly asks to place a hold AND it isn't already placed.

**Split shipment for pre-order:** Use split_shipment when the customer has agreed to split their order so in-stock items ship now and pre-order/OOS items follow. Pass the SKUs of the HELD items (the pre-order/OOS ones being moved to a new $0 pre-order), not the in-stock items being shipped now. Two-phase: preview, then confirm.

**Invoice for kept items:** Use create_invoice_order with paid_items when the action panel says invoice_kept_items. This covers two cases: (a) the customer kept items they were supposed to return after an exchange and now wants to pay, or (b) the customer was refunded and changed their mind, wanting to keep the items and be re-billed. The advisor's operator_action_summary lists the items, quantities, sizes/colors, unit prices, and total — use those exact values. No exchange_items, no return_credit. The customer pays the invoice; the new payment naturally reconciles any prior refund (do not also reverse the original refund).

**Discount codes:** Use create_discount_code when the operator says "discount", "give them X% off", "comp", "free product", or "make it free". Two modes: percent off the Discounts collection (default 10), or free_product (fixed amount = highest variant price, scoped to one product). The advisor already auto-issues 10% codes for discount_request tickets — only call this tool when the operator explicitly asks for a higher discount or a free product. Always two-phase confirmation when percent_off > 10 or mode=free_product.

## Choosing the Right Tool
- **Same product, different size/color:** create_exchange_order (all free, $0 draft)
- **Replacements + extras:** create_invoice_order with exchange_items + paid_items
- **Return items + order different items:** create_invoice_order with paid_items + return_credit
- **Unfulfilled order changes:** edit_order (auto-handles invoice/refund for price diff)
- **Pure refund:** refund_order
- **New standalone order:** create_order
- **Discount code (>10% or free product):** create_discount_code
- **Split a pre-order shipment:** split_shipment (placeholder-fulfills held SKUs on original, creates $0 pre-order for them)
- **Invoice for kept items (after refund or no-show return):** create_invoice_order with paid_items only (action_type = invoice_kept_items)
- **Consolidate / merge two orders for the same customer into one shipment:** consolidate_orders. Use this whenever the operator says "consolidate", "merge", "combine these orders", "put on one order", "one shipment". Do NOT hand-roll consolidation with edit_order + cancel_order + manual fulfillment — consolidate_orders does the whole thing in one two-phase call: adds the dropped order's items onto the keeper at 100% discount, placeholder-fulfills the dropped order, cross-tags both, and refunds shipping when combined subtotal qualifies for free shipping. Pass keep_order_number + drop_order_number; either order can be the keeper if both are unfulfilled.

## Rules
- **Tool calls precede operator-facing prose.** Internal planning narration ("Looking up the customer…", "Checking inventory for the AJ 1X…") is encouraged before tool calls — the operator sees this in the reasoning trace. But do not write the operator-facing reply (the preview, the confirmation, the summary) until you have called every tool the response requires. Write the reply once, in full, after all tool results are in.
- Always show a preview first (phase 1), then wait for operator confirmation before completing (phase 2).
- **End every Phase 1 "awaiting confirmation" preview with an auto-confirm verdict on its own final line.** The dashboard's one-click "Execute & Send" reads this to decide whether it can confirm phase 2 in the background without a human looking. Emit exactly one of:
  - \`AUTO_CONFIRM: SAFE\` — the preview is a single, clean action that matches what the draft promised the customer, with nothing unexpected.
  - \`AUTO_CONFIRM: HOLD — <short reason>\` — use this whenever you added a "⚠️ Note", asked the operator a question, hit any business or infrastructure error, previewed more than one action, or anything about the action is ambiguous or differs from the draft.
  When in doubt, HOLD. This line is for automation only and is stripped before display — keep it terse. Emit it ONLY on phase 1 previews that end in "awaiting confirmation"; never on phase 2 (post-execution) summaries, address-only edits, or plain informational replies.
- **Exception:** Address-only edits (shipping address updates) — execute immediately, no preview needed. Just report "Address updated on order #X" with the new address. No extra commentary.
- **On operator confirmation, your next action MUST be a tool call — not prose.** When the operator says "yes", "confirm", "yes confirm", "do it", "go ahead", "proceed", "execute" (or clicks the Yes/Confirm quick-reply button), immediately call the SAME tool from the most recent "awaiting confirmation" preview, with \`confirmed: true\` and the same arguments (including \`draft_order_id\` / \`_refund_data\` / \`_fulfill_data\` / \`keep_order_number\` + \`drop_order_number\` / \`order_number\` / etc — whatever Phase 1's preview said to pass back). Do NOT re-run Phase 1, do NOT show the preview again, do NOT narrate, do NOT ask "shall I proceed?" — the operator already said yes. The only acceptable text on a confirmation turn is the post-execution result summary returned by Phase 2. If you genuinely cannot determine which tool/args to use (no prior Phase 1 in history), say so in one short line and stop — don't guess by re-previewing.
- Be concise. Show what you did, not a wall of text. Don't add explanations about why you did or didn't need confirmation.
- For search queries, use short product nicknames (e.g. "Charlie" not "THE CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR").
- If a color change is requested, include the color in the query (e.g. "Charlie 1X Black").
- Tall sizes: ST = S Tall, MT = M Tall, LT = L Tall. When searching, use "S Tall" not "ST" (e.g. "Sky S Tall" not "Sky ST").
- **If a search/tool call fails, do NOT retry with the same query.** Try a different format: use the SKU from the original order with the target size, or search with just the product name and a broader size (e.g. "Sky S" instead of "Sky S Tall"), or use search_products to find the right variant first.
- **Hard-stop on infrastructure errors.** If a tool returns an error that looks like a bug or system failure rather than a normal business outcome, STOP all work immediately and reply with: "Tool \`<name>\` failed with what looks like a bug: <error excerpt>. Stopping so you can fix it before I continue." Do NOT attempt a workaround with a different tool, do NOT keep going on the rest of the request. Infrastructure-error signals: the result starts with or contains "GraphQL errors:", "Field 'X' doesn't exist", "Cannot read properties of", "is not a function", "ECONNREFUSED", "fetch failed", "userErrors", a stack trace, an HTTP 5xx, or any phrase that reads as an exception rather than a business outcome. Business-outcome errors (which you SHOULD try to work around) look like: "Order not found", "SKU X not found in order", "is already fulfilled", "is cancelled", "different customers", "invalid input", "no products found matching". When in doubt, hard-stop — a wasted user turn is much cheaper than executing a workaround on top of a broken substrate.`;
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
async function operatorAgent(message, context, history = [], onEvent, signal) {
  const _t = { start: Date.now(), api_calls: [] };
  const { tools, handlers } = loadAllOperatorTools();
  const systemPrompt = buildSystemPrompt(context);
  const client = getAnthropic();

  // Prompt caching — system prompt is static for the duration of an action-chat session
  // (same ticket context across preview → confirm). Reliable win since operator always
  // makes 2+ API calls within seconds.
  const systemBlocks = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  let currentMessages = [...history, { role: 'user', content: message }];
  let finalResponse = '';
  let toolResults = [];
  const maxIterations = 10;
  const emit = onEvent || (() => {});
  const _ticketId = context.gorgias_ticket_id || context.ticket_id || null;
  const _draftId = context.draft_id || (context.draft && context.draft.id) || null;
  // Best-effort tool-loop linkage: first call in the loop parents the rest.
  let parentCallId = null;

  for (let i = 0; i < maxIterations; i++) {
    const _tApi = Date.now();
    const apiParams = {
      model: MODELS.OPUS,
      max_tokens: 1024,
      system: systemBlocks,
      tools,
      messages: currentMessages,
    };

    let response;
    if (onEvent) {
      // Streaming mode — emit text deltas as they arrive, but suppress the
      // trailing `AUTO_CONFIRM:` verdict line (automation-only, stripped before
      // display). Hold back a short tail so a marker split across deltas
      // ("AUTO" then "_CONFIRM:") is still caught before it streams to the UI.
      let acc = '';        // full accumulated text this turn
      let emitted = 0;      // chars already emitted
      let cut = false;      // true once the verdict marker is seen
      response = await callClaude({
        component: 'cs_operator',
        ...apiParams,
        stream: true,
        ...(signal ? { requestOptions: { signal } } : {}),
        onText: (text) => {
          if (cut) return;
          acc += text;
          const idx = acc.search(/\n*[ \t]*AUTO_CONFIRM:/i);
          if (idx >= 0) {
            if (idx > emitted) emit({ type: 'text_delta', data: acc.slice(emitted, idx) });
            emitted = acc.length;
            cut = true;
            return;
          }
          // Hold back the last 14 chars in case they're the start of the marker.
          const safeEnd = Math.max(emitted, acc.length - 14);
          if (safeEnd > emitted) {
            emit({ type: 'text_delta', data: acc.slice(emitted, safeEnd) });
            emitted = safeEnd;
          }
        },
        ticket_id: _ticketId, draft_id: _draftId, parent_call_id: parentCallId,
        metadata: { customer_email: context.customer_email },
      });
      // Flush any held-back tail that turned out not to be the marker.
      if (!cut && emitted < acc.length) emit({ type: 'text_delta', data: acc.slice(emitted) });
    } else {
      response = await callClaude({
        component: 'cs_operator',
        ...apiParams,
        ...(signal ? { requestOptions: { signal } } : {}),
        ticket_id: _ticketId, draft_id: _draftId, parent_call_id: parentCallId,
        metadata: { customer_email: context.customer_email },
      });
    }
    if (parentCallId === null) parentCallId = response._ai_call_id;

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
      // Always capture the latest text — overwrite, don't accumulate intermediate chatter
      finalResponse = text;
      // Strip the automation-only verdict from the displayed text (it's parsed
      // out of finalResponse below and returned as a structured field).
      emit({ type: 'text', data: stripAutoConfirm(text).clean });
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
        }

        const _tTool = Date.now();
        const toolResult = await handler(toolUse.input);
        const text = toolResult.content?.[0]?.text || JSON.stringify(toolResult);
        result = text;
        toolResults.push({ tool: toolUse.name, input: toolUse.input, result: text, _refund_data: toolResult._refund_data, _duration_ms: Date.now() - _tTool });
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

  // Lift the automation-only AUTO_CONFIRM verdict out of the operator-facing
  // text. `auto_confirm` is the gate signal for the one-click Execute & Send
  // flow; null means no clean phase-1 verdict was emitted (treated as HOLD).
  const { clean, verdict } = stripAutoConfirm(finalResponse);
  finalResponse = clean;

  // Fire shadow Sonnet evaluation in background (diagnostic mode)
  runOperatorShadowEval({
    systemPrompt,
    tools,
    handlers,
    initialMessages: [...history, { role: 'user', content: message }],
    opusResult: { response: finalResponse, toolResults, timing: _t },
    context,
  }).catch(err => console.warn('[shadow] Operator evaluation error:', err.message));

  return {
    response: finalResponse,
    tool_results: toolResults,
    history: currentMessages,
    auto_confirm: verdict,
    _timing: _t,
  };
}

// ---------------------------------------------------------------------------
// Shadow Sonnet evaluation for operator agent
// ---------------------------------------------------------------------------

// Action tools that create/modify real Shopify resources — must NOT run in shadow eval
const SHADOW_BLOCKED_TOOLS = new Set([
  'create_exchange_order',
  'create_invoice_order',
  'create_order',
  'create_order_complete',
  'create_wholesale_order',
  'refund_order',
  'edit_order',
  'delete_draft_order',
  'send_draft_order_invoice',
  'warehouse_hold',
  'release_warehouse_hold',
  'release_address_hold',
  'add_order_note',
  'split_shipment',
]);

async function runOperatorShadowEval({ systemPrompt, tools, handlers, initialMessages, opusResult, context }) {
  // Opt-in, gated by the `cs_diagnostics` flag in system_flags (single source of
  // truth across all runtimes — see shared/systemFlags.js and runShadowEvaluation
  // in aiAdvisor.js). Fail-soft: missing table/row or read error keeps it OFF.
  const { isFlagEnabled } = require('../../shared/systemFlags');
  if (!(await isFlagEnabled('cs_diagnostics'))) return;

  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const supabase = getSupabaseClient();
  const client = getAnthropic();

  // Verify diagnostic table exists
  try {
    const { error: probeErr } = await supabase.from('cs_diagnostic_runs').select('id').limit(0);
    if (probeErr) return;
  } catch (_) { return; }

  const sonnetTiming = { start: Date.now(), api_calls: [] };
  let sonnetMessages = [...initialMessages];
  let sonnetResponse;
  let sonnetFinalResponse = '';
  let sonnetToolResults = [];

  try {
    for (let i = 0; i < 10; i++) {
      const _tApi = Date.now();
      sonnetResponse = await callClaude({
        component: 'cs_operator_shadow',
        model: MODELS.SONNET,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages: sonnetMessages,
        ticket_id: context.gorgias_ticket_id || context.ticket_id || null,
        draft_id: context.draft_id || (context.draft && context.draft.id) || null,
        metadata: { customer_email: context.customer_email },
      });
      sonnetTiming.api_calls.push({
        duration_ms: Date.now() - _tApi,
        input_tokens: sonnetResponse.usage?.input_tokens,
        output_tokens: sonnetResponse.usage?.output_tokens,
      });

      const textBlocks = sonnetResponse.content.filter(b => b.type === 'text');
      const toolUseBlocks = sonnetResponse.content.filter(b => b.type === 'tool_use');
      if (textBlocks.length) sonnetFinalResponse = textBlocks.map(b => b.text).join('\n');
      if (toolUseBlocks.length === 0) break;

      const toolResultMessages = [];
      for (const toolUse of toolUseBlocks) {
        const handler = handlers[toolUse.name];
        let result;
        try {
          if (!handler) throw new Error(`Unknown tool: ${toolUse.name}`);

          // Block action tools in shadow mode — record what Sonnet wanted to do without executing
          if (SHADOW_BLOCKED_TOOLS.has(toolUse.name)) {
            result = JSON.stringify({ shadow_blocked: true, tool: toolUse.name, input: toolUse.input, message: 'Action tool blocked in shadow evaluation mode — not executed.' });
            sonnetToolResults.push({ tool: toolUse.name, input: toolUse.input, blocked: true });
          } else {
            const toolResult = await handler(toolUse.input);
            result = toolResult.content?.[0]?.text || JSON.stringify(toolResult);
            sonnetToolResults.push({ tool: toolUse.name, input: toolUse.input });
          }
        } catch (err) {
          result = JSON.stringify({ error: err.message });
        }
        toolResultMessages.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
      }
      sonnetMessages = [...sonnetMessages, { role: 'assistant', content: sonnetResponse.content }, { role: 'user', content: toolResultMessages }];
    }
  } catch (err) {
    console.warn('[shadow] Operator Sonnet call failed:', err.message);
    return;
  }

  sonnetTiming.total_ms = Date.now() - sonnetTiming.start;

  // Divergence detection — compare tool calls
  const divergences = [];
  const opusTools = opusResult.toolResults.map(t => t.tool).join(',');
  const sonnetTools = sonnetToolResults.map(t => t.tool).join(',');
  if (opusTools !== sonnetTools) divergences.push(`tools: [${opusTools}] vs [${sonnetTools}]`);

  // AI judge for operator actions
  let judgeResult = null;
  try {
    const judgeResponse = await callClaude({
      component: 'cs_operator_shadow_judge',
      ticket_id: context.gorgias_ticket_id || context.ticket_id || null,
      draft_id: context.draft_id || (context.draft && context.draft.id) || null,
      metadata: { customer_email: context.customer_email, role: 'judge' },
      model: MODELS.OPUS,
      max_tokens: 512,
      system: 'You are evaluating two operator agent action responses for a CS dashboard. Compare which tool calls were made and the final response. Be concise.',
      messages: [{
        role: 'user',
        content: `Operator command: "${initialMessages[initialMessages.length - 1]?.content}"

RESPONSE A (production): ${opusResult.response}
Tools called: ${opusTools || 'none'}

RESPONSE B (candidate): ${sonnetFinalResponse}
Tools called: ${sonnetTools || 'none'}

Rate tool_selection (SAME/MINOR_DIFF/MAJOR_DIFF) and response_quality (SAME/MINOR_DIFF/MAJOR_DIFF). For each, note direction (B_BETTER, B_WORSE, or N/A if SAME).

Then give Response B an overall score from 1 to 5, where 3 is baseline (tied with A):
- 5 = significantly better (correct tool sequence A missed, materially better customer-facing reply)
- 4 = modestly better
- 3 = equivalent
- 2 = modestly worse (suboptimal tool choice, slight reply issue)
- 1 = significantly worse (wrong/missing tool call, harmful or incorrect response)

Respond as JSON: { "tool_selection": { "rating": "...", "direction": "...", "note": "..." }, "response_quality": {...}, "score": <1-5>, "score_reason": "one sentence" }`,
      }],
    });
    const judgeText = judgeResponse.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = judgeText.match(/\{[\s\S]*\}/);
    if (jsonMatch) judgeResult = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn('[shadow] Operator judge failed:', err.message);
  }

  try {
    await supabase.from('cs_diagnostic_runs').insert({
      source: 'operator',
      customer_email: context.customer_email,
      opus_draft: opusResult.response,
      opus_structured: null,
      opus_timing: opusResult.timing,
      opus_tools_called: opusResult.toolResults.map(t => t.tool),
      sonnet_draft: sonnetFinalResponse,
      sonnet_structured: null,
      sonnet_timing: sonnetTiming,
      sonnet_tools_called: sonnetToolResults.map(t => t.tool),
      judge_result: judgeResult,
      divergences,
      ticket_id: context.gorgias_ticket_id || context.ticket_id || null,
      draft_id: context.draft_id || (context.draft && context.draft.id) || null,
    });
  } catch (err) {
    console.warn('[shadow] Failed to save operator diagnostic:', err.message);
  }
}

module.exports = { operatorAgent, stripAutoConfirm };
