/**
 * Compose Outbound Draft — operator-initiated proactive outreach.
 *
 * Used by the create_outreach_ticket MCP tool (standalone operator console).
 * Given an order's context and a free-form operator steer describing the
 * intent ("back-order heads-up", "let them know shipping is delayed",
 * "post-purchase feedback request"), Opus composes a customer-facing email
 * from scratch — there is no inbound message to respond to.
 *
 * The output is staged as a draft on a new cs_tickets row by
 * customerOutreach.seedOutboundDraft(); Jamie reviews it in the dashboard
 * and clicks send when ready, at which point the dashboard creates the
 * Gorgias ticket and dispatches the email. Nothing leaves the building
 * until that send.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { SIGNATURE_BLOCK_MD } = require('./signatures');

// Signature block (markdown link → clickable on send) indented to match the
// 2-space prompt indentation.
const SIG_INDENTED = SIGNATURE_BLOCK_MD.split('\n').map(l => `  ${l}`).join('\n');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// Full operator action taxonomy — mirrors the dashboard's EXEC_ACTION_LABELS
// and the inbound advisor's action_type values (aiAdvisor.js parseStructured
// derives exchange/refund/exchange+refund from prescription items and
// whitelists the rest explicitly).
const OUTREACH_ACTION_TYPES = [
  'exchange',
  'refund',
  'exchange+refund',
  'free_order',
  'order_modification',
  'warehouse_hold',
  'cancellation',
  'customer_profile_update',
  'discount_code',
  'split_shipment',
  'order_consolidation',
  'invoice_kept_items',
];

const SYSTEM_PROMPT = `You are RUBIES's CS advisor composing a proactive outbound email FROM RUBIES TO a customer. There is no customer message to respond to — the operator (Jamie) is reaching out first, based on the steer below.

## Brand voice
- Playful, supportive, confident. Celebrating all girls and women.
- Never political, righteous, or judgmental.
- Friendly and personal — Jamie writes like a real person, not a brand.

## Hard rules
- NO em dashes. Use commas, parentheses, or short sentences instead.
- Default they/them when referring to the customer (NEVER use Shopify profile names — dead-name risk).
- Open with a brief friendly greeting that names the order and the reason for reaching out (one sentence). No long preamble. No apology unless the steer explicitly requires one.
- Be concrete: name what's actually happening, what we're doing about it, and what (if anything) we need from the customer.
- When the email shows the customer data we have on file (a shipping address, order contents, dates), reproduce it exactly as it appears in the context or steer, character for character. Never normalize, correct, or omit parts of it. If the steer quotes a value verbatim, your email quotes it verbatim too.
- If the steer says to offer options, lay them out as a short bullet list ("- Option A", "- Option B"). Otherwise no bullets.
- Sign off as Jamie. When the email asks the customer to reply (a question, a confirmation, a choice), use exactly (keep the blank line and the markdown link):
  Talk soon,

${SIG_INDENTED}
  When no reply is expected (a pure heads-up or thank-you), use exactly:
  Take care,

${SIG_INDENTED}

## Paired operator action
Sometimes the steer describes not just the email but an operation the operator will execute on the order (an exchange, a refund, a warehouse hold, an order edit). When it does, stage it alongside the draft:
- Set "action_type" to the matching value: ${OUTREACH_ACTION_TYPES.join(' | ')}.
- Write "operator_action_summary" as precise, executable instructions for the operator: order number, exact items (title + SKU + size/color), quantities, what to create or change, and any sequencing the steer states. Use only facts from the steer and the order context. Never invent SKUs or quantities.
When the steer describes no operation (a pure heads-up, delay notice, or feedback request), set both fields to null.

## Output format
Return ONLY a JSON object — no commentary, no markdown fences. Schema:
{
  "subject": "Short, specific email subject line",
  "body": "Plain-text email body, including greeting and signoff",
  "summary": "One short sentence (under 80 chars) for the dashboard queue card describing what this outreach is about",
  "action_type": "One of the paired-action values above, or null",
  "operator_action_summary": "Precise operator instructions for the paired action, or null"
}`;

function buildUserMessage({ context, steer, orderNumber }) {
  const customer = context?.customer || {};
  const orders = context?.orders || [];
  // Prefer the resolved targetOrder from buildContext; fall back to a name
  // lookup against the orders list, then to the first order in the list.
  const targetOrder = context?.targetOrder
    || (orderNumber
      ? orders.find(o => String(o.name || '').replace('#', '') === String(orderNumber).replace('#', ''))
        || orders.find(o => String(o.orderNumber || '') === String(orderNumber).replace('#', ''))
      : null)
    || orders[0]
    || null;

  const lineItems = (targetOrder?.lineItems?.edges || targetOrder?.lineItems || [])
    .map(e => e.node || e)
    .map(li => {
      const sku = li.sku || li.variant?.sku || '';
      const title = li.title || li.name || '';
      const qty = li.quantity || 1;
      return `  - ${title}${sku ? ` (${sku})` : ''} × ${qty}`;
    })
    .join('\n');

  const shipTo = targetOrder?.shippingAddress || customer.defaultAddress || null;
  const shipToText = shipTo
    ? `${shipTo.address1 || ''}${shipTo.address2 ? ', ' + shipTo.address2 : ''}, ${shipTo.city || ''}, ${shipTo.province || ''} ${shipTo.zip || ''}, ${shipTo.country || shipTo.countryCodeV2 || ''}`.trim()
    : '(unknown)';

  const lines = [
    `[ORDER]`,
    `Number: #${orderNumber}`,
    `Placed: ${targetOrder?.createdAt || targetOrder?.created_at || '(unknown)'}`,
    `Status: ${targetOrder?.displayFulfillmentStatus || targetOrder?.fulfillment_status || '(unknown)'} / ${targetOrder?.displayFinancialStatus || targetOrder?.financial_status || '(unknown)'}`,
    `Total: ${targetOrder?.currentTotalPriceSet?.shopMoney?.amount || targetOrder?.total_price || '(unknown)'} ${targetOrder?.currentTotalPriceSet?.shopMoney?.currencyCode || targetOrder?.currency || ''}`.trim(),
    `Items:`,
    lineItems || '  (no line items found)',
    `Ship to: ${shipToText}`,
    ``,
    `[CUSTOMER]`,
    `Email: ${customer.email || '(unknown)'}`,
    `Country: ${customer.defaultAddress?.countryCodeV2 || customer.defaultAddress?.country || '(unknown)'}`,
    `Total orders: ${customer.numberOfOrders || '?'}`,
    ``,
    `[OPERATOR STEER]`,
    steer,
    ``,
    `Compose the outbound email now. Return only the JSON object.`,
  ];

  return lines.join('\n');
}

function parseJsonResponse(text) {
  // Opus sometimes wraps in ```json fences despite instructions; strip them
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Try to locate a JSON object inside the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) { /* fallthrough */ }
    }
    throw new Error(`composeOutboundDraft: model did not return valid JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Validate the model's proposed paired action. An action is only staged when
 * BOTH a whitelisted action_type and a non-empty operator_action_summary are
 * present — a summary without a type (or vice versa) can't drive the dashboard
 * action panel, so the pair is dropped and flagged for the audit trail.
 */
function normalizeProposedAction(parsed) {
  const summary = typeof parsed?.operator_action_summary === 'string' && parsed.operator_action_summary.trim()
    ? parsed.operator_action_summary.trim()
    : null;
  const type = typeof parsed?.action_type === 'string' && OUTREACH_ACTION_TYPES.includes(parsed.action_type)
    ? parsed.action_type
    : null;
  if (type && summary) return { actionType: type, operatorActionSummary: summary, dropped: false };
  const proposedSomething = Boolean(
    (parsed?.action_type !== null && parsed?.action_type !== undefined) || summary
  );
  return { actionType: null, operatorActionSummary: null, dropped: proposedSomething };
}

function plainToHtml(plain) {
  const lines = String(plain || '').split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${escapeHtml(line.slice(2))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim() === '') html += '';
      else html += `<p>${escapeHtml(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {object} args
 * @param {object} args.context - result of buildContext({ customer_email, order_number })
 * @param {string|number} args.orderNumber - canonical order number (no leading #)
 * @param {string} args.steer - operator's free-form description of intent
 * @returns {Promise<{ subject, plain_body, html_body, summary, _usage }>}
 */
async function composeOutboundDraft({ context, orderNumber, steer }) {
  if (!steer || typeof steer !== 'string' || !steer.trim()) {
    throw new Error('composeOutboundDraft: steer is required');
  }
  if (!orderNumber) {
    throw new Error('composeOutboundDraft: orderNumber is required');
  }

  const userMessage = buildUserMessage({ context, steer, orderNumber });

  const response = await callClaude({
    component: 'compose_outbound_draft',
    metadata: { customer_email: context?.customer_email || null, order_number: orderNumber },
    model: MODELS.OPUS,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('composeOutboundDraft: no text block in model response');

  const parsed = parseJsonResponse(textBlock.text);

  if (!parsed.subject || !parsed.body) {
    throw new Error(`composeOutboundDraft: model output missing subject or body — got keys: ${Object.keys(parsed).join(', ')}`);
  }

  const { actionType, operatorActionSummary, dropped } = normalizeProposedAction(parsed);

  return {
    subject: String(parsed.subject).trim(),
    plain_body: String(parsed.body).trim(),
    html_body: plainToHtml(parsed.body),
    summary: parsed.summary ? String(parsed.summary).trim() : null,
    action_type: actionType,
    operator_action_summary: operatorActionSummary,
    action_dropped: dropped,
    _usage: {
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      cache_read_tokens: response.usage?.cache_read_input_tokens || 0,
    },
  };
}

module.exports = {
  composeOutboundDraft,
  OUTREACH_ACTION_TYPES,
  // Exported for testing
  buildUserMessage,
  parseJsonResponse,
  plainToHtml,
  normalizeProposedAction,
};
