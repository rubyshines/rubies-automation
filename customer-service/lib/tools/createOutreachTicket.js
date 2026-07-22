/**
 * MCP tool: create_outreach_ticket
 *
 * Operator-initiated proactive outreach. Given an order number and a free-form
 * steer describing the intent ("back-order heads-up — customer wasn't told
 * upfront"), composes a customer-facing email draft via the CS advisor in
 * outbound-composition mode, then stages it as a pending draft on a new
 * cs_tickets row. NO Gorgias ticket is created and NO email is sent until
 * Jamie reviews the draft in the dashboard and clicks send.
 *
 * The agent that calls this tool (typically the standalone operator) is
 * responsible for resolving the order — if the operator only named a
 * customer, the agent should use lookup_customer / get_customer_orders
 * first to disambiguate before calling this tool.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { buildContext } = require('../contextBuilder');
const { composeOutboundDraft } = require('../composeOutboundDraft');
const { seedOutboundDraft } = require('../customerOutreach');

async function resolveCustomerEmailFromOrder(orderNumber) {
  const supabase = getSupabaseClient();
  const cleaned = String(orderNumber).replace(/^#/, '');
  const numeric = Number(cleaned);
  if (Number.isNaN(numeric)) return null;
  const { data, error } = await supabase
    .from('orders')
    .select('customer_email, order_number')
    .eq('order_number', numeric)
    .maybeSingle();
  if (error) throw new Error(`orders lookup: ${error.message}`);
  return data?.customer_email || null;
}

async function handleCreateOutreachTicket({ order_number, steer, note_text }) {
  if (!order_number) {
    return { content: [{ type: 'text', text: 'order_number is required.' }], isError: true };
  }
  if (!steer || !String(steer).trim()) {
    return { content: [{ type: 'text', text: 'steer is required — describe what the email should communicate.' }], isError: true };
  }

  const cleanOrderNumber = String(order_number).replace(/^#/, '');

  // 1) Resolve customer email from the order.
  let customerEmail;
  try {
    customerEmail = await resolveCustomerEmailFromOrder(cleanOrderNumber);
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to look up order #${cleanOrderNumber}: ${err.message}` }], isError: true };
  }
  if (!customerEmail) {
    return { content: [{ type: 'text', text: `Order #${cleanOrderNumber} not found in Supabase orders mirror. Confirm the order number, or run the orders sync if it's very recent.` }], isError: true };
  }

  // 2) Build context (customer + orders + target order line items).
  let context;
  try {
    context = await buildContext({
      customer_email: customerEmail,
      order_number: cleanOrderNumber,
    });
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed to build context for order #${cleanOrderNumber}: ${err.message}` }], isError: true };
  }
  if (!context?.targetOrder) {
    return { content: [{ type: 'text', text: `Could not resolve order #${cleanOrderNumber} from Shopify even though the email mirror has it. Try refreshing the orders sync.` }], isError: true };
  }

  // 3) Compose the draft.
  let draft;
  try {
    draft = await composeOutboundDraft({
      context,
      orderNumber: cleanOrderNumber,
      steer,
    });
  } catch (err) {
    return { content: [{ type: 'text', text: `Advisor failed to compose draft: ${err.message}` }], isError: true };
  }

  // 4) Seed the cs_tickets + cs_ai_drafts rows. No Gorgias write yet.
  const customerName = [context.customer?.firstName, context.customer?.lastName]
    .filter(Boolean).join(' ').trim() || null;

  const seedResult = await seedOutboundDraft({
    orderNumber: cleanOrderNumber,
    customerEmail,
    customerName,
    subject: draft.subject,
    plainBody: draft.plain_body,
    htmlBody: draft.html_body,
    summary: draft.summary,
    steer,
    noteText: note_text || `Proactive outreach drafted — pending operator review`,
    author: 'operator',
    actionType: draft.action_type,
    operatorActionSummary: draft.operator_action_summary,
  });

  if (!seedResult.ok) {
    return { content: [{ type: 'text', text: `Draft composed but failed to stage: ${seedResult.error}` }], isError: true };
  }

  const previewLines = [
    `**Draft outreach ready for review.**`,
    ``,
    `Order: #${cleanOrderNumber}`,
    `Customer: ${customerEmail}${customerName ? ` (${customerName})` : ''}`,
    `Subject: ${draft.subject}`,
    ``,
    `Open in dashboard: ${seedResult.dashboard_url}`,
    ``,
    `Preview:`,
    '```',
    draft.plain_body,
    '```',
    ``,
    `Nothing has been sent. Review and send (or further steer) in the dashboard.`,
  ];
  if (draft.action_type) {
    previewLines.splice(previewLines.length - 1, 0,
      `Staged operator action (${draft.action_type}): ${draft.operator_action_summary}`, ``);
  }
  if (draft.action_dropped) {
    previewLines.push(`\n_Note: the advisor proposed a paired action but it was incomplete or not a recognized action_type, so it was NOT staged. Re-steer with explicit action instructions if one is needed._`);
  }
  if (seedResult.note_error) {
    previewLines.push(`\n_Note: order_alert_notes insert failed (${seedResult.note_error}). The draft is still staged correctly._`);
  }

  return { content: [{ type: 'text', text: previewLines.join('\n') }] };
}

const tools = [
  {
    name: 'create_outreach_ticket',
    description: 'Compose a proactive outbound email to a customer about one of their orders, and stage it as a pending draft for review in the dashboard. Use when Jamie wants to reach out FIRST about an issue (back-order heads-up, shipping delay he wants to disclose proactively, defect notification, post-purchase feedback request) rather than respond to an inbound message. Provide the order number and a free-form steer describing what the email should communicate. If the outreach pairs with an operator action on the order (an exchange, refund, hold, order edit), describe the action in the steer too — the draft is then staged with the action attached so the dashboard action panel and Execute & Send work on it. The CS advisor composes the draft, no Gorgias ticket is created, and no email is sent until the operator reviews and approves the draft in the dashboard. If the operator only named a customer (no order), use lookup_customer + get_customer_orders FIRST to disambiguate which order, then call this tool with the resolved order number.',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: 'The Shopify order number (e.g. "12345" or "#12345"). Required. The customer email is resolved from this order.',
        },
        steer: {
          type: 'string',
          description: 'Free-form description of what this outbound should communicate. The advisor uses this as the brief for composition. Examples: "Back-order heads-up — Naomi gaff is sold out, offer cancel or swap to AJ/Charlie", "Shipping is delayed by ~5 days due to a Warehance issue, apologize and let them know we are watching it", "Post-purchase feedback request — they got their first Brooke, ask how the fit is". If an operator action should be staged with the draft, describe it precisely here (items with SKUs, sizes, quantities, sequencing) — e.g. "...and stage the exchange: RUBY-BLK-M -> RUBY-BLK-L ships now as its own exchange order; CKY-BLK-M -> CKY-BLK-L as a separate exchange order when the restock lands".',
        },
        note_text: {
          type: 'string',
          description: 'Optional override for the order_alert_notes text that surfaces this order in the daily report. Defaults to "Proactive outreach drafted — pending operator review".',
        },
      },
      required: ['order_number', 'steer'],
    },
    handler: handleCreateOutreachTicket,
  },
];

module.exports = tools;
module.exports._resolveCustomerEmailFromOrder = resolveCustomerEmailFromOrder;
