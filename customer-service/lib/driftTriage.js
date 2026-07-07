/**
 * Drift triage — classify a reconciler-detected "drift" ticket so the daily
 * sync can AUTO-RESOLVE noise (vendor spam, emoji reactions, duplicates) and
 * REPORT only genuine customer misses.
 *
 * Context: the Gorgias → Advisor reconciler (gorgiasAdvisorResync.js) flags any
 * open-in-Gorgias ticket that has no advisor draft, or whose status diverges
 * from ours. Historically EVERY such ticket — including junk that no human ever
 * needs to see — surfaced in the digest's "Ticket Drift" alarm and recurred
 * every day because nothing ever closed it. This module closes the junk and
 * lets the reconciler report only the real misses.
 *
 * Design notes:
 * - Junk classes are closed in Gorgias FIRST, then Supabase (the split-brain
 *   rule from feedback_technical_rules.md — Gorgias is source of truth).
 * - Every auto-close leaves a visible internal note so the action is auditable
 *   and an operator can reopen if a classification was wrong.
 * - The vendor/customer decision can close a real customer if wrong, so it uses
 *   Opus (per the Opus-only guardrail) and defaults to CUSTOMER on any doubt.
 * - dryRun classifies without writing, so the CLI dry run shows the breakdown.
 */

const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { extractCleanBody, checkForDuplicateTicket } = require('../intake/processGorgiasTickets');
const { transplantContinuation, buildTransplantMessages } = require('./ticketContinuation');

/**
 * Deterministic: is this customer "message" actually a Gmail emoji reaction or
 * otherwise contentless? These reopen an already-resolved ticket without adding
 * a real request. We only treat a message as a reaction when it carries an emoji
 * (or the literal Gmail reaction marker) AND has no alphanumeric content, so a
 * genuinely short message like "ok thanks!" is never swallowed here.
 */
function isReactionMessage(message) {
  const raw = (message?.body_text || message?.stripped_text || message?.body || '');
  if (!raw.trim()) return false;
  if (/reacted via gmail/i.test(raw)) return true;

  const hadEmoji = /\p{Extended_Pictographic}/u.test(raw);
  if (!hadEmoji) return false;

  // Strip URLs, emoji, and all non-alphanumerics — if nothing meaningful is
  // left, the message was just an emoji (a reaction).
  const meaningful = raw
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[^a-z0-9]/gi, '')
    .trim();
  return meaningful.length === 0;
}

/**
 * Decide whether an inbound message is from an actual (or prospective) customer
 * vs. unsolicited vendor/sales/marketing outreach. Conservative: anything that
 * could plausibly be a shopper returns isVendorSpam=false.
 */
async function classifyVendorSpam({ subject, body, ticketId }) {
  const system = `You are triaging inbound email to the customer-service inbox for RUBIES, a direct-to-consumer apparel brand (gender-affirming swimwear and underwear for trans girls and women).

Decide whether a message is from an ACTUAL or PROSPECTIVE CUSTOMER, or UNSOLICITED business outreach.

Answer CUSTOMER if there is ANY chance it is a real shopper or someone we'd want to talk to: order questions, sizing, returns/exchanges, product or shipping questions, complaints, donation/free-swimwear requests, or a retailer/store expressing interest in BUYING our product wholesale.

Answer VENDOR only when it is clearly unsolicited outreach trying to SELL US something or pitch a service: SaaS tools, SEO/marketing/ad agencies, returns/logistics platforms, payment providers, recruiters, "partnership" or "collaboration" cold emails, lead-gen, etc., with no sign of being a customer.

When uncertain, answer CUSTOMER.

Reply with exactly one word: CUSTOMER or VENDOR. Then a pipe and a brief reason (under 12 words).
Example: VENDOR | SEO agency cold-pitching link-building services
Example: CUSTOMER | asking to return swim bottoms that didn't fit`;

  try {
    const resp = await callClaude({
      model: MODELS.OPUS,
      component: 'drift_triage',
      ticket_id: ticketId || null,
      metadata: { task: 'vendor_spam_triage' },
      system,
      max_tokens: 40,
      messages: [{ role: 'user', content: `Subject: ${subject || '(none)'}\n\n${(body || '').slice(0, 1500)}` }],
    });
    const text = (resp.content?.[0]?.text || '').trim();
    const isVendorSpam = /^vendor/i.test(text);
    const reason = text.includes('|') ? text.split('|').slice(1).join('|').trim() : text;
    return { isVendorSpam, reason };
  } catch (e) {
    // Fail-closed toward the customer — never auto-close a real shopper on error.
    return { isVendorSpam: false, reason: `classifier error: ${e.message}` };
  }
}

/** Close a ticket as resolved: Gorgias first (source of truth), then Supabase. */
async function closeAsResolved({ gorgias, supabase, ticketId, note }) {
  await gorgias.addInternalNote(ticketId, note);
  await gorgias.closeTicket(ticketId);
  await supabase
    .from('cs_tickets')
    .update({ status: 'closed', updated_at: new Date().toISOString() })
    .eq('gorgias_ticket_id', ticketId);
}

/**
 * Triage one drifted ticket.
 *
 * Returns { disposition, reason } where disposition is one of:
 *   'duplicate' | 'reaction' | 'spam'   → auto-resolved (closed unless dryRun)
 *   'continuation'                      → reply on a broken thread; transplanted
 *                                         onto the surviving ticket, stray closed
 *   'real_miss'                         → genuine customer miss; reconciler reports it
 *
 * @param {object}  args
 * @param {object}  args.supabase   Supabase client
 * @param {object}  args.gorgias    Gorgias client
 * @param {object}  args.ticket     Gorgias ticket (needs id, customer, subject)
 * @param {array}   args.messages   Gorgias messages for the ticket
 * @param {boolean} [args.dryRun]   classify only, perform no writes
 */
async function triageDriftTicket({
  supabase, gorgias, ticket, messages, dryRun = false,
  // test seams — default to the real implementations
  _checkDuplicate = checkForDuplicateTicket,
  _classifyVendorSpam = classifyVendorSpam,
  _transplant = transplantContinuation,
}) {
  const ticketId = ticket.id;
  const customerEmail = ticket.customer?.email || null;
  const customerMsgs = (messages || []).filter(m => m.from_agent === false && m.channel !== 'internal-note');
  const latest = customerMsgs[customerMsgs.length - 1];

  // 1) Duplicate or unthreaded continuation of an existing open ticket?
  if (customerEmail) {
    try {
      const dup = await _checkDuplicate(supabase, customerEmail, ticketId, messages);
      if (dup?.action === 'continuation') {
        // The customer's reply spawned a fresh ticket instead of threading.
        // Move it onto the surviving ticket — never close it away.
        if (!dryRun) {
          await _transplant({
            gorgias,
            supabase,
            newTicketId: ticketId,
            survivor: dup.survivor,
            customerEmail,
            customerName: ticket.customer?.name || null,
            customerMessages: buildTransplantMessages(messages, m => extractCleanBody(m).text),
          });
        }
        return { disposition: 'continuation', reason: `reply on a broken thread — moved to #${dup.survivor.gorgias_ticket_id}` };
      }
      if (dup?.action === 'close_new') {
        if (!dryRun) await closeAsResolved({ gorgias, supabase, ticketId, note: `Auto-closed by drift triage: duplicate of existing open ticket #${dup.survivor.gorgias_ticket_id} for this customer.` });
        return { disposition: 'duplicate', reason: 'duplicate of an existing open ticket' };
      }
    } catch (e) {
      console.warn(`[drift-triage] duplicate check failed for #${ticketId}: ${e.message}`);
    }
  }

  // 2) Emoji reaction / contentless reopen of an already-handled ticket?
  if (latest && isReactionMessage(latest)) {
    if (!dryRun) await closeAsResolved({ gorgias, supabase, ticketId, note: 'Auto-closed by drift triage: emoji reaction with no new request on a resolved ticket.' });
    return { disposition: 'reaction', reason: 'emoji reaction, no new request' };
  }

  // 3) Unsolicited vendor / sales outreach?
  const bodyText = latest ? extractCleanBody(latest).text : '';
  const { isVendorSpam, reason } = await _classifyVendorSpam({ subject: ticket.subject, body: bodyText, ticketId });
  if (isVendorSpam) {
    if (!dryRun) {
      try { await gorgias.addTicketTag(ticketId, 'spam'); } catch (e) { /* tagging is best-effort */ }
      await closeAsResolved({ gorgias, supabase, ticketId, note: `Auto-closed by drift triage: classified as unsolicited vendor/sales outreach (${reason}).` });
    }
    return { disposition: 'spam', reason };
  }

  // 4) Genuine unhandled customer inquiry — report it, do NOT auto-draft.
  //    Leaving real misses un-drafted keeps webhook/intake bugs visible.
  return { disposition: 'real_miss', reason: 'genuine customer inquiry with no advisor draft' };
}

module.exports = { triageDriftTicket, isReactionMessage, classifyVendorSpam };
