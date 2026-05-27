/**
 * History Summarizer
 *
 * Generates a 2-4 sentence prose summary of a closed CS ticket, used to
 * inject prior-ticket context into future advisor runs so second-round
 * follow-ups (exchanges/refunds/defects) are handled correctly.
 *
 * Two call paths:
 *   - Advisor output path: the advisor emits history_summary directly in
 *     its JSON, no extra LLM call needed.
 *   - Lazy path: when contextBuilder finds a prior ticket with history_summary
 *     NULL, it calls generateHistorySummary() on demand and caches the
 *     result back to cs_tickets.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const MODEL = 'claude-opus-4-6';

function buildPrompt(ticketRow) {
  const convo = (ticketRow.conversation_history || [])
    .filter(m => m.sender !== 'note')
    .map(m => `[${m.sender}] ${m.body || ''}`)
    .join('\n')
    .substring(0, 8000);

  const order = ticketRow.order_context || {};
  const orderLine = ticketRow.order_number
    ? `Order: ${ticketRow.order_number}${order.items ? ` — ${JSON.stringify(order.items).substring(0, 300)}` : ''}`
    : 'Order: (none on file)';

  return `Summarize this closed customer support ticket in 2-4 sentences of prose. This summary will be injected as prior history into a future advisor call if the same customer writes in again, so write it for another advisor to understand what happened — not for a customer.

Include:
- Original order number and items (if known)
- What the customer was asking for
- The action taken (exchange, refund, defect handling, etc.) with any new order numbers
- The outcome / how the ticket was resolved

Do NOT include pleasantries, greetings, or the customer's name. Write in past tense.

MESSAGE TYPE: ${ticketRow.message_type || 'unknown'}
${orderLine}
CLOSED AT: ${ticketRow.closed_at || 'unknown'}

CONVERSATION:
${convo}

Respond with ONLY the prose summary. No preamble, no JSON, no quotes.`;
}

/**
 * Generate a history_summary for a ticket row.
 * Does NOT write to the database — caller is responsible for persisting.
 *
 * @param {Object} ticketRow — a cs_tickets row with conversation_history,
 *   message_type, order_number, order_context, closed_at
 * @returns {Promise<string|null>} prose summary, or null on failure
 */
async function generateHistorySummary(ticketRow) {
  if (!ticketRow?.conversation_history?.length) return null;

  try {
    const response = await callClaude({
      component: 'history_summarizer',
      ticket_id: ticketRow.gorgias_ticket_id || null,
      metadata: { message_type: ticketRow.message_type || null },
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: buildPrompt(ticketRow) }],
    });
    const text = (response.content[0]?.text || '').trim();
    return text || null;
  } catch (err) {
    console.warn(`[historySummarizer] Failed for ticket ${ticketRow.gorgias_ticket_id}: ${err.message}`);
    return null;
  }
}

/**
 * Generate and persist a history_summary for a ticket row.
 * Used by the lazy path in contextBuilder.
 *
 * Idempotent: no-op if history_summary is already set on the row.
 *
 * @param {Object} ticketRow — a cs_tickets row
 * @returns {Promise<string|null>} the summary that was used (new or existing)
 */
async function ensureHistorySummary(ticketRow) {
  if (ticketRow?.history_summary) return ticketRow.history_summary;

  const summary = await generateHistorySummary(ticketRow);
  if (!summary) return null;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('cs_tickets')
    .update({ history_summary: summary })
    .eq('id', ticketRow.id)
    .is('history_summary', null); // guard against concurrent writes

  if (error) {
    console.warn(`[historySummarizer] Write-back failed for ticket ${ticketRow.gorgias_ticket_id}: ${error.message}`);
  } else {
    console.log(`[historySummarizer] Generated history_summary for ticket ${ticketRow.gorgias_ticket_id}`);
  }

  return summary;
}

module.exports = { generateHistorySummary, ensureHistorySummary };
