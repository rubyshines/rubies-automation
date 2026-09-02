/**
 * relationshipSummary.js — the rolling per-company recap + suggested next step.
 *
 * This is the feature the old Google-Sheet sales system carried ("AI Summary" /
 * "AI Next Action"), rebuilt on b2b_messages. The machinery never actually went
 * away — gmail-management/lib/threadBuilder.js still does the same job, still
 * runs daily — but it summarizes email_threads keyed on gmail_thread_id, and the
 * outreach engine reads b2b_threads/b2b_messages. Only 11 of 242 companies were
 * reachable across that gap, so the panel showed nothing.
 *
 * Two things differ from the old implementation, both deliberate:
 *
 *   1. COMPANY-level, not thread-level. The sheet had one row per company and the
 *      panel is company-centric; an org like BAGLY carries several threads, which
 *      is why per-thread summaries never aggregated up into anything readable.
 *
 *   2. The next step is ADVISORY. It renders in the panel and enters advisor
 *      context, but it never writes next_action_date and never moves a tier.
 *      cadence.js stays the single authority on what is due — the old sheet had
 *      no cadence engine to disagree with; this system does.
 *
 * Sonnet, not Opus: this is narrow extraction over text we already hold, the
 * operator reads it in the panel before acting on it, and nothing it produces
 * reaches a customer without passing through the advisor and a human. Matches
 * what threadBuilder.js has used for this same job all along.
 */
const { fetchAllPaginated } = require('../../shared/supabaseClient');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// How long a claim is honoured before another caller may take it over. Covers
// the process-died case (a redeploy mid-call); a live call finishes well inside.
const CLAIM_TTL_MS = 10 * 60 * 1000;

// Cap on messages fed to a full rebuild: first + most recent N-1, same shape as
// threadBuilder's first+last-9. A company with 60 messages does not need all of
// them to produce four sentences, and the opener carries how the relationship began.
const FULL_REBUILD_MESSAGE_CAP = 24;
const BODY_CHARS = 2000;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two to four sentences covering the whole relationship: how it started, what has been agreed or declined, and where it stands now. Every date written absolutely.',
    },
    next_step: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'One specific sentence naming the next thing that should happen, or null when the relationship has genuinely concluded (they declined, or the thread reached its natural end).',
    },
    next_step_owner: {
      anyOf: [{ type: 'string', enum: ['us', 'them'] }, { type: 'null' }],
      description: "Who the next step is waiting on. 'them' when we have answered and the ball is in their court.",
    },
    is_concluded: {
      type: 'boolean',
      description: 'True only when there is nothing further to do on this relationship as it stands.',
    },
  },
  required: ['summary', 'next_step', 'next_step_owner', 'is_concluded'],
  additionalProperties: false,
};

/**
 * Decide what kind of pass a company needs. PURE.
 *
 * The subtlety is that history arrives BACKWARDS here: discoverCompanyThreads
 * imports old threads long after the fact (one hand-run discovery pulled twelve
 * messages back to Jun 2025 for a company the queue thought had never been
 * contacted). threadBuilder selects new messages with `date > summary_updated_at`
 * — a wall-clock generation time, not a data boundary — so any message landing
 * below it is invisible forever.
 *
 * So the watermark is the sent_at of the newest message INCLUDED, and a message
 * at or before it means the narrative it belongs inside has already been written.
 * That cannot be patched by appending; it needs a full rebuild.
 *
 * @returns {{ mode: 'full'|'incremental'|'current', newMessages: object[] }}
 */
function summaryMode(company, messages) {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.sent_at || 0) - new Date(b.sent_at || 0)
  );
  if (!sorted.length) return { mode: 'current', newMessages: [] };
  if (!company.relationship_summary || !company.relationship_summary_through) {
    return { mode: 'full', newMessages: sorted };
  }

  const through = new Date(company.relationship_summary_through);
  const unincluded = sorted.filter(m => new Date(m.sent_at) > through);

  // Count is the second half of the staleness test: a backfilled message older
  // than the watermark leaves `unincluded` empty but changes the count, and it
  // is exactly the case a timestamp comparison cannot see.
  const countChanged = Number.isInteger(company.relationship_summary_msg_count)
    && company.relationship_summary_msg_count !== sorted.length;

  if (!unincluded.length) {
    return countChanged
      ? { mode: 'full', newMessages: sorted }
      : { mode: 'current', newMessages: [] };
  }

  // Strictly-newer messages only, and the count moved by exactly that many →
  // nothing was inserted behind us, so the existing summary is a valid base.
  const cleanAppend = !Number.isInteger(company.relationship_summary_msg_count)
    || company.relationship_summary_msg_count + unincluded.length === sorted.length;

  return cleanAppend
    ? { mode: 'incremental', newMessages: unincluded }
    : { mode: 'full', newMessages: sorted };
}

/** Render one message for the prompt. PURE. */
function renderMessage(m) {
  // cc names who ELSE is on the conversation — a colleague looped in is part
  // of the relationship, and a recap that never mentions them reads wrong.
  const who = (m.direction === 'outbound' ? 'Us (Jamie)' : (m.from_email || 'Them'))
    + (m.cc_email ? ` (cc: ${m.cc_email})` : '');
  const date = String(m.sent_at || '').slice(0, 10);
  const body = (m.body_text || '').replace(/\s+/g, ' ').slice(0, BODY_CHARS);
  // A send that bounced never reached them, so the recap must not narrate it as
  // a check-in they received and ignored — that reads as "we chased, they went
  // quiet" when the truth is "they never heard from us". Stated on the line
  // itself rather than as a rule at the top of the prompt, because the model
  // needs it exactly where it is deciding what the message means.
  if (m.direction === 'outbound' && m.undelivered_at) {
    return `[${date}] ${who} (NEVER DELIVERED — bounced, they did not receive this): ${body}`;
  }
  if (m.direction === 'inbound' && m.message_type === 'bounce') {
    return `[${date}] Mail server: our message to them bounced.`;
  }
  return `[${date}] ${who}: ${body}`;
}

/**
 * Build the prompt. PURE — `now` is injected rather than read, so the render
 * stays testable and the date the model sees is the date the caller meant.
 */
function renderSummaryPrompt({ company, messages, mode, now }) {
  const today = now.toISOString().slice(0, 10);
  const lines = [];

  lines.push(`You are maintaining the relationship record for ${company.name}, a ${
    company.relationship_type === 'lgbtq_org' ? 'LGBTQ+ organization partner' : 'retail/wholesale contact'
  } of RUBIES, a gender-affirming underwear and swimwear brand. The owner is Jamie.`);
  lines.push('');
  lines.push(`Today is ${today}.`);
  lines.push('');

  if (mode === 'incremental') {
    lines.push(`EXISTING SUMMARY (covers everything up to ${String(company.relationship_summary_through).slice(0, 10)}):`);
    lines.push(company.relationship_summary);
    lines.push('');
    if (company.relationship_next_step) {
      lines.push(`CURRENT NEXT STEP: ${company.relationship_next_step}`);
      lines.push('');
    }
    lines.push('NEW MESSAGES SINCE THEN (oldest first):');
  } else {
    // Pre-migration prologue is the ONLY relationship knowledge we hold for
    // companies whose history was never imported, so a full rebuild gets to see
    // it — labelled, because it has no reliable date and predates these messages.
    if (company.ai_summary) {
      lines.push('PRE-MIGRATION NOTES (written by an older system before June 2026, from'
        + ' correspondence that may not appear below — treat as background only, and do'
        + ' not repeat its specifics as if they are current):');
      lines.push(company.ai_summary);
      lines.push('');
    }
    lines.push(`CONVERSATION (${messages.length} message${messages.length === 1 ? '' : 's'}, oldest first):`);
  }

  lines.push('');
  lines.push(messages.map(renderMessage).join('\n\n---\n\n'));
  lines.push('');
  lines.push(mode === 'incremental'
    ? 'Rewrite the summary so it covers the whole relationship including these new messages.'
    : 'Write the summary of this relationship.');
  lines.push('');
  lines.push('Rules:');
  // Positive instruction with a verbatim template. The negative form of this rule
  // is what failed in the old implementation: threadBuilder injects today's date
  // too, but 52 of the 54 summaries it produced still say "about 10 months ago",
  // "currently traveling", "scheduled a call for today" — phrasing anchored to a
  // generation date the reader never sees, which then goes silently stale and
  // gets fed to the advisor verbatim.
  lines.push('- Write every date absolutely, in the form "in March 2026" or "on 12 March 2026".'
    + ' A reader six months from now must be able to place every event without knowing when you wrote this.');
  lines.push('- Cover: how the relationship started, what has been agreed, ordered, declined or promised, and where it stands now.');
  lines.push('- Two to four sentences. Plain, factual, no salesmanship.');
  lines.push('- The next step is one specific sentence. Set it to null when the relationship has genuinely concluded.');
  lines.push('- Say only what these messages support. If something is unclear, leave it out rather than inferring it.');

  return lines.join('\n');
}

/** Load a company row plus its full message history, oldest first. */
async function loadCompany(sb, companyId) {
  const { data: company, error } = await sb
    .from('b2b_companies').select('*').eq('id', companyId).maybeSingle();
  if (error) throw new Error(`b2b_companies load: ${error.message}`);
  if (!company) throw new Error(`no such company: ${companyId}`);

  const messages = await fetchAllPaginated(() => sb
    .from('b2b_messages')
    .select('direction, message_type, from_email, cc_email, body_text, sent_at, undelivered_at')
    .eq('company_id', companyId)
    .order('sent_at', { ascending: true }));

  return { company, messages: messages || [] };
}

/**
 * Take the claim for a company. Returns true if THIS caller won it.
 *
 * The claim guards the AI call, not the write. The dashboard and the
 * daily-sync-all cron are separate processes, so the in-memory cooldowns used
 * elsewhere in this directory cannot stop them both paying for the same summary.
 */
async function claimSummary(sb, companyId, now) {
  const stamp = now.toISOString();
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();

  // Two single-filter updates rather than one `.or()`: PostgREST rejects an or()
  // filter on an UPDATE outright ("column ... does not exist", for any column,
  // including ones that have existed for months). Each step is still atomic on
  // its own, which is all the claim needs:
  //
  //   step 1 — WHERE claimed_at IS NULL. Concurrent callers both attempt it and
  //            exactly one gets a row back; the others see 0 because the winner
  //            has already committed a non-null value.
  //   step 2 — WHERE claimed_at < staleBefore. Only reachable if step 1 lost, and
  //            the winner's fresh stamp is never < staleBefore, so a loser cannot
  //            steal a live claim here. This is purely the process-died takeover.
  //
  // Release writes NULL, so step 1 is the normal path and step 2 costs nothing
  // in the common case.
  const fresh = await sb.from('b2b_companies')
    .update({ relationship_summary_claimed_at: stamp })
    .eq('id', companyId).is('relationship_summary_claimed_at', null).select('id');
  if (fresh.error) throw new Error(`claim: ${fresh.error.message}`);
  if ((fresh.data || []).length) return true;

  const takeover = await sb.from('b2b_companies')
    .update({ relationship_summary_claimed_at: stamp })
    .eq('id', companyId).lt('relationship_summary_claimed_at', staleBefore).select('id');
  if (takeover.error) throw new Error(`claim takeover: ${takeover.error.message}`);
  return (takeover.data || []).length > 0;
}

async function releaseSummaryClaim(sb, companyId) {
  // Fail-soft: a failed release self-heals via the TTL takeover above. Throwing
  // here would mask the real error when release runs in a finally after a throw.
  const { error } = await sb.from('b2b_companies')
    .update({ relationship_summary_claimed_at: null }).eq('id', companyId);
  if (error) console.error(`[relationshipSummary] claim release failed for ${companyId}: ${error.message}`);
}

/**
 * Refresh one company's summary if it needs it.
 *
 * @returns {{ status: 'updated'|'current'|'empty'|'busy', mode?: string }}
 */
async function refreshCompanySummary(sb, companyId, { force = false, now = new Date() } = {}) {
  const { company, messages } = await loadCompany(sb, companyId);
  const { mode, newMessages } = summaryMode(company, messages);

  // A company with no imported history gets no summary rather than an invented
  // one. This is the visible half of the parked "queue reasons from empty
  // history" bug: until thread discovery runs on the queue build, plenty of
  // companies genuinely have nothing to summarize, and saying so is correct.
  if (!messages.length) return { status: 'empty' };
  if (mode === 'current' && !force) return { status: 'current' };

  const effectiveMode = force && mode === 'current' ? 'full' : mode;
  const forPrompt = effectiveMode === 'incremental'
    ? newMessages
    : capMessages(messages);

  if (!(await claimSummary(sb, companyId, now))) return { status: 'busy' };

  try {
    const response = await callClaude({
      component: 'b2b_relationship_summary',
      model: MODELS.SONNET,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: renderSummaryPrompt({ company, messages: forPrompt, mode: effectiveMode, now }),
      }],
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      metadata: { company_id: companyId },
    });
    const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const out = JSON.parse(text);

    const newest = messages[messages.length - 1];
    const { error } = await sb.from('b2b_companies').update({
      relationship_summary: out.summary,
      relationship_next_step: out.is_concluded ? null : (out.next_step || null),
      relationship_next_step_owner: out.is_concluded ? null : (out.next_step_owner || null),
      relationship_summary_at: now.toISOString(),
      relationship_summary_through: newest.sent_at,
      relationship_summary_msg_count: messages.length,
    }).eq('id', companyId);
    if (error) throw new Error(`summary write: ${error.message}`);

    return { status: 'updated', mode: effectiveMode, messages: messages.length };
  } finally {
    // Every exit, including a throw. A leaked claim freezes the summary silently
    // for CLAIM_TTL_MS, and a company whose summary never updates looks exactly
    // like a company where nothing has happened.
    await releaseSummaryClaim(sb, companyId);
  }
}

/** First + most recent (cap-1), so the opener survives on long relationships. PURE. */
function capMessages(messages) {
  if (messages.length <= FULL_REBUILD_MESSAGE_CAP) return messages;
  return [messages[0], ...messages.slice(-(FULL_REBUILD_MESSAGE_CAP - 1))];
}

/**
 * Refresh every company whose summary has fallen behind its messages.
 *
 * Runs nightly from daily-sync-all. Deliberately NOT run on panel open:
 * fetchCompanyThreads kicks off Gmail thread discovery in the background, so
 * summarizing in the same request would race it and recap a record whose
 * history is still arriving.
 */
async function sweepStaleSummaries(sb, { limit = 100, now = new Date(), onProgress } = {}) {
  const companies = await fetchAllPaginated(() => sb
    .from('b2b_companies')
    .select('id, relationship_summary_through, relationship_summary_msg_count'));

  // One grouped read rather than a query per company: 242 companies against
  // ~1200 messages is far cheaper to reconcile in memory than 242 round-trips.
  const messages = await fetchAllPaginated(() => sb
    .from('b2b_messages').select('company_id, sent_at'));

  const stats = new Map(); // company_id -> { count, newest }
  for (const m of messages || []) {
    const s = stats.get(m.company_id) || { count: 0, newest: null };
    s.count += 1;
    if (!s.newest || new Date(m.sent_at) > new Date(s.newest)) s.newest = m.sent_at;
    stats.set(m.company_id, s);
  }

  const stale = (companies || []).filter(c => {
    const s = stats.get(c.id);
    if (!s || !s.count) return false;                       // nothing to summarize
    if (!c.relationship_summary_through) return true;       // never summarized
    if (new Date(s.newest) > new Date(c.relationship_summary_through)) return true;
    return c.relationship_summary_msg_count !== s.count;    // backfilled behind the watermark
  });

  const results = { considered: (companies || []).length, stale: stale.length, updated: 0, skipped: 0, failed: 0 };
  for (const c of stale.slice(0, limit)) {
    try {
      const r = await refreshCompanySummary(sb, c.id, { now });
      if (r.status === 'updated') results.updated += 1; else results.skipped += 1;
    } catch (err) {
      results.failed += 1;
      console.error(`[relationshipSummary] ${c.id}: ${err.message}`);
    }
    if (onProgress) onProgress(results);
  }
  // Never let a cap look like completeness — a silently truncated sweep reads as
  // "everything is current" on a panel whose whole job is telling you otherwise.
  if (stale.length > limit) {
    results.deferred = stale.length - limit;
    console.log(`[relationshipSummary] ${results.deferred} stale companies deferred to the next run (limit ${limit})`);
  }
  return results;
}

/** daily-sync-all entry point. Fail-soft: a summary is never worth failing a sync over. */
async function run() {
  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const r = await sweepStaleSummaries(getSupabaseClient(), {});
  console.log(`Relationship Summaries — ${r.updated} updated, ${r.stale} stale of ${r.considered}`
    + `${r.deferred ? `, ${r.deferred} deferred` : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
  return {
    sources: {
      b2b_relationship_summaries: {
        success: r.failed === 0, rowsWritten: r.updated,
        error: r.failed ? `${r.failed} companies failed` : null,
      },
    },
    status: r.failed ? 'error' : 'success',
  };
}

module.exports = {
  run,
  summaryMode,
  renderSummaryPrompt,
  renderMessage,
  capMessages,
  claimSummary,
  releaseSummaryClaim,
  refreshCompanySummary,
  sweepStaleSummaries,
  OUTPUT_SCHEMA,
  CLAIM_TTL_MS,
  FULL_REBUILD_MESSAGE_CAP,
};
