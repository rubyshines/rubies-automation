/**
 * MCP Tools: Free Swimwear program — review queue + decisioning.
 *
 * Supabase (free_swimwear_requests) is the source of truth. Eligibility is
 * deterministic (computed at intake by the sync); these tools cover the human
 * decision (approve issues a code + acceptance email, reject is silent) plus a
 * one-line AI summary to help the operator scan. Mirrors the donation-partner
 * tool conventions ({content, _structured, isError}).
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { callClaude } = require('../../../shared/aiClient');
const { MODELS } = require('../../../shared/aiPricing');
const { issueAcceptance, sendResend, firstName } = require('../freeSwimwear');
const { writeBackToSheet } = require('../freeSwimwearSheet');

const TABLE = 'free_swimwear_requests';
const LIST_COLS = 'id, submitted_at, email, applicant_name, recipient_age, is_trans_nonbinary, region, status, eligibility_reason, ai_summary, discount_code, expiry_date, send_attempts, possible_second_child, prior_application_at, prior_status, reapply_after, repeat_notice_sent_at';

async function getRow(supabase, id) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function fmtRow(r) {
  return `#${r.id} ${r.applicant_name || '(no name)'} <${r.email}> · age ${r.recipient_age || '?'} · ${r.region || '?'} · ${r.status}${r.discount_code ? ` · ${r.discount_code}` : ''}`;
}

async function generateSummary(row) {
  const prompt = `Summarize this family's free-swimwear application in ONE short line (max ~20 words) for an operator scanning a queue. State who it's for and the core need. No greeting, no preamble, no quotes.

Age of recipient: ${row.recipient_age || 'unknown'}
Region: ${row.region || 'unknown'}
Identifies as trans/non-binary: ${row.is_trans_nonbinary === true ? 'yes' : row.is_trans_nonbinary === false ? 'no' : 'unknown'}
Situation: ${row.situation || '(none provided)'}
Why: ${row.why || '(none provided)'}`;

  const response = await callClaude({
    component: 'free_swimwear_summary',
    model: MODELS.OPUS,
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });
  return (response.content[0]?.text || '').trim();
}

const tools = [
  {
    name: 'free_swimwear_list_requests',
    description: 'List Free Swimwear program applications from the review queue. Default shows status "new" (eligible, awaiting decision). Filter by status (new/accepted/registered/ordered/expired/expired-final/rejected/brazil-rejected/repeat/duplicate) and limit. "repeat" = too-soon repeats (within a year; emailed a reapply notice); "duplicate" = same-day resubmits collapsed silently. Returns applicant, region, status, AI summary, repeat/second-child flags, and discount code when issued.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status. Default "new".' },
        limit: { type: 'number', description: 'Max rows (default 50).' },
      },
    },
    handler: async (input) => {
      const supabase = getSupabaseClient();
      const status = input.status || 'new';
      const limit = input.limit || 50;
      // New queue: oldest applications first (FIFO triage) so the family that
      // has been waiting longest is served first, matching the ticket queues.
      // Every other status is a browse/lookup list (accepted/registered/ordered/
      // expired/rejected/repeat/duplicate/…) — order those alphabetically by
      // email so a specific applicant is easy to find.
      let query = supabase.from(TABLE).select(LIST_COLS).eq('status', status);
      query = status === 'new'
        ? query.order('submitted_at', { ascending: true, nullsFirst: false })
        : query.order('email', { ascending: true });
      const { data, error } = await query.limit(limit);
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      const lines = [`**Free Swimwear — ${status}** (${data.length})`, ''];
      for (const r of data) {
        lines.push(`- ${fmtRow(r)}`);
        if (r.ai_summary) lines.push(`  ${r.ai_summary}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], _structured: { requests: data } };
    },
  },
  {
    name: 'free_swimwear_get_request',
    description: 'Get the full detail of one Free Swimwear application by id, including all the free-text application answers and fulfillment state.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Request id.' } },
      required: ['id'],
    },
    handler: async (input) => {
      const supabase = getSupabaseClient();
      const row = await getRow(supabase, input.id);
      if (!row) return { content: [{ type: 'text', text: `No request #${input.id}.` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }], _structured: { request: row } };
    },
  },
  {
    name: 'free_swimwear_summary',
    description: 'Generate a one-line AI summary of an application\'s situation/need to help the operator scan. Summary only — never a decision. Pass an id for one row, or batch=true to summarize all "new" rows missing a summary. Writes ai_summary.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Summarize one request.' },
        batch: { type: 'boolean', description: 'Summarize all "new" rows that lack a summary.' },
      },
    },
    handler: async (input) => {
      const supabase = getSupabaseClient();
      let rows = [];
      if (input.id) {
        const r = await getRow(supabase, input.id);
        if (!r) return { content: [{ type: 'text', text: `No request #${input.id}.` }], isError: true };
        rows = [r];
      } else if (input.batch) {
        const { data, error } = await supabase.from(TABLE).select('*').eq('status', 'new').is('ai_summary', null).limit(100);
        if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
        rows = data;
      } else {
        return { content: [{ type: 'text', text: 'Pass id or batch=true.' }], isError: true };
      }
      const out = [];
      for (const row of rows) {
        const summary = await generateSummary(row);
        await supabase.from(TABLE).update({ ai_summary: summary, ai_summary_at: new Date().toISOString() }).eq('id', row.id);
        out.push(`#${row.id}: ${summary}`);
      }
      return { content: [{ type: 'text', text: out.join('\n') || 'Nothing to summarize.' }], _structured: { summarized: out.length } };
    },
  },
  {
    name: 'free_swimwear_approve',
    description: 'Approve a Free Swimwear application: issues a unique one-use code under the "Free RUBIES Program" discount and sends the family the SendGrid acceptance email, then sets status to accepted with a 30-day expiry. Two-phase: call without confirmed to preview, then confirmed=true to execute (high-value comp).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Request id.' },
        operator: { type: 'string', description: 'Who approved (for the audit trail).' },
        confirmed: { type: 'boolean', description: 'Set true to execute (phase 2).' },
      },
      required: ['id'],
    },
    handler: async (input) => {
      const supabase = getSupabaseClient();
      const row = await getRow(supabase, input.id);
      if (!row) return { content: [{ type: 'text', text: `No request #${input.id}.` }], isError: true };
      if (row.discount_code) {
        return { content: [{ type: 'text', text: `#${row.id} already has code ${row.discount_code} (status ${row.status}). Not re-issuing.` }], isError: true };
      }
      if (!input.confirmed) {
        return { content: [{ type: 'text', text: `**Approve Preview — #${row.id}**\n\n${fmtRow(row)}\n\nThis will issue a one-use free-swimwear code and email ${row.email} the acceptance (expires in 30 days).\n\n_To confirm, call free_swimwear_approve again with confirmed=true._` }], _structured: { request: row, confirmed: false } };
      }
      let result;
      try {
        result = await issueAcceptance(row);
      } catch (err) {
        return { content: [{ type: 'text', text: `Approve failed: ${err.message}` }], isError: true };
      }
      const patch = { ...result.patch, decided_by: input.operator || null };
      const { error } = await supabase.from(TABLE).update(patch).eq('id', row.id);
      if (error) return { content: [{ type: 'text', text: `Code issued (${result.code}) but DB update failed: ${error.message}` }], isError: true };
      await writeBackToSheet({ ...row, ...patch });
      const emailLine = result.emailSent
        ? `emailed ${row.email} (SendGrid ${result.email.statusCode})`
        : `⚠️ but the acceptance email FAILED to send (${result.email.error}). The code is valid — use Resend to retry the email`;
      return { content: [{ type: 'text', text: `**Approved #${row.id}** — issued \`${result.code}\` and ${emailLine}. Expires in 30 days.` }], _structured: { id: row.id, code: result.code, emailSent: result.emailSent } };
    },
  },
  {
    name: 'free_swimwear_reject',
    description: 'Reject a Free Swimwear application — SILENT (no email is sent to the applicant), per program policy. Sets status to rejected. Use for ineligible or out-of-scope applications.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Request id.' },
        operator: { type: 'string', description: 'Who rejected (for the audit trail).' },
        reason: { type: 'string', description: 'Optional internal note (not sent to the applicant).' },
      },
      required: ['id'],
    },
    handler: async (input) => {
      const supabase = getSupabaseClient();
      const row = await getRow(supabase, input.id);
      if (!row) return { content: [{ type: 'text', text: `No request #${input.id}.` }], isError: true };
      const patch = { status: 'rejected', decided_by: input.operator || null, decided_at: new Date().toISOString() };
      if (input.reason) patch.eligibility_reason = input.reason;
      const { error } = await supabase.from(TABLE).update(patch).eq('id', row.id);
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      await writeBackToSheet({ ...row, ...patch });
      return { content: [{ type: 'text', text: `Rejected #${row.id} (silent — no email sent).` }], _structured: { id: row.id } };
    },
  },
  {
    name: 'free_swimwear_resend',
    description: 'Resend the acceptance email (with the existing code) to a family that has not yet redeemed. Bumps the send-attempt counter. Only valid for an accepted/registered request that already has a code and is not expired.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Request id.' } },
      required: ['id'],
    },
    handler: async (input) => {
      const supabase = getSupabaseClient();
      const row = await getRow(supabase, input.id);
      if (!row) return { content: [{ type: 'text', text: `No request #${input.id}.` }], isError: true };
      if (!row.discount_code) return { content: [{ type: 'text', text: `#${row.id} has no code to resend. Approve it first.` }], isError: true };
      const now = new Date();
      const daysLeft = row.expiry_date ? Math.max(0, Math.floor((new Date(row.expiry_date) - now) / 86400000)) : 0;
      let result;
      try {
        result = await sendResend(row, daysLeft, now);
      } catch (err) {
        return { content: [{ type: 'text', text: `Resend failed: ${err.message}` }], isError: true };
      }
      const { error } = await supabase.from(TABLE).update(result.patch).eq('id', row.id);
      if (error) return { content: [{ type: 'text', text: `Email sent but DB update failed: ${error.message}` }], isError: true };
      await writeBackToSheet({ ...row, ...result.patch });
      if (!result.emailSent) {
        return { content: [{ type: 'text', text: `⚠️ Resend FAILED for #${row.id} (${result.email.error}). Code ${row.discount_code} is still valid.` }], _structured: { id: row.id, emailSent: false } };
      }
      return { content: [{ type: 'text', text: `Resent code ${row.discount_code} to ${row.email} (SendGrid ${result.email.statusCode}, attempt ${result.patch.send_attempts}, ${daysLeft} days left).` }], _structured: { id: row.id, emailSent: true } };
    },
  },
];

module.exports = tools;
