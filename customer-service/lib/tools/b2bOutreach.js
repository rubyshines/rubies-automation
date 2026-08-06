/**
 * MCP Tools: B2B Outreach engine — queue, drafting, send (Design #4: the
 * operator console IS the V1 surface; no dashboard panel).
 *
 * Tools:
 *   b2b_queue        — today's outreach queue (6-tier, locked decision #6)
 *   b2b_search       — find any company (incl. ones with nothing due) by name,
 *                      email, domain, contact, or thread subject
 *   b2b_activity     — recent messages across all companies, newest first
 *   b2b_reopen_thread— reopen a concluded thread + draft the follow-up in it
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

// Eastern Time everywhere an operator reads a date.
function etDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  });
}

async function handleSearch(input = {}) {
  try {
    const { searchCompanies } = require(path.join(B2B_LIB, 'queueService'));
    const res = await searchCompanies(getSupabaseClient(), {
      q: input.q, status: input.status || 'all', channel: input.channel, limit: input.limit || 25,
    });
    if (!res.companies.length) {
      return text(res.query ? `No companies match "${res.query}".` : 'No companies found.');
    }
    const lines = res.companies.map(c => {
      const state = [c.relationship_state, c.thread_status === 'never' ? 'never contacted' : `${c.threads_open} open / ${c.threads_closed} closed`]
        .filter(Boolean).join(', ');
      const last = c.last_message_at ? ` — last activity ${etDate(c.last_message_at)}` : '';
      const why = c.matched_on ? ` [${c.matched_on}]` : '';
      const draft = c.has_pending_draft ? ' · DRAFT PENDING' : '';
      return `**${c.name}** (${c.id}) · ${c.relationship_type} · ${state}${last}${why}${draft}`;
    });
    const shown = res.companies.length < res.total ? ` (showing ${res.companies.length} of ${res.total})` : '';
    return text(`Companies${res.query ? ` matching "${res.query}"` : ''}${shown}:\n${lines.join('\n')}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleActivity(input = {}) {
  try {
    const { fetchActivity } = require(path.join(B2B_LIB, 'queueService'));
    const res = await fetchActivity(getSupabaseClient(), {
      direction: input.direction, channel: input.channel, limit: input.limit || 25,
    });
    if (!res.messages.length) return text('No outreach messages on record.');
    const lines = res.messages.map(m => {
      const arrow = m.direction === 'outbound' ? '→' : '←';
      const via = m.source === 'manual_send' ? ' (sent from Gmail)' : m.source === 'gmail_backfill' ? ' (backfilled)' : '';
      return `${etDate(m.sent_at)} ${arrow} **${m.company_name}** — ${m.message_type || 'message'}${via}${m.thread_subject ? ` — "${m.thread_subject}"` : ''}`;
    });
    const syncing = res.gmail_sync === 'started'
      ? '\n\n(Gmail reconcile is running — messages sent by hand in the last few minutes may not be listed yet.)' : '';
    return text(`Outreach activity, newest first:\n${lines.join('\n')}${syncing}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleReopen(input = {}) {
  try {
    const { reopenThread } = require(path.join(B2B_LIB, 'queueService'));
    const res = await reopenThread(getSupabaseClient(), {
      thread_id: input.thread_id, steer: input.steer, message_type: input.message_type,
    });
    if (res.existing_draft_id) {
      return text(`Thread #${res.thread.id} ("${res.thread.subject}") reopened. ${res.thread.company_id} already had pending draft #${res.existing_draft_id} — review that one rather than drafting over it.`);
    }
    const d = res.draft;
    return text(`Thread #${res.thread.id} ("${res.thread.subject}") reopened and follow-up draft #${d.draft_id} written on it (${d.message_type}, confidence ${d.confidence}).\n\nSubject: ${d.email_subject}\n\n${d.email_body}\n\nIt will send inside the existing thread. Review in the Outreach panel or send with send_b2b_email.`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleAddProspect(input = {}) {
  try {
    const { addProspect } = require(path.join(B2B_LIB, 'addProspect'));
    const res = await addProspect(getSupabaseClient(), input);
    if (res.warning) return text(`⚠ ${res.warning}`);
    const draftNote = res.draft_id
      ? ` — intro draft #${res.draft_id} is waiting in the Outreach queue (Tier 4)`
      : ' (no draft generated)';
    // Say plainly that this one cannot be sent from the panel, so nobody hunts
    // for a Send button that is deliberately absent.
    const formNote = res.delivery === 'form'
      ? `\n\nNo email published — submit the draft through their form: ${res.form_url}`
      : '';
    return text(`${res.existed ? 'Updated' : 'Added'} '${res.id}'${draftNote}.${formNote}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleTriage(input = {}) {
  try {
    const { triageCompany } = require(path.join(B2B_LIB, 'triage'));
    const res = await triageCompany(getSupabaseClient(), input);
    const detail = {
      keep: `admitted to the outreach queue (vetted ${res.vetted_at})`,
      drop: `marked lost — ${res.triage_reason}`,
      snooze: `snoozed until ${res.snoozed_until}`,
    }[input.action];
    return text(`**${res.name}** (${res.company_id}) — ${detail}. No draft generated.`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

module.exports = [
  {
    name: 'b2b_triage',
    description: "Vet a company for outreach WITHOUT generating a draft: keep (admit it to the Tier-4 first-touch queue), drop (mark lost with a reason), or snooze (out of the queue until a date). Tier-4 first-touch only surfaces companies that have been kept, so this is how imported prospects are admitted — cohort by cohort rather than all at once.",
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id.' },
        action: { type: 'string', description: "'keep' | 'drop' | 'snooze'." },
        reason: { type: 'string', description: 'Why. Required on drop so the decision is not re-litigated later; optional otherwise.' },
        until: { type: 'string', description: 'Snooze only: YYYY-MM-DD, must be in the future.' },
      },
      required: ['company_id', 'action'],
    },
    handler: handleTriage,
  },
  {
    name: 'b2b_add_prospect',
    description: "The referred-prospect intake: 'someone recommended this org/store' → company record with referral provenance + optional contact + the channel's intro draft waiting in the Outreach queue. Use whenever Jamie names a new org, retailer, or affiliate to reach out to. Never auto-sends. Refuses to re-open companies marked lost.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Organization/store/person name.' },
        channel: { type: 'string', description: "'lgbtq_org' (default) | 'wholesale' | 'affiliate'." },
        website: { type: 'string', description: 'Website URL if known.' },
        email: { type: 'string', description: 'Contact or general email if known.' },
        contact_form_url: { type: 'string', description: "Their contact-form URL, for orgs that publish no email address. Use this instead of guessing info@ — a guessed address risks a bounce against our sending reputation, and a form is usually the channel a small org actually monitors. The draft is still written; the panel shows it as copy-paste text plus this link." },
        contact_name: { type: 'string', description: 'Named contact person, if any.' },
        referred_by: { type: 'string', description: "Who recommended them + their exact words/context. Provenance matters: it's what lets future drafts reference the referral honestly." },
        blurb: { type: 'string', description: 'What the org does, in the referrer\'s words.' },
        country: { type: 'string', description: 'Country, e.g. "United Kingdom".' },
        draft: { type: 'boolean', description: 'Generate the intro draft immediately (default true).' },
        steer: { type: 'string', description: 'Extra guidance for the intro draft.' },
      },
      required: ['name'],
    },
    handler: handleAddProspect,
  },
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
    name: 'b2b_search',
    description: "Find a B2B company (retailer, LGBTQ+ org, affiliate) by name, id, website, email address, contact name, or thread subject — including companies with nothing due, which never appear in b2b_queue. Use whenever Jamie names a company or asks about one by email. Also browses by conversation state: status:'inactive' lists relationships whose threads are all concluded, 'never' lists prospects never written to.",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search term: company name, slug, domain, email address, contact name, or thread subject. Omit to browse all.' },
        status: { type: 'string', description: "Conversation state: 'all' (default) | 'open' (a live thread) | 'inactive' (all threads concluded) | 'never' (no thread yet) | 'lost' (operator-closed relationship)." },
        channel: { type: 'string', description: "Filter: 'wholesale' | 'lgbtq_org' | 'affiliate'. Omit for all." },
        limit: { type: 'number', description: 'Max companies to show (default 25).' },
      },
    },
    handler: handleSearch,
  },
  {
    name: 'b2b_activity',
    description: "Recent B2B outreach messages across every company, newest first — what was sent and what came back. Use for 'what did we send this week', 'has anyone replied', or catching up after time away. Covers engine sends AND emails Jamie sent by hand from Gmail (most outbound is manual).",
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: "'outbound' (what we sent) | 'inbound' (what came back). Omit for both." },
        channel: { type: 'string', description: "Filter: 'wholesale' | 'lgbtq_org' | 'affiliate'. Omit for all." },
        limit: { type: 'number', description: 'Max messages (default 25).' },
      },
    },
    handler: handleActivity,
  },
  {
    name: 'b2b_reopen_thread',
    description: 'Reopen a concluded outreach thread and draft the follow-up inside it, so the email lands in the existing conversation instead of starting a new one. Use when Jamie wants to pick an old conversation back up. Never auto-sends.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'number', description: 'b2b_threads id to reopen (find it with b2b_search, then the company detail).' },
        steer: { type: 'string', description: "What the follow-up should say or reference (final authority on intent)." },
        message_type: { type: 'string', description: 'Force a catalog message type. Omit to let the advisor read the thread and decide.' },
      },
      required: ['thread_id'],
    },
    handler: handleReopen,
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
