/**
 * Tracked customer outreach — reusable substrate for incident notifications and
 * proactive campaigns.
 *
 * Use case: an unexpected issue (sold-out item shown as pre-order, defect batch,
 * shipping incident) or a proactive campaign (post-purchase feedback request)
 * requires emailing a list of customers and tracking their replies.
 *
 * Pattern:
 *   1. Per-incident driver script identifies affected orders and composes
 *      per-order email bodies.
 *   2. Driver hands the list to sendIncidentOutreach().
 *   3. This module creates a new outbound Gorgias ticket per order, registers
 *      it with the advisor pipeline (cs_tickets row in 'snoozed' state with a
 *      seeded cs_ai_drafts row, so the dashboard, follow-up engine, and CS
 *      history search all see it), snoozes the Gorgias ticket 3 days, and
 *      writes an unresolved row to order_alert_notes.
 *
 * Outbound advisor-pipeline modeling:
 *   - cs_tickets: status='snoozed', initiated_by='operator', has_agent_reply=true
 *   - cs_ai_drafts: draft_kind='advisor_draft', status='sent', source='operator_outreach'
 *   - Gorgias ticket snoozed 3 days
 *   This makes the existing snooze→Stage 1 (day 3) → Stage 2 (day 6) follow-up
 *   plumbing apply with no new state. When the customer replies, normal intake
 *   upserts on gorgias_ticket_id and transitions the row to status='open'.
 *
 * Three modes (driver controls via flags, no env vars):
 *   - Default print-only — neither send nor testRecipient set: prints what
 *     would happen, performs zero writes.
 *   - Test send — testRecipient set: creates real Gorgias tickets to that
 *     address (useful for reviewing rendering) but skips ALL durable writes
 *     (cs_tickets, cs_ai_drafts, order_alert_notes, no Gorgias snooze).
 *   - Live send — send: true: creates real tickets to actual customers AND
 *     writes the full advisor-pipeline state plus the alert note.
 */

const gorgias = require('../import/gorgiasClient');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const OUTBOUND_SNOOZE_DAYS = 3;

/**
 * Build the cs_tickets.order_context payload for an outbound ticket from the
 * Supabase order mirror (the same source the dashboard's customer-context
 * endpoint reads). Outbound tickets never run through the inbound advisor, so
 * nothing else populates order_context — without this the dashboard shows
 * "No order associated" until an async fallback fetch lands. The shape matches
 * what the inbound advisor stores as structured.order and what renderOrderCard
 * consumes: { name, date, fulfillment_status, items: [...] }.
 *
 * Returns null when the order can't be resolved (caller leaves order_context
 * null and the async fallback still applies — never throws).
 *
 * @param {string|number} orderNumber
 * @returns {Promise<object|null>}
 */
async function buildOrderContextFromMirror(orderNumber) {
  if (!orderNumber) return null;
  const cleaned = String(orderNumber).replace(/^#/, '');
  const numeric = Number(cleaned);
  if (Number.isNaN(numeric)) return null;
  try {
    const supabase = getSupabaseClient();
    const { data: order } = await supabase
      .from('orders')
      .select('shopify_order_id, order_number, created_at, fulfillment_status')
      .eq('order_number', numeric)
      .maybeSingle();
    if (!order) return null;

    const { data: lineItems } = await supabase
      .from('order_line_items')
      .select('title, variant_title, sku, quantity, refunded_quantity, unit_price, unit_price_currency, custom_attributes')
      .eq('shopify_order_id', order.shopify_order_id);

    return {
      name: `#${order.order_number}`,
      date: order.created_at,
      fulfillment_status: order.fulfillment_status || null,
      items: (lineItems || []).map(i => ({
        title: i.title,
        variant: i.variant_title,
        sku: i.sku,
        quantity: i.quantity,
        refunded_quantity: i.refunded_quantity || 0,
        custom_attributes: i.custom_attributes || null,
        price: i.unit_price,
        currency: i.unit_price_currency,
      })),
    };
  } catch (err) {
    console.warn(`[customerOutreach] buildOrderContextFromMirror(${orderNumber}) failed: ${err.message}`);
    return null;
  }
}

/**
 * @param {object} args
 * @param {Array<{order_number, customer_email, customer_name?, subject, html_body, plain_body?, summary?}>} args.outreaches
 *   summary (optional): short string shown on the dashboard queue card.
 * @param {string} [args.noteText] — text written into order_alert_notes for live mode.
 * @param {string} [args.author='operator'] — author column for the note.
 * @param {string[]} [args.tags=[]] — Gorgias tags applied to each created ticket.
 * @param {boolean} [args.send=false] — when true, real Gorgias tickets + advisor-pipeline rows + notes get written.
 * @param {string} [args.testRecipient] — when set, real tickets go to this email
 *                                         and ALL durable writes are skipped.
 * @returns {Promise<{ mode, results: Array, summary }>}
 */
async function sendIncidentOutreach({
  outreaches,
  noteText,
  author = 'operator',
  tags = [],
  send = false,
  testRecipient,
} = {}) {
  if (!Array.isArray(outreaches) || !outreaches.length) {
    throw new Error('sendIncidentOutreach: outreaches must be a non-empty array');
  }

  const mode = testRecipient ? 'test_send' : (send ? 'live' : 'dry_run');
  const results = [];

  if (mode === 'dry_run') {
    console.log(`\n[DRY RUN] Would send ${outreaches.length} outreach(es). No writes will occur.\n`);
    console.log(`Tags that would be applied: ${tags.length ? tags.join(', ') : '(none)'}`);
    if (noteText) console.log(`Note text that would be written: "${noteText}"`);
    console.log();
    for (let i = 0; i < outreaches.length; i++) {
      const o = outreaches[i];
      console.log('='.repeat(80));
      console.log(`[${i + 1}/${outreaches.length}] Order #${o.order_number}`);
      console.log(`  Recipient: ${o.customer_name ? o.customer_name + ' <' + o.customer_email + '>' : o.customer_email}`);
      console.log(`  Subject: ${o.subject}`);
      console.log('  Body (plain):');
      console.log((o.plain_body || stripHtmlBasic(o.html_body)).split('\n').map(l => '    ' + l).join('\n'));
      console.log();
      results.push({ order_number: o.order_number, status: 'dry_run', customer_email: o.customer_email });
    }
    return { mode, results, summary: { total: outreaches.length, sent: 0, failed: 0 } };
  }

  // test_send or live — actually call Gorgias
  const supabase = mode === 'live' ? getSupabaseClient() : null;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < outreaches.length; i++) {
    const o = outreaches[i];
    const recipientEmail = mode === 'test_send' ? testRecipient : o.customer_email;
    const recipientName = mode === 'test_send' ? 'Test Recipient' : (o.customer_name || '');

    process.stdout.write(`[${i + 1}/${outreaches.length}] #${o.order_number} → ${recipientEmail} ... `);

    try {
      const ticket = await gorgias.createOutboundTicket({
        customerEmail: recipientEmail,
        customerName: recipientName,
        subject: o.subject,
        bodyHtml: o.html_body,
        bodyText: o.plain_body,
        tags,
      });

      if (mode === 'live') {
        // Register with advisor pipeline + snooze. Failures here are logged but
        // do not abort the outreach — the customer's email already went out.
        const pipelineResult = await registerOutboundWithAdvisorPipeline({
          supabase,
          ticket,
          outreach: o,
          recipientEmail,
          recipientName,
        });

        if (noteText) {
          const { error } = await supabase
            .from('order_alert_notes')
            .insert({
              order_number: o.order_number,
              note: noteText,
              resolved: false,
              author,
              alert_type: 'unfulfilled',
            });
          if (error) {
            console.log(`ticket ${ticket.id} created${pipelineResult.ok ? ' + pipeline' : ''}, but note insert FAILED: ${error.message}`);
            failed++;
            results.push({ order_number: o.order_number, status: 'note_failed', ticket_id: ticket.id, error: error.message, customer_email: recipientEmail });
            continue;
          }
        }

        const parts = [`ticket ${ticket.id}`];
        if (pipelineResult.ok) parts.push('+ pipeline');
        else parts.push(`(pipeline FAILED: ${pipelineResult.error})`);
        if (noteText) parts.push('+ note');
        console.log(parts.join(' '));

        sent++;
        results.push({
          order_number: o.order_number,
          status: pipelineResult.ok ? 'sent' : 'pipeline_failed',
          ticket_id: ticket.id,
          cs_ticket_id: pipelineResult.cs_ticket_id || null,
          pipeline_error: pipelineResult.ok ? null : pipelineResult.error,
          customer_email: recipientEmail,
        });
      } else {
        // test_send — Gorgias ticket created, no durable writes
        console.log(`ticket ${ticket.id}`);
        sent++;
        results.push({ order_number: o.order_number, status: 'sent', ticket_id: ticket.id, customer_email: recipientEmail });
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
      results.push({ order_number: o.order_number, status: 'failed', error: err.message, customer_email: recipientEmail });
    }

    // Rate limit pacing — Gorgias is ~2 req/sec
    if (i < outreaches.length - 1) await new Promise(r => setTimeout(r, 600));
  }

  console.log();
  return { mode, results, summary: { total: outreaches.length, sent, failed } };
}

/**
 * Register a newly-created outbound Gorgias ticket with the advisor pipeline:
 * snooze the Gorgias ticket 3 days, write a cs_tickets row in 'snoozed' state,
 * write a seeded cs_ai_drafts row marked as a sent advisor draft, link them.
 *
 * Returns { ok: true, cs_ticket_id } on full success, or { ok: false, error }
 * on any failure (the Gorgias ticket has already been created and emailed at
 * this point, so the caller continues with the next outreach rather than
 * aborting the batch).
 */
async function registerOutboundWithAdvisorPipeline({ supabase, ticket, outreach, recipientEmail, recipientName }) {
  try {
    // Lazy-require the snapshot helper to avoid loading the intake module
    // (which pulls in contextBuilder, etc.) for non-live paths.
    const { buildConversationHistorySnapshot } = require('../intake/processGorgiasTickets');

    // Snooze the Gorgias ticket — this is what drives the day-3 / day-6
    // follow-up cadence via the existing snooze-expiry webhook handler.
    await gorgias.snoozeTicket(ticket.id, OUTBOUND_SNOOZE_DAYS);

    // Fetch the actual messages from Gorgias so the conversation_history
    // snapshot has the real message id and identical structure to inbound.
    const messages = await gorgias.getTicketMessages(ticket.id);
    if (!messages.length) {
      return { ok: false, error: 'Gorgias returned no messages for outbound ticket' };
    }

    const conversationHistory = buildConversationHistorySnapshot(messages);
    const outboundMessage = messages.find(m => m.from_agent === true);
    if (!outboundMessage) {
      return { ok: false, error: 'Could not find outbound (from_agent) message on created ticket' };
    }

    const now = new Date().toISOString();
    const orderNumber = outreach.order_number ? String(outreach.order_number).replace(/^#/, '') : null;
    const orderContext = await buildOrderContextFromMirror(orderNumber);
    const draftBody = outreach.plain_body || stripHtmlBasic(outreach.html_body);

    const { data: ticketRow, error: ticketErr } = await supabase
      .from('cs_tickets')
      .upsert({
        gorgias_ticket_id: ticket.id,
        status: 'snoozed',
        initiated_by: 'operator',
        snoozed_at: now,
        follow_up_stage: 0,
        has_agent_reply: true,
        message_count: 1,
        customer_email: recipientEmail,
        customer_name: recipientName || null,
        order_number: orderNumber,
        order_context: orderContext,
        conversation_history: conversationHistory,
        message_type: 'outbound_outreach',
        confidence: 'high',
        advisor_status: 'ready',
        summary: outreach.summary || null,
        source: 'gorgias',
        last_customer_message_at: null,
        viewed_at: now,
        gorgias_status: 'open',
        gorgias_updated_at: now,
        updated_at: now,
        created_at: now,
      }, { onConflict: 'gorgias_ticket_id' })
      .select('id')
      .single();

    if (ticketErr) return { ok: false, error: `cs_tickets upsert: ${ticketErr.message}` };

    const { data: draftRow, error: draftErr } = await supabase
      .from('cs_ai_drafts')
      .insert({
        ticket_id: ticketRow.id,
        gorgias_ticket_id: ticket.id,
        gorgias_message_id: outboundMessage.id,
        customer_email: recipientEmail,
        customer_name: recipientName || null,
        order_number: orderNumber,
        // draft_response is what the dashboard renders in the AI Draft box as
        // "what to send next." For an outbound-initiated ticket we've already
        // sent our message and are waiting on the customer — nothing to send
        // next until they reply, so leave the draft box empty. sent_response
        // preserves the audit record of what we sent.
        draft_response: '',
        sent_response: draftBody,
        structured_output: {
          status: 'outbound_initiated',
          source: 'operator_outreach',
          subject: outreach.subject,
          recipient_email: recipientEmail,
        },
        audit_trail: ['[Outbound outreach] Operator-initiated ticket via customerOutreach.sendIncidentOutreach()'],
        confidence: 'high',
        advisor_status: 'ready',
        message_type: 'outbound_outreach',
        conversation_history: conversationHistory,
        draft_kind: 'advisor_draft',
        status: 'sent',
        sent_at: now,
        gorgias_reply_message_id: outboundMessage.id,
        source: 'operator_outreach',
      })
      .select('id')
      .single();

    if (draftErr) return { ok: false, error: `cs_ai_drafts insert: ${draftErr.message}` };

    const { error: linkErr } = await supabase
      .from('cs_tickets')
      .update({ active_draft_id: draftRow.id })
      .eq('id', ticketRow.id);

    if (linkErr) return { ok: false, error: `active_draft_id link: ${linkErr.message}` };

    return { ok: true, cs_ticket_id: ticketRow.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function stripHtmlBasic(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Stage a proactive outbound email as a pending draft for operator review.
 *
 * In contrast to sendIncidentOutreach (which creates a Gorgias ticket and
 * sends the email immediately), this function performs zero Gorgias writes.
 * It only creates a cs_tickets row (with gorgias_ticket_id = NULL) and a
 * cs_ai_drafts row in 'pending' state, plus an optional unresolved
 * order_alert_notes row so the affected order surfaces in the daily report.
 *
 * The dashboard's send-draft path detects null gorgias_ticket_id and lazily
 * creates the Gorgias outbound ticket at send time, back-filling the id on
 * both rows. If the operator never sends, no Gorgias ticket is ever created.
 *
 * @param {object} args
 * @param {string|number} args.orderNumber
 * @param {string} args.customerEmail
 * @param {string} [args.customerName]
 * @param {string} args.subject
 * @param {string} args.plainBody
 * @param {string} [args.htmlBody]
 * @param {string} [args.summary] — short queue-card description
 * @param {string} [args.steer] — operator's compose intent, stored for audit
 * @param {string} [args.noteText] — order_alert_notes body; omit to skip
 * @param {string} [args.author='operator']
 * @returns {Promise<{ ok, cs_ticket_id, cs_draft_id, dashboard_url }>}
 */
async function seedOutboundDraft({
  orderNumber,
  customerEmail,
  customerName,
  subject,
  plainBody,
  htmlBody,
  summary,
  steer,
  noteText,
  author = 'operator',
} = {}) {
  if (!customerEmail) throw new Error('seedOutboundDraft: customerEmail is required');
  if (!subject) throw new Error('seedOutboundDraft: subject is required');
  if (!plainBody) throw new Error('seedOutboundDraft: plainBody is required');

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const cleanOrderNumber = orderNumber ? String(orderNumber).replace(/^#/, '') : null;
  const orderContext = await buildOrderContextFromMirror(cleanOrderNumber);

  // 1) cs_tickets row — open, awaiting operator review, no Gorgias yet.
  const { data: ticketRow, error: ticketErr } = await supabase
    .from('cs_tickets')
    .insert({
      gorgias_ticket_id: null,
      status: 'open',
      initiated_by: 'operator',
      follow_up_stage: 0,
      has_agent_reply: false,
      message_count: 0,
      customer_email: customerEmail,
      customer_name: customerName || null,
      order_number: cleanOrderNumber,
      order_context: orderContext,
      conversation_history: [],
      message_type: 'proactive_outreach',
      confidence: 'high',
      advisor_status: 'ready',
      summary: summary || null,
      source: 'gorgias',
      last_customer_message_at: null,
      gorgias_status: null,
      gorgias_updated_at: null,
      updated_at: now,
      created_at: now,
    })
    .select('id')
    .single();

  if (ticketErr) {
    return { ok: false, error: `cs_tickets insert: ${ticketErr.message}` };
  }

  // 2) cs_ai_drafts row — pending, awaiting send.
  const { data: draftRow, error: draftErr } = await supabase
    .from('cs_ai_drafts')
    .insert({
      ticket_id: ticketRow.id,
      gorgias_ticket_id: null,
      gorgias_message_id: null,
      customer_email: customerEmail,
      customer_name: customerName || null,
      order_number: cleanOrderNumber,
      draft_response: plainBody,
      sent_response: null,
      structured_output: {
        status: 'outbound_draft',
        source: 'operator_outreach',
        subject,
        recipient_email: customerEmail,
        operator_steer: steer || null,
      },
      audit_trail: [`[Outbound draft] Operator-initiated draft via composeOutboundDraft. Steer: ${steer || '(none)'}`],
      confidence: 'high',
      advisor_status: 'ready',
      message_type: 'proactive_outreach',
      conversation_history: [],
      draft_kind: 'advisor_draft',
      status: 'pending',
      source: 'operator_outreach',
      operator_steer: steer || null,
    })
    .select('id')
    .single();

  if (draftErr) {
    return { ok: false, error: `cs_ai_drafts insert: ${draftErr.message}`, cs_ticket_id: ticketRow.id };
  }

  // 3) Link active_draft_id back on the ticket.
  const { error: linkErr } = await supabase
    .from('cs_tickets')
    .update({ active_draft_id: draftRow.id })
    .eq('id', ticketRow.id);

  if (linkErr) {
    return { ok: false, error: `active_draft_id link: ${linkErr.message}`, cs_ticket_id: ticketRow.id, cs_draft_id: draftRow.id };
  }

  // 4) Optional note for the daily report.
  if (noteText && cleanOrderNumber) {
    const { error: noteErr } = await supabase
      .from('order_alert_notes')
      .insert({
        order_number: cleanOrderNumber,
        note: noteText,
        resolved: false,
        author,
        alert_type: 'unfulfilled',
      });
    if (noteErr) {
      return { ok: true, cs_ticket_id: ticketRow.id, cs_draft_id: draftRow.id, note_error: noteErr.message };
    }
  }

  // Ignore unused-htmlBody param; kept in signature for symmetry with seedOutboundDraft callers
  // that already build HTML alongside plain text.
  void htmlBody;

  const dashboardBase = process.env.DASHBOARD_URL || 'https://ops.rubyshines.com';
  return {
    ok: true,
    cs_ticket_id: ticketRow.id,
    cs_draft_id: draftRow.id,
    dashboard_url: `${dashboardBase}/#ticket-${ticketRow.id}`,
  };
}

module.exports = { sendIncidentOutreach, registerOutboundWithAdvisorPipeline, seedOutboundDraft, buildOrderContextFromMirror };
