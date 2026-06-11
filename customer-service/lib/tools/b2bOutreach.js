/**
 * MCP Tools: B2B Outreach engine — queue, drafting, send (Design #4: the
 * operator console IS the V1 surface; no dashboard panel).
 *
 * Tools:
 *   b2b_queue        — today's outreach queue (6-tier, locked decision #6)
 *   b2b_draft        — generate/regenerate the advisor draft for a company
 *                      (optional steer), or list pending drafts
 *   send_b2b_email   — two-phase send; phase 2 HARD-GATED on b2b_send_enabled
 *                      (default OFF — go-live is a Jamie cowork act)
 *
 * Agent-agnostic per house rules: tools own operations, agents own judgment.
 */
const path = require('path');
const { getSupabaseClient } = require('../../../shared/supabaseClient');

const B2B_LIB = path.join(__dirname, '../../../b2b-outreach/lib');

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

const SCHEMA_HINT = "Outreach schema not yet applied — run gmail-management/b2b-outreach-schema.sql in the Supabase SQL Editor first.";
function isMissingTable(err) {
  return /Could not find the table 'public\.b2b_(messages|threads|drafts)'/.test(err?.message || '');
}

async function handleQueue(input = {}) {
  try {
    const { fetchOutreachQueue } = require(path.join(B2B_LIB, 'queueService'));
    const sb = getSupabaseClient();

    const queue = await fetchOutreachQueue(sb, { channel: input.channel });
    const top = queue.slice(0, input.limit || 25);

    if (!top.length) return text('Outreach queue is empty — nothing due today.');
    const lines = top.map(e =>
      `T${e.tier} · ${e.channel} · **${e.company_name}** (${e.company_id}) — ${e.message_type || 'reply needed'} — ${e.reason}`);
    return text(`Outreach queue (${queue.length} total, showing ${top.length}):\n${lines.join('\n')}\n\nUse b2b_draft with a company_id to generate the message.`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleDraft(input = {}) {
  try {
    const sb = getSupabaseClient();
    if (input.list || !input.company_id) {
      const { data, error } = await sb.from('b2b_drafts')
        .select('id, company_id, message_type, subject, queue_tier, queue_reason, advisor, generated_at')
        .eq('status', 'pending').order('queue_tier').limit(25);
      if (error) throw new Error(error.message);
      if (!data?.length) return text('No pending outreach drafts.');
      return text('Pending drafts:\n' + data.map(d =>
        `#${d.id} T${d.queue_tier} ${d.company_id} — ${d.message_type} — "${d.subject}" (${d.advisor})`).join('\n'));
    }

    // Generate (or regenerate with steer) for one company
    const { generateDraftForCompany } = require(path.join(B2B_LIB, 'queueService'));
    const d = await generateDraftForCompany(sb, { company_id: input.company_id, steer: input.steer, message_type: input.message_type });
    if (!d) return text(`Company '${input.company_id}' has nothing due (and no message_type was forced). Pass message_type to draft anyway.`);

    const s = d.facts_to_verify?.length ? `\n\nFACTS TO VERIFY: ${d.facts_to_verify.join(' · ')}` : '';
    const c = d.open_commitments?.length ? `\nCOMMITMENTS: ${d.open_commitments.join(' · ')}` : '';
    return text(`Draft #${d.draft_id} (${d.advisor}, ${d.message_type}, confidence ${d.confidence})\n\nSubject: ${d.email_subject}\n\n${d.email_body}${s}${c}\n\nSend with: send_b2b_email { company_id: "${input.company_id}", ... } — preview first, confirmed:true to send (currently gated OFF).`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleSend(input = {}) {
  try {
    const { sendB2bEmail } = require(path.join(B2B_LIB, 'sendB2bEmail'));
    const res = await sendB2bEmail(input);
    if (res.phase === 'preview') {
      return text(`PREVIEW (nothing sent):\nTo: ${res.to}${res.to_name ? ` (${res.to_name})` : ''} [via ${res.resolved_via}]\nFrom: ${res.from}\nSubject: ${res.subject}\nThreading: ${res.threading}\n\n${res.body}\n\nPass confirmed: true to send — note phase 2 is gated by the b2b_send_enabled flag.`);
    }
    if (res.phase === 'blocked') return text(`BLOCKED: ${res.error}`);
    if (res.phase === 'sent') return text(`SENT to ${res.to} (gmail ${res.gmail_message_id}, thread ${res.thread_id}).`);
    return text(`Not sent: ${res.error || JSON.stringify(res)}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

module.exports = [
  {
    name: 'b2b_queue',
    description: "Today's B2B outreach queue across all channels (retailers, LGBTQ+ orgs, affiliates), 6-tier priority: T1 they-replied, T2 time-sensitive signals, T3 healthy cadence, T4 prospect first-touch, T5 overdue, T6 cold revival.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: "Filter: 'wholesale' | 'lgbtq_org' | 'affiliate'. Omit for all." },
        limit: { type: 'number', description: 'Max entries to show (default 25).' },
      },
    },
    handler: handleQueue,
  },
  {
    name: 'b2b_draft',
    description: 'Generate (or regenerate with steer) the outreach advisor draft for a company, or list pending drafts (pass list:true / no company_id). Drafts are NEVER auto-sent.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id (slug). Omit to list pending drafts.' },
        steer: { type: 'string', description: 'Operator steer applied to regeneration (final authority on intent).' },
        message_type: { type: 'string', description: 'Force a specific catalog message type when nothing is due.' },
        list: { type: 'boolean', description: 'List pending drafts.' },
      },
    },
    handler: handleDraft,
  },
  {
    name: 'send_b2b_email',
    description: 'Send a B2B outreach email as jamie@rubyshines.com. TWO-PHASE: default returns a preview; confirmed:true sends. Phase 2 is HARD-GATED on the b2b_send_enabled system flag (default OFF) — flipping that flag is a Jamie-only go-live decision.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id.' },
        thread_id: { type: 'number', description: 'b2b_threads id to reply within. Omit for a new thread.' },
        message_type: { type: 'string', description: 'Catalog message type being sent.' },
        variant_id: { type: 'string', description: 'A/B variant id, if any.' },
        subject: { type: 'string', description: 'Required for new threads; inherited (Re:) for replies.' },
        body: { type: 'string', description: 'Plain-text email body exactly as it should send.' },
        confirmed: { type: 'boolean', description: 'true = actually send (subject to the gate). Default false = preview.' },
      },
      required: ['company_id', 'message_type', 'body'],
    },
    handler: handleSend,
  },
];
