/**
 * queueService.js — shared operations behind the two outreach surfaces
 * (the MCP console tools and the dashboard Outreach panel). Both surfaces
 * are thin wrappers over these functions so they can never drift apart.
 *
 * The panel asks three different questions, and each has a function here:
 *   "what needs action?"    → fetchQueueWithDrafts   (the 6-tier queue)
 *   "what have I claimed?"  → fetchOnMe              (deferred onto Jamie)
 *   "what just happened?"   → fetchActivity          (message-level feed)
 *   "where's that company?" → searchCompanies        (searchable directory)
 *
 *   fetchOutreachQueue       — companies → contexts → assembleQueue
 *   attachDrafts             — pure: join pending-draft id/snippet onto entries
 *   fetchQueueWithDrafts     — the dashboard queue payload
 *   searchCompanies          — directory search across name/email/subject
 *   fetchActivity            — reverse-chronological message feed
 *   setThreadStatus          — open ↔ closed
 *   reopenThread             — reopen a concluded thread + draft the follow-up
 *   generateDraftForCompany  — queue-entry resolution + generateDraft
 *   sendDraftById            — load a pending draft → sendB2bEmail (two-phase,
 *                              gate pass-through); marks the draft sent
 */
const { assembleQueue, deferredSince, replyLandedAfter, replyWaiting, humanAge } = require('./queue');
const { buildContexts } = require('./queueContext');
const { nextScheduledTouch, LADDER_TYPES } = require('./cadence');
const { reconcileThreads, discoverCompanyThreads } = require('./manualSendReconcile');
const { generateDraft, fetchDonationRouting } = require('./outreachAdvisor');
const { sendB2bEmail, resolveRecipient, resolveDelivery, SEND_FLAG, FROM_EMAIL } = require('./sendB2bEmail');
const { defaultReplyCc, computeReplyCc, pickReplyAnchor } = require('./replyCc');
const { isFlagEnabled } = require('../../shared/systemFlags');
const { fetchAllPaginated } = require('../../shared/supabaseClient');

/** One-line preview of a draft body for queue rows. Pure. */
function draftSnippet(body, max = 140) {
  const flat = (body || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Join pending drafts onto queue entries. Pure.
 * @param queue  assembleQueue output
 * @param drafts b2b_drafts rows ({ id, company_id, subject, body, generated_at })
 * @returns entries with `draft: { id, subject, snippet, generated_at } | null`
 */
function attachDrafts(queue, drafts) {
  const byCompany = new Map((drafts || []).map(d => [d.company_id, d]));
  return (queue || []).map(e => {
    const d = byCompany.get(e.company_id);
    return {
      ...e,
      draft: d ? { id: d.id, subject: d.subject, snippet: draftSnippet(d.body), generated_at: d.generated_at } : null,
    };
  });
}

async function fetchCompanies(sb, { channel } = {}) {
  let q = sb.from('b2b_companies').select('*');
  if (channel) q = q.eq('relationship_type', channel);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * How long a due ladder rung may go unscheduled before it stops being machine
 * work and becomes the operator's problem.
 *
 * A rung goes due at the UTC day boundary (businessDaysSince counts whole
 * days) and the draft pass runs once a day in daily-sync-all, so every rung is
 * due for up to half a day before the ladder drafts and schedules it. That
 * half-day used to show in the queue as operator work, with a composer
 * inviting a hand-written chase the engine was about to send itself
 * (2026-09-10). One business day of grace covers the gap; a rung still
 * unscheduled past that means the pass skipped it or did not run, which is
 * exactly what the operator must see.
 */
const LADDER_GRACE_BUSINESS_DAYS = 1;

/**
 * Drop the rows the follow-up ladder is going to handle on its own. Pure.
 *
 * The operator's half of the rule mergePendingDraftEntries applies to
 * scheduled drafts: a decision the machine has already taken is not queue
 * work, but anything removed from an operator queue needs a condition under
 * which it comes back. A rung past its grace returns badged `ladder_stuck`,
 * its reason saying so, rather than presenting itself as fresh work. Rungs the
 * ladder never takes — a company reachable only by contact form — are left in,
 * because those are the operator's from the start.
 *
 * Applied to the operator surfaces only (panel, badge, console queue). The
 * draft pass reads assembleQueue directly and must keep seeing every rung.
 */
function withoutLadderWork(queue) {
  const out = [];
  for (const e of queue || []) {
    if (!LADDER_TYPES.has(e.message_type) || e.delivery !== 'email') { out.push(e); continue; }
    const past = e.business_days_past_due ?? 0;
    if (past < LADDER_GRACE_BUSINESS_DAYS) continue;
    out.push({
      ...e,
      ladder_stuck: true,
      reason: `${e.reason} — due ${past} business day${past === 1 ? '' : 's'} ago and the automatic follow-up has not scheduled it`,
    });
  }
  return out;
}

/** Today's queue: fetch companies (optionally one channel), build contexts, assemble. */
async function fetchOutreachQueue(sb, { channel } = {}) {
  const companies = await fetchCompanies(sb, { channel });
  const contexts = await buildContexts(sb, companies);
  return withoutLadderWork(assembleQueue(companies.map(c => ({ company: c, ctx: contexts.get(c.id) }))));
}

/**
 * How long past its slot a scheduled follow-up may sit unsent before it stops
 * being machine work and becomes the operator's problem.
 *
 * The window a slot is picked inside is two hours wide and the send sweep ticks
 * every fifteen minutes, so six hours cannot be normal lateness — it means a
 * guard is refusing, the daily cap is full, or the sweep is not running. The
 * grace exists only so a draft is not called stuck while its own send is in
 * flight.
 */
const SCHEDULED_STALE_HOURS = 6;

/**
 * Companies with a pending draft are excluded from assembleQueue (the sweep
 * must never double-draft — companyEligible returns false). The dashboard
 * queue must still SHOW them: the pending draft is exactly what the operator
 * needs to review. Synthesize their entries from the draft's stored queue
 * fields (queue_tier/queue_reason captured at generation time) and merge in
 * tier order. Pure.
 *
 * The exception is a draft the follow-up ladder has already scheduled. That one
 * is not review waiting to happen — it goes on its own, in the recipient's
 * mid-morning, and every guard that makes it safe runs at send time rather than
 * here. Showing it as queue work asks for a decision that has already been
 * taken, which is the thing the automatic ladder exists to remove.
 *
 * It is hidden only while it is ON schedule. A scheduled draft still sitting
 * here hours after its slot is the exact shape of the 2026-08-27 outage — three
 * follow-ups held on every tick by a guard that could never pass — and that day
 * the panel was the only place it could have been noticed. So an overdue one
 * comes BACK, saying it is stuck rather than presenting itself as fresh work.
 * Hiding scheduled sends must not also hide scheduled sends that are failing.
 */
function mergePendingDraftEntries(queue, drafts, companiesById, now = new Date()) {
  const inQueue = new Set((queue || []).map(e => e.company_id));
  const staleBefore = new Date(now.getTime() - SCHEDULED_STALE_HOURS * 60 * 60 * 1000);
  const visible = (drafts || []).filter(d => {
    if (!d.scheduled_send_at) return true;
    return new Date(d.scheduled_send_at) <= staleBefore;
  });
  const withDraft = new Set(visible.map(d => d.company_id));
  const synthetic = [];
  for (const d of visible) {
    if (inQueue.has(d.company_id)) continue;
    const c = companiesById.get(d.company_id);
    if (!c) continue;
    // Never resurrect a company whose outreach is deferred. Triage supersedes
    // pending drafts on pause/snooze, so for those this rarely fires — but this
    // merge is what puts a company in the queue WITHOUT consulting the cadence,
    // using the tier and reason frozen on the draft row, and a stale draft
    // arriving by any other path would silently undo the pause. The one thing
    // that must still get through is a genuine Tier-1 reply, and that arrives
    // via `queue` above, so it is already excluded by the inQueue check.
    //
    // For On Me this is not a belt-and-braces check, it is the whole mechanism:
    // that deferral deliberately KEEPS its pending draft, so without this line
    // every company Jamie claimed would be merged straight back into the queue
    // it was claimed out of, at its old tier, and the button would appear to do
    // nothing at all.
    if (deferredSince(c)) continue;
    synthetic.push({
      company_id: d.company_id,
      company_name: c.name,
      channel: c.relationship_type,
      tier: d.queue_tier || 3,
      message_type: d.message_type,
      reason: d.scheduled_send_at
        ? `scheduled to send ${new Date(d.scheduled_send_at).toISOString().slice(0, 16).replace('T', ' ')}Z and still unsent — the automatic send is stuck`
        : d.queue_reason || 'pending draft awaiting review',
      ...(d.scheduled_send_at ? { scheduled_send_at: d.scheduled_send_at, send_stuck: true } : {}),
    });
  }
  return [...(queue || []), ...synthetic].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1 && a.waiting_since && b.waiting_since) return new Date(a.waiting_since) - new Date(b.waiting_since);
    // Ready work first. Synthetic draft entries were appended to the queue and
    // the comparator used to return 0 past this point, so with a stable sort
    // every draft-ready company sank BELOW every empty one in its tier. That is
    // backwards: a draft is one click from sent, an empty row is work not yet
    // started, and burying the finished work under the unstarted work makes the
    // panel read as though the empty rows were the more urgent ones.
    const aReady = withDraft.has(a.company_id) ? 0 : 1;
    const bReady = withDraft.has(b.company_id) ? 0 : 1;
    return aReady - bReady;
  });
}

/**
 * Queue + pending-draft id/snippet per company — the dashboard payload.
 * Returns { entries, gmail_sync }: the queue renders at DB speed while the
 * manual-send reconcile (Gmail) runs in the background; when it was kicked
 * off, the client re-fetches once shortly after so any manual replies that
 * just landed clear their rows.
 */
let queueReconcileInFlight = false;
/**
 * Kick the manual-send reconcile in the background, at most one at a time.
 * Returns 'started' when this call launched it, 'recent' when one was already
 * running. Shared by the queue and the activity feed: BOTH surfaces claim to
 * show current reality, and most outbound mail is sent by hand from Gmail
 * (source='manual_send'), so a surface that doesn't kick this silently
 * under-reports the operator's own recent sends.
 */
function startReconcile(sb, companyIds) {
  if (queueReconcileInFlight) return 'recent';
  queueReconcileInFlight = true;
  reconcileThreads(sb, { companyIds })
    .catch(err => console.error(`[queueService] reconcile failed: ${err.message}`))
    .finally(() => { queueReconcileInFlight = false; });
  return 'started';
}

/**
 * The rows the Outreach panel would show: companies → contexts → assembleQueue
 * → mergePendingDraftEntries, with the pending drafts that fed the merge.
 *
 * Extracted so the panel and the nav badge cannot answer "what's in the queue"
 * differently. The badge is a count of the same list, computed here rather than
 * from anything cheaper — the merge is what puts pending-draft companies in the
 * queue, and a count that reasoned about companies or drafts on its own would
 * disagree with the list it labels the moment either rule changed.
 *
 * `onCompanies` runs as soon as the company set is known, before the slow
 * context build, so a caller can kick background work off it without waiting.
 */
async function buildQueueEntries(sb, { channel, onCompanies } = {}) {
  const companies = await fetchCompanies(sb, { channel });
  if (onCompanies) onCompanies(companies);
  const contexts = await buildContexts(sb, companies);
  const queue = withoutLadderWork(assembleQueue(companies.map(c => ({ company: c, ctx: contexts.get(c.id) }))));

  let drafts = [];
  if (companies.length) {
    const { data, error } = await sb.from('b2b_drafts')
      .select('id, company_id, subject, body, generated_at, message_type, queue_tier, queue_reason, scheduled_send_at')
      .eq('status', 'pending').in('company_id', companies.map(c => c.id));
    if (error) throw new Error(error.message);
    drafts = data || [];
  }
  return {
    entries: mergePendingDraftEntries(queue, drafts, new Map(companies.map(c => [c.id, c]))),
    drafts,
  };
}

async function fetchQueueWithDrafts(sb, { channel } = {}) {
  let gmailSync = 'recent';
  const { entries, drafts } = await buildQueueEntries(sb, {
    channel,
    onCompanies: (companies) => { gmailSync = startReconcile(sb, companies.map(c => c.id)); },
  });
  return { entries: attachDrafts(entries, drafts), gmail_sync: gmailSync };
}

/**
 * How many rows the Outreach panel would show right now — the nav badge.
 * Deliberately skips the Gmail reconcile: this runs off a background poll, and
 * a badge must never trigger outside work.
 */
async function fetchQueueCount(sb, { channel } = {}) {
  const { entries } = await buildQueueEntries(sb, { channel });
  return entries.length;
}

// ── On Me ──────────────────────────────────────────────────────────────────
// The queue answers "what can I do today". Everything in it is meant to be
// actionable now, which makes it useless the moment it fills with things that
// are real but not for right now — you stop reading it, and the genuinely urgent
// row is buried among the ones you have already thought about. On Me is where
// those go: still yours, still counted, still ageing, just not in the way.

/**
 * Companies Jamie has claimed, oldest first. `days_on_you` is the point of the
 * whole surface — this list's failure mode is becoming a graveyard, and an age
 * is the only thing that makes that visible before it happens.
 *
 * Each row carries the relationship summary's suggested next step, which is what
 * tells you what the claim was about. That job first went to a note typed at
 * claim time, and the next step is strictly better at it: it is derived from the
 * conversation and rebuilt as messages land, where a note is written once and
 * then quietly goes out of date on a list whose whole problem is age. It also
 * costs nothing to produce, so claiming stays one click.
 *
 * It is ADVISORY (see relationshipSummary) — a recommendation read off the
 * thread, not a record of why Jamie picked this up, and not something that
 * drives what is due. Rows whose summary has no next step (never summarised, or
 * a concluded relationship) simply carry none; the caller shows the claim date.
 *
 * A company that has replied since the claim IS still here, and is also back in
 * the queue at Tier 1 (2026-08-26). The original rule dropped it from this list
 * on the reasoning that a row cannot be in both without one of them lying about
 * who is holding it — but the two lists answer different questions. The queue
 * asks what is DUE; this one records what Jamie has personally taken on. GSRC
 * replied "Awesome, thanks so much!" three minutes after being claimed, and that
 * retired a claim whose actual subject was the tabling cards he had just
 * promised them. A claim is discharged by DOING the thing, so it is cleared by
 * sending or by Back to queue, and by nothing else — an acknowledgement from the
 * other side is not the work.
 *
 * `replied_since_claim` is what keeps the list honest instead: the row says they
 * have written since, because what you owe them may have just changed and it is
 * the one thing the claim stamp cannot tell you.
 */
async function fetchOnMe(sb, { channel } = {}) {
  // On Me is a query over the commitments list (2026-09-10): the companies with
  // at least one open item Jamie owns, oldest first, each carrying its items.
  // The derived on_me_* columns still exist for the cadence and the badge, but
  // this list reads the rows themselves so it can show WHAT is owed, not just
  // that something is.
  const { companiesOnMe } = require('./commitments');
  const groups = await companiesOnMe(sb, { channel });
  if (!groups.length) return { entries: [] };
  const groupBy = new Map(groups.map(g => [g.company_id, g]));
  const { data: claimed, error } = await sb.from('b2b_companies').select('*').in('id', [...groupBy.keys()]);
  if (error) throw new Error(error.message);
  if (!claimed?.length) return { entries: [] };

  // Full context build rather than a bare inbound lookup: the Tier-1 rule
  // ignores messages on CLOSED threads, so a bare "newest inbound" would badge a
  // row as having replied over a message the queue itself does not count.
  const contexts = await buildContexts(sb, claimed);
  const { data: drafts } = await sb.from('b2b_drafts')
    .select('id, company_id, subject, body, generated_at, message_type, queue_tier, queue_reason')
    .eq('status', 'pending').in('company_id', claimed.map(c => c.id));
  const draftBy = new Map((drafts || []).map(d => [d.company_id, d]));

  const now = new Date();
  const entries = [];
  for (const c of claimed) {
    const ctx = contexts.get(c.id) || {};
    const d = draftBy.get(c.id);
    const g = groupBy.get(c.id);
    const row = {
      company_id: c.id,
      company_name: c.name,
      channel: c.relationship_type,
      on_me_at: g.on_me_at,
      // The items themselves: what you owe them, in reading order.
      commitments: g.items,
      count: g.count,
      next_step: c.relationship_next_step || null,
      // 'them' when the summary judged the ball is in their court. Worth
      // carrying: a next step that reads as an action for us, on a company that
      // is actually waiting on them, would send you off to write a chaser.
      next_step_owner: c.relationship_next_step_owner || null,
      age: humanAge(g.on_me_at, now),
      days_on_you: Math.floor((now - new Date(g.on_me_at)) / 86400000),
      // Did the CADENCE hand this over, or did Jamie pick it up? An engine
      // hand-off is a different thing to read: nobody has looked at it yet, and
      // the note says why the engine gave up. Blurring the two would make the
      // list stop meaning "things I have taken on".
      claimed_by: g.claimed_by,
      claim_note: g.claim_note,
      last_inbound_at: ctx.lastInboundAt || null,
      // They have written since you claimed it, so this company is ALSO sitting
      // in the queue at Tier 1. Not a reason to drop the row — a reason to read
      // the reply before acting on what you thought you owed them.
      replied_since_claim: replyLandedAfter(ctx, g.on_me_at),
      draft: d ? { id: d.id, subject: d.subject, snippet: draftSnippet(d.body), generated_at: d.generated_at } : null,
    };
    entries.push(row);
  }

  entries.sort((a, b) => String(a.on_me_at).localeCompare(String(b.on_me_at)));
  return { entries };
}

// ── Directory search ───────────────────────────────────────────────────────
// The queue only ever surfaces what is DUE. Everything else — the company you
// spoke to in March, the prospect you never wrote to — was unreachable from the
// panel. These functions are the browse half.

/**
 * Strip characters that would break a PostgREST `.or()` filter string. Pure.
 * Commas separate conditions and parens group them, so a raw search term
 * containing either corrupts the query rather than failing loudly. `*` is
 * PostgREST's ilike wildcard and `\`/`"` escape its values. None of these carry
 * meaning in a company name or an email address, so dropping them is lossless
 * in practice and keeps the filter injection-free.
 */
function sanitizeSearchTerm(q) {
  return String(q || '').replace(/[,()"\\*%]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Per-company thread rollup: counts + latest activity. Pure. */
function rollupThreads(threads) {
  const by = new Map();
  for (const t of threads || []) {
    const r = by.get(t.company_id) || { open: 0, closed: 0, last_message_at: null };
    if (t.status === 'closed') r.closed++; else r.open++;
    if (t.last_message_at && (!r.last_message_at || t.last_message_at > r.last_message_at)) {
      r.last_message_at = t.last_message_at;
    }
    by.set(t.company_id, r);
  }
  return by;
}

/**
 * The company's conversation state, which is what the directory filters on.
 * Pure. 'never' = no thread on record (a prospect we have not written to),
 * 'open' = at least one live thread, 'inactive' = every thread concluded.
 */
function companyThreadStatus(rollup) {
  if (!rollup || (!rollup.open && !rollup.closed)) return 'never';
  return rollup.open > 0 ? 'open' : 'inactive';
}

/**
 * Where a company sits in the relationship flow. Pure — and deliberately
 * INDEPENDENT of conversation state, which is its own filter.
 *
 * Folding the two together was a mistake worth recording: an active retailer
 * with thirteen concluded threads is both "an account" and "gone quiet", and
 * collapsing them into one chip hid it under `active` — exactly the company the
 * closed-thread view exists to surface. Kept separate, the two compose, and
 * "active accounts whose conversations have all ended" is one click.
 *
 * 'lead' covers in_contact and null. relationship_state cannot distinguish a
 * real lead from an untouched import — 180 companies carry 'in_contact' and 172
 * have never had a conversation — so as a RELATIONSHIP stage "lead" is the
 * honest label, and the conversation filter says whether anyone has written.
 *
 * Nothing ever writes 'dormant' (syncB2bCompanyState says so explicitly), so
 * there is no dormant stage — it would always be empty.
 */
function companyStage(company) {
  if (company.relationship_state === 'lost') return 'lost';
  if (company.relationship_state === 'active') return 'active';
  return 'lead';
}

const DIRECTORY_STAGES = ['all', 'active', 'lead', 'lost'];
const DIRECTORY_STATUSES = ['all', 'open', 'inactive', 'never'];

/**
 * Why this company matched the search — shown on the row. Pure.
 * Searching an email address is useless if the result only echoes the company
 * name back: the operator needs to see WHICH contact carried that address.
 */
function matchReason(company, contacts, threads, q) {
  const needle = (q || '').toLowerCase();
  if (!needle) return null;
  const has = (v) => v && String(v).toLowerCase().includes(needle);
  if (has(company.name)) return null; // the name is already the row title
  const contact = (contacts || []).find(c => has(c.email) || has(c.full_name));
  if (contact) return `contact: ${contact.full_name ? `${contact.full_name} <${contact.email}>` : contact.email}`;
  if (has(company.general_email)) return `email: ${company.general_email}`;
  if (has(company.website)) return `site: ${String(company.website).replace(/^https?:\/\/(www\.)?/, '')}`;
  const thread = (threads || []).find(t => has(t.subject));
  if (thread) return `thread: ${thread.subject}`;
  if (has(company.id)) return `id: ${company.id}`;
  return null;
}

/**
 * Framing for a draft the operator asked for out of the blue (a company picked
 * from the directory with nothing due). Without it the advisor falls back to
 * "they are waiting on a reply from us" — false here, and it shows in the copy.
 */
const OPERATOR_INITIATED_HINT = 'Jamie has picked this company out deliberately — nothing is due on the cadence. Read the relationship history and write the message that actually makes sense to send them right now. They are NOT waiting on a reply from us, so do not write as though they are.';

/**
 * Searchable company directory — the panel's "where's that company?" surface.
 *
 * `q` matches company name / id / website / general email, contact email and
 * name, and thread subject. Matching spans three tables, which PostgREST
 * cannot express as one OR, so the id sets are gathered in parallel and merged.
 *
 * `stage` (relationship: active/lead/lost) and `status` (conversation:
 * open/inactive/never) are independent and compose.
 *
 * Sorted by last activity (newest first, never-contacted last), so with no
 * query it reads as a recency-ordered archive. The default is deliberately
 * 'all': this surface exists for LOOKUP, and defaulting to a stage would mean
 * searching a cold prospect returns nothing while the company sits right
 * there. For the same reason the caller is expected to drop back to 'all' when
 * a search term is typed.
 */
async function searchCompanies(sb, { q, stage = 'all', status = 'all', channel, limit = 50 } = {}) {
  const term = sanitizeSearchTerm(q);
  const like = `%${term}%`;

  let matchedIds = null; // null = no query, take everything
  if (term) {
    const [companyRes, contactRes, threadRes] = await Promise.all([
      sb.from('b2b_companies').select('id')
        .or(`name.ilike.${like},id.ilike.${like},website.ilike.${like},general_email.ilike.${like}`),
      sb.from('b2b_contacts').select('company_id').or(`email.ilike.${like},full_name.ilike.${like}`),
      sb.from('b2b_threads').select('company_id').ilike('subject', like),
    ]);
    if (companyRes.error) throw new Error(companyRes.error.message);
    matchedIds = new Set([
      ...(companyRes.data || []).map(r => r.id),
      ...(contactRes.error ? [] : (contactRes.data || []).map(r => r.company_id)),
      ...(threadRes.error ? [] : (threadRes.data || []).map(r => r.company_id)),
    ]);
    if (!matchedIds.size) return { companies: [], total: 0, query: term };
  }

  let cq = sb.from('b2b_companies')
    .select('id, name, relationship_type, relationship_state, website, general_email, city, region, country, order_count, total_sales, last_order_date, next_action_date, snoozed_until, snoozed_at, outreach_paused_at, outreach_paused_reason, on_me_at, relationship_summary, relationship_next_step, relationship_summary_at');
  if (channel) cq = cq.eq('relationship_type', channel);
  if (matchedIds) cq = cq.in('id', [...matchedIds]);
  const { data: companies, error } = await cq;
  if (error) throw new Error(error.message);
  if (!companies?.length) return { companies: [], total: 0, query: term };

  const ids = companies.map(c => c.id);
  const [threadsRes, contactsRes, draftsRes] = await Promise.all([
    sb.from('b2b_threads').select('id, company_id, status, subject, last_message_at').in('company_id', ids),
    sb.from('b2b_contacts').select('company_id, email, full_name, is_primary').in('company_id', ids).eq('is_active', true),
    sb.from('b2b_drafts').select('id, company_id').eq('status', 'pending').in('company_id', ids),
  ]);
  const threads = threadsRes.error ? [] : (threadsRes.data || []);
  const contacts = contactsRes.error ? [] : (contactsRes.data || []);
  const pending = new Set(draftsRes.error ? [] : (draftsRes.data || []).map(d => d.company_id));

  const rollups = rollupThreads(threads);
  const contactsBy = new Map();
  for (const c of contacts) contactsBy.set(c.company_id, [...(contactsBy.get(c.company_id) || []), c]);
  const threadsBy = new Map();
  for (const t of threads) threadsBy.set(t.company_id, [...(threadsBy.get(t.company_id) || []), t]);

  let rows = companies.map(c => {
    const rollup = rollups.get(c.id) || { open: 0, closed: 0, last_message_at: null };
    return {
      ...c,
      stage: companyStage(c),
      thread_status: companyThreadStatus(rollup),
      threads_open: rollup.open,
      threads_closed: rollup.closed,
      last_message_at: rollup.last_message_at,
      has_pending_draft: pending.has(c.id),
      contact_count: (contactsBy.get(c.id) || []).length,
      matched_on: matchReason(c, contactsBy.get(c.id), threadsBy.get(c.id), term),
    };
  });

  // Two independent axes, composed: stage = the relationship, status = the
  // conversation. "active + inactive" is the live account that has gone quiet.
  if (stage && stage !== 'all') rows = rows.filter(r => r.stage === stage);
  if (status && status !== 'all') rows = rows.filter(r => r.thread_status === status);

  rows.sort((a, b) => {
    if (!a.last_message_at && !b.last_message_at) return (a.name || '').localeCompare(b.name || '');
    if (!a.last_message_at) return 1;
    if (!b.last_message_at) return -1;
    return b.last_message_at.localeCompare(a.last_message_at);
  });

  return { companies: rows.slice(0, limit), total: rows.length, query: term };
}

// ── Activity feed ──────────────────────────────────────────────────────────

/**
 * Reverse-chronological message feed across every company — "what went out
 * recently?", which the company directory answers badly (one row per company
 * collapses a day's sends, and hides which way each message went).
 *
 * `before` is a sent_at cursor for paging. Kicks the same background reconcile
 * as the queue, and reports it, so the feed can say it is still catching up
 * rather than presenting a stale tail as complete.
 */
async function fetchActivity(sb, { direction, channel, limit = 50, before } = {}) {
  let companyFilter = null;
  if (channel) {
    const { data, error } = await sb.from('b2b_companies').select('id').eq('relationship_type', channel);
    if (error) throw new Error(error.message);
    companyFilter = (data || []).map(c => c.id);
    if (!companyFilter.length) return { messages: [], gmail_sync: 'skipped' };
  }

  let q = sb.from('b2b_messages')
    // Messages carry no subject of their own — it lives on the thread.
    .select('id, company_id, thread_id, direction, message_type, source, body_text, from_email, to_email, cc_email, sent_at')
    .order('sent_at', { ascending: false })
    .limit(Math.min(limit, 200));
  if (direction) q = q.eq('direction', direction);
  if (companyFilter) q = q.in('company_id', companyFilter);
  if (before) q = q.lt('sent_at', before);
  const { data: messages, error } = await q;
  if (error) throw new Error(error.message);
  if (!messages?.length) return { messages: [], gmail_sync: 'recent' };

  const ids = [...new Set(messages.map(m => m.company_id).filter(Boolean))];
  const [companiesRes, threadsRes] = await Promise.all([
    sb.from('b2b_companies').select('id, name, relationship_type, relationship_state').in('id', ids),
    sb.from('b2b_threads').select('id, subject, status').in('id', [...new Set(messages.map(m => m.thread_id).filter(Boolean))]),
  ]);
  const companyBy = new Map((companiesRes.error ? [] : companiesRes.data || []).map(c => [c.id, c]));
  const threadBy = new Map((threadsRes.error ? [] : threadsRes.data || []).map(t => [t.id, t]));

  const rows = messages.map(m => {
    const c = companyBy.get(m.company_id);
    const t = threadBy.get(m.thread_id);
    return {
      ...m,
      company_name: c?.name || m.company_id,
      channel: c?.relationship_type || null,
      thread_subject: t?.subject || null,
      thread_status: t?.status || null,
      snippet: draftSnippet(m.body_text, 160),
    };
  });

  return {
    messages: rows,
    next_before: rows.length >= Math.min(limit, 200) ? rows[rows.length - 1].sent_at : null,
    gmail_sync: startReconcile(sb, ids),
  };
}

// ── Thread status ──────────────────────────────────────────────────────────

/**
 * Flip a thread between 'open' and 'closed'.
 *
 * Status is load-bearing in exactly one place: queueContext ignores inbound
 * messages on CLOSED threads, so a closed conversation can never put its
 * company back in Tier 1. Closing is therefore how the operator says "this one
 * is concluded, stop counting it"; reopening puts it back in play.
 */
async function setThreadStatus(sb, { thread_id, status } = {}) {
  if (!thread_id) throw new Error('thread_id required');
  if (status !== 'open' && status !== 'closed') throw new Error(`status must be 'open' or 'closed' (got '${status}')`);
  const { data, error } = await sb.from('b2b_threads')
    .update({ status }).eq('id', thread_id)
    .select('id, company_id, subject, status, last_message_at').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`thread #${thread_id} not found`);
  // "Nothing to reply to" closes the conversation without a send, so it is the
  // third place a date they stated takes effect (with the send tool and the
  // manual-reply reconcile). The cadence still comes round on its own schedule
  // when they named nothing.
  if (status === 'closed' && data.company_id) await applyStatedNextTouch(sb, data.company_id);
  return data;
}

/**
 * A conversation has just been closed without a send: if they named a date for
 * the next contact, make it the next-action date now. Shared by every close
 * path that is not a send — the operator's "Nothing to reply to" above and the
 * thank-you closer in gmailPush — so a partner's "thanks, talk in November"
 * lands on the calendar whichever of them closed the thread. Idempotent.
 *
 * @returns {{ applied: string|null }} the date written, or null
 */
async function applyStatedNextTouch(sb, companyId, now = new Date()) {
  const { statedNextTouch } = require('./cadence');
  const { data: c } = await sb.from('b2b_companies')
    .select('id, metadata, next_action_date').eq('id', companyId).maybeSingle();
  const stated = c ? statedNextTouch(c, now) : null;
  if (!stated || String(c.next_action_date || '').slice(0, 10) === stated.date) return { applied: null };
  await sb.from('b2b_companies').update({ next_action_date: stated.date, updated_at: now.toISOString() }).eq('id', c.id);
  return { applied: stated.date };
}

/**
 * Reopen a concluded thread and draft the follow-up on it.
 *
 * Threading matters: without the thread_id the follow-up leaves as a brand-new
 * email and the recipient loses the conversation it belongs to. The advisor is
 * told plainly that this is an operator-initiated revival — the default
 * no-message_type framing is "they are waiting on a reply from us", which is
 * false here and would produce a reply to a message that never came.
 *
 * Returns { thread, draft }. A company that already has a pending draft keeps
 * it (one-pending-per-company is a unique index) and `draft` comes back null
 * with `existing_draft_id` set, so the caller can just open it.
 */
async function reopenThread(sb, { thread_id } = {}) {
  // Reopening is a status flip and nothing else (2026-09-09). It used to write
  // an Opus follow-up into the thread, which the initiate-vs-continue rule
  // (2026-09-02) already ruled out: anything continuing a conversation is
  // operator-written. The composer now targets the reopened thread on its own
  // (queue entries carry the newest open thread), so a reply lands inside it
  // and inherits its subject.
  const thread = await setThreadStatus(sb, { thread_id, status: 'open' });
  const { data: existing, error } = await sb.from('b2b_drafts')
    .select('id').eq('company_id', thread.company_id).eq('status', 'pending').maybeSingle();
  if (error) throw new Error(error.message);
  return { thread, draft: null, existing_draft_id: existing?.id || null };
}

/**
 * Resolve the company's current queue entry and generate (or regenerate with
 * steer) its draft. Falls back to a forced message_type when nothing is due.
 * Returns generateDraft's result, or null when nothing is due and no
 * message_type was forced.
 *
 * `thread_id` / `task_hint` / `reason` / `force` are the operator-initiated
 * path (a reopened thread, a directory row with nothing due): they pin the
 * draft to an existing conversation and tell the advisor why it is being
 * asked. `task_hint` only reaches the prompt when there is no message_type —
 * a typed cadence message already carries its own locked framing.
 */
async function generateDraftForCompany(sb, { company_id, steer, message_type, thread_id, task_hint, reason, force, variant_id } = {}) {
  const { data: company, error } = await sb.from('b2b_companies').select('*').eq('id', company_id).maybeSingle();
  if (error || !company) throw new Error(error?.message || `company '${company_id}' not found`);

  const contexts = await buildContexts(sb, [company]);
  let [entry] = assembleQueue([{ company, ctx: { ...contexts.get(company.id), hasPendingDraft: false } }]);
  // Nothing due is not a refusal when the operator asked: reopening a thread or
  // picking a company out of the directory IS the trigger. Cadence only decides
  // what we reach out about unprompted.
  if (!entry && (message_type || thread_id || task_hint || force)) {
    entry = {
      tier: 3,
      message_type: message_type || null,
      reason: reason || 'operator-requested draft',
      task_hint: task_hint || OPERATOR_INITIATED_HINT,
      company_id: company.id,
    };
  }
  if (!entry) return null;
  // The operator's explicit target wins over whatever cadence inferred.
  if (thread_id) entry = { ...entry, thread_id };
  if (task_hint) entry = { ...entry, task_hint };
  if (reason) entry = { ...entry, reason };
  // message_type was only ever a fallback for "nothing due", so forcing a type
  // on a company that DID have something due was silently ignored — and the
  // type is not cosmetic: it sets next_action_date and drives the follow-up
  // ladder. An explicit type is an instruction, not a suggestion.
  if (message_type) entry = { ...entry, message_type, forced_message_type: true };

  // A follow-up rung is fixed text, never a draft to reason about (2026-09-08):
  // the ladder auto-sends, and nothing that auto-sends is model-written.
  // Routed here so the nightly pass, the panel's Draft button and the console
  // tool all land on the template. Lazy require: messageTemplates requires
  // this module back.
  const { FOLLOW_UP_TYPES, composeFollowUp, isRetailerSamplesReApproach, composeRetailerReApproach } = require('./messageTemplates');
  if (FOLLOW_UP_TYPES.has(entry.message_type)) return composeFollowUp(sb, { company_id: company.id, entry });

  // A/B subject assignment for every initiating type that carries one, decided
  // here so the nightly pass, the panel's Draft button and the console tool all
  // rotate the same way (it used to live in draftAllDue alone, so a panel draft
  // of an org intro had no variant and a model-written subject).
  if (!variant_id) variant_id = await assignVariant(sb, { company, entry });

  // The sampled-retailer re-approach is fixed text (2026-09-09), never a draft.
  if (isRetailerSamplesReApproach(company, entry)) return composeRetailerReApproach(sb, { company_id: company.id, entry, variant_id });

  const d = await generateDraft({ company_id: company.id, queueEntry: entry, steer, variant_id });
  return d ? { ...d, variant_id: variant_id || null } : d;
}

/**
 * Which A/B variant this draft gets, or null when the type has none, the
 * company is referred (the referral belongs in the subject — the model writes
 * it), or the entry is a re_approach that is not the sampled-retailer template
 * (an org re_approach has a model-written subject about the old thread). Counts
 * every draft of the type regardless of status: a dismissed or superseded
 * intro already spent its slot in the rotation.
 */
async function assignVariant(sb, { company, entry } = {}) {
  const { variantsFor, pickVariant } = require('./fixedSubjects');
  const { isReferred } = require('./outreachAdvisor');
  const { isRetailerSamplesReApproach } = require('./messageTemplates');
  const type = entry?.message_type;
  const variants = variantsFor(type);
  if (!variants.length || isReferred(company)) return null;
  if (type === 're_approach' && !isRetailerSamplesReApproach(company, entry)) return null;
  const rows = await fetchAllPaginated(() => sb.from('b2b_drafts')
    .select('variant_id').eq('message_type', type).in('variant_id', variants));
  const counts = {};
  for (const r of rows) counts[r.variant_id] = (counts[r.variant_id] || 0) + 1;
  return pickVariant(type, counts);
}

/**
 * Which queue entries would "draft everything due" actually draft? Rows already
 * holding a pending draft are done (that includes every synthetic
 * mergePendingDraftEntries row, which exists BECAUSE of its draft), and a stuck
 * scheduled send needs unsticking, not a second draft on top of the one that
 * cannot leave.
 */
function isDraftableEntry(e) {
  return !!e && !e.draft && !e.send_stuck;
}

/**
 * Generate drafts for every queue entry that lacks one — the nightly
 * initiating-drafts pass (daily-sync-all) and the b2b_draft console tool's
 * all_due mode. `types` restricts to specific message types: production passes
 * always send INITIATING_TYPES, because continuations (Tier-1 replies) are
 * operator-written by decision (2026-09-02) and must never be batch-drafted.
 *
 * Sequential on purpose: each draft is a model call, and parallel calls can't
 * share a prompt cache (see the claim-before-the-expensive-work rule). A
 * per-company failure is recorded and the loop continues — one org with a
 * broken record must not hold up the other seven drafts.
 */
async function draftAllDue(sb, { channel, types, limit, onProgress } = {}) {
  const { entries, drafts } = await buildQueueEntries(sb, { channel });
  let targets = attachDrafts(entries, drafts).filter(isDraftableEntry);
  if (types) targets = targets.filter(e => types.includes(e.message_type));
  if (limit) targets = targets.slice(0, limit);

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const e = targets[i];
    if (onProgress) onProgress({ index: i, total: targets.length, company_id: e.company_id, company_name: e.company_name });
    try {
      // Variant assignment happens inside generateDraftForCompany (one small
      // count query per draft; the loop is sequential so rotation holds).
      const d = await generateDraftForCompany(sb, { company_id: e.company_id });
      results.push(d
        ? { company_id: e.company_id, company_name: e.company_name, ok: true, draft_id: d.draft_id, ...(d.variant_id ? { variant_id: d.variant_id } : {}) }
        : { company_id: e.company_id, company_name: e.company_name, ok: false, error: 'nothing due by draft time' });
    } catch (err) {
      results.push({ company_id: e.company_id, company_name: e.company_name, ok: false, error: err.message });
    }
  }
  return { total: targets.length, results };
}

/**
 * Store an email the OPERATOR wrote, as a pending draft, so it sends through
 * exactly the same path as an AI draft.
 *
 * The empty state is the panel's front door, not an edge case: drafts are
 * generated on demand, so every company starts with no draft and returns to
 * none after each send. Requiring a ~$0.07 Opus call before you can type a
 * two-line reply you already know the words to is backwards. This gives the
 * box something to attach to, and keeps ONE send path (thread bookkeeping,
 * cadence dates, b2b_messages) rather than a second one that would drift.
 *
 * `advisor: null` is the training signal that matters: it distinguishes "Jamie
 * wrote this himself" from "Jamie edited the AI's draft", which a bare
 * operator_edited boolean cannot.
 */
function composeDraftRow({ company_id, body, subject, message_type, thread_id, entry } = {}) {
  if (!company_id) throw new Error('company_id required');
  if (!body || !body.trim()) throw new Error('body required — nothing to send');
  return {
    company_id,
    // Inherit the thread so a hand-written reply lands in the conversation
    // rather than starting a detached one. An EXPLICIT null is the one caller
    // (the waiting-in-room nudge) saying "a fresh email, on purpose": a note
    // that has to be read mid-meeting needs its own subject line, not "Re:".
    thread_id: thread_id === null ? null : (thread_id || entry?.thread_id || null),
    // Cadence keys off message_type for next_action_date and the follow-up
    // ladder, so a hand-written message adopts whatever the queue says is due
    // here. Neutral fallback when nothing is (reaching out unprompted).
    message_type: message_type || entry?.message_type || 'operator_message',
    subject: subject?.trim() || null,
    body: body.trim(),
    structured: {},
    queue_tier: entry?.tier || null,
    queue_reason: entry?.reason || 'written by the operator',
    // The training signal: null advisor means a human wrote it from scratch,
    // which a bare operator_edited boolean could never distinguish from an
    // edited AI draft.
    advisor: null,
    operator_steer: null,
  };
}

/**
 * Persist what the operator is typing, before they send it.
 *
 * Composing only ever ran at send time, so a message written in the panel lived
 * purely in a textarea: close the tab, hit refresh, or lose the browser, and the
 * words were gone with nothing to recover. The draft table already models this
 * exactly — an operator draft is a pending row with `advisor: null` — it simply
 * was not being written until the last possible moment.
 *
 * Updates the operator's existing pending row in place rather than
 * supersede-and-insert, so typing produces one row per message and not one per
 * pause in typing.
 *
 * Deliberately refuses to touch an ADVISOR draft. On those rows `subject`/`body`
 * are the AI's originals and the pair with `sent_subject`/`sent_body` IS the
 * edit record — the training signal for where the advisor's judgment is weak.
 * Autosaving edits over the original would quietly destroy that, so in-progress
 * edits to an AI draft are still send-time only (noted in domain memory).
 *
 * @returns {{ draft_id, saved: boolean, reason?: string }}
 */
async function saveOperatorDraft(sb, { company_id, body, subject, to, cc, completes_commitment_id } = {}) {
  if (!company_id) throw new Error('company_id required');
  const text = (body || '').trim();
  // The commitment this message settles, kept on the row (structured is
  // operator state). undefined leaves it alone; null clears it.
  const structuredPatch = completes_commitment_id === undefined ? null
    : { completes_commitment_id: completes_commitment_id ? Number(completes_commitment_id) : null };

  const { data: pending, error: pErr } = await sb.from('b2b_drafts')
    .select('id, advisor, structured').eq('company_id', company_id).eq('status', 'pending').maybeSingle();
  if (pErr) throw new Error(pErr.message);

  if (pending && pending.advisor) {
    return { draft_id: pending.id, saved: false, reason: 'advisor_draft' };
  }

  // Emptying the box is a deletion, not a save of "". Leaving a blank pending
  // row behind would put the company back in the queue advertising a draft with
  // nothing in it.
  if (!text) {
    if (pending) {
      await sb.from('b2b_drafts').update({ status: 'dismissed' }).eq('id', pending.id);
      return { draft_id: null, saved: true, cleared: true };
    }
    return { draft_id: null, saved: true, cleared: false };
  }

  if (pending) {
    const patch = { body: text, subject: subject?.trim() || null };
    // A To/Cc typed into the empty composer rides the autosave (there is no row
    // to POST it to until this creates one), and so does the commitment this
    // message settles. Both only when actually touched: a keystroke must never
    // rewrite structured, which also holds the attachments.
    if (to !== undefined || cc !== undefined || structuredPatch) {
      patch.structured = {
        ...mergeRecipients(pending.structured, { to, cc }),
        ...(structuredPatch || {}),
      };
    }
    const { error } = await sb.from('b2b_drafts').update(patch).eq('id', pending.id);
    if (error) throw new Error(`draft autosave: ${error.message}`);
    return { draft_id: pending.id, saved: true };
  }

  const { draft_id } = await composeDraft(sb, { company_id, body: text, subject, to, cc });
  if (structuredPatch && structuredPatch.completes_commitment_id) {
    const { data: fresh } = await sb.from('b2b_drafts').select('structured').eq('id', draft_id).maybeSingle();
    await sb.from('b2b_drafts').update({ structured: { ...(fresh?.structured || {}), ...structuredPatch } }).eq('id', draft_id);
  }
  return { draft_id, saved: true, created: true };
}

async function composeDraft(sb, { company_id, body, subject, message_type, thread_id, to, cc } = {}) {
  if (!company_id) throw new Error('company_id required');
  if (!body || !body.trim()) throw new Error('body required — nothing to send');

  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('*').eq('id', company_id).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!company) throw new Error(`company '${company_id}' not found`);

  const contexts = await buildContexts(sb, [company]);
  const ctx = contexts.get(company.id) || {};
  const [queued] = assembleQueue([{ company, ctx: { ...ctx, hasPendingDraft: false } }]);
  const entry = composeInheritEntry(queued, ctx);
  const draftRow = composeDraftRow({ company_id, body, subject, message_type, thread_id, entry });

  // Recipients the operator already decided on (typed before this row existed)
  // win outright, and an explicit empty cc is "cc nobody". Otherwise a
  // hand-written reply into a thread starts with reply-all cc, same as an
  // advisor draft: whoever the contact kept on the conversation stays on it,
  // visible in the panel's Cc field where the operator can clear it.
  if (to !== undefined || cc !== undefined) draftRow.structured = mergeRecipients(draftRow.structured, { to, cc });
  if (cc === undefined && draftRow.thread_id) {
    const ccDefault = await defaultReplyCc(sb, { thread_id: draftRow.thread_id, our_email: FROM_EMAIL });
    if (ccDefault) draftRow.structured = { ...draftRow.structured, cc: ccDefault };
  }

  await sb.from('b2b_drafts').update({ status: 'superseded' })
    .eq('company_id', company_id).eq('status', 'pending');

  const { data: row, error } = await sb.from('b2b_drafts').insert(draftRow).select('id').single();
  if (error) throw new Error(`b2b_drafts insert: ${error.message}`);

  return { draft_id: row.id, company_id, message_type: draftRow.message_type };
}

/**
 * Two-phase send of a stored draft. Phase 1 returns sendB2bEmail's preview
 * plus `gate_enabled` (the b2b_send_enabled flag state, so the UI can show
 * the gate plainly before confirming). Phase 2 passes through preview/
 * blocked/sent; on 'sent' the draft row is marked sent.
 *
 * `body` and `subject` optionally override the stored draft (the operator
 * edited them in the panel). The AI's originals stay in b2b_drafts — the sent
 * text lives on the b2b_messages row — and operator_edited is set when either
 * differs, which is the edit-rate training signal.
 *
 * A blank subject override is NOT an empty subject: it falls back to the
 * draft's, and a reply whose draft subject is null still inherits the thread
 * subject downstream in sendB2bEmail.
 *
 * `thread_id`, `message_type`, `cc` and `invite_created` exist for scheduleMeeting,
 * which sends the operator's composed text as a meeting confirmation on the
 * thread the panel had open. They override the draft rather than replacing this
 * function's job: consuming the draft row is the point, so that everything else
 * living on it (attachments, To/Cc, next_touch_days, the sent_body edit signal)
 * still applies to a booked reply.
 */
async function sendDraftById(sb, {
  draft_id, confirmed, body, subject, test_send,
  thread_id, message_type, cc, invite_created, completes_commitment_id,
} = {}) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts').select('*').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be sent`);

  const sendBody = (typeof body === 'string' && body.trim()) ? body : draft.body;
  const sendSubject = (typeof subject === 'string' && subject.trim()) ? subject.trim() : draft.subject;
  const edited = sendBody !== draft.body || sendSubject !== draft.subject;

  // Resolved at SEND time, not when the operator attached it: generation is
  // deterministic, so a fresh render can never be stale, and a body promising
  // "I have attached the agreement" can never go out without one — an unknown
  // spec throws here rather than sending a broken promise.
  const { resolveDraftAttachments } = require('./draftAttachments');
  const attachments = await resolveDraftAttachments(sb, draft);

  const res = await sendB2bEmail({
    company_id: draft.company_id,
    thread_id: thread_id || draft.thread_id || undefined,
    message_type: message_type || draft.message_type,
    variant_id: draft.variant_id || undefined,
    subject: sendSubject || undefined,
    body: sendBody,
    confirmed: !!confirmed,
    next_touch_days: draft.structured?.next_touch_days ?? null,
    attachments,
    // The draft governs cc. A draft with no structured.cc means the operator
    // cleared (or never had) one — pass explicit-empty so sendB2bEmail does NOT
    // apply its reply-all default over the operator's decision. The default was
    // already stamped onto structured.cc when the draft was created.
    cc: cc ?? draft.structured?.cc ?? '',
    to_override: draft.structured?.to ?? undefined,
    test_send: !!test_send,
    invite_created: !!invite_created,
    // "Done, write to them": the commitment this composer was opened from,
    // completed by this send and linked to the message it went out in.
    completes_commitment_id: completes_commitment_id ?? draft.structured?.completes_commitment_id ?? null,
  });

  if (res.phase === 'preview') {
    res.gate_enabled = await isFlagEnabled(SEND_FLAG);
  }
  // A test send leaves the draft pending on purpose — it is a look, not a send.
  if (res.phase === 'test_sent') return { ...res, draft_id };
  if (res.phase === 'sent') {
    // Store what actually went out alongside the AI's original. The boolean
    // says THAT it was edited; this pair says HOW, which is the only form a
    // later accuracy pass can learn from. sendSubject/sendBody are the
    // operator's text, deliberately pre-signature-normalization — that
    // transform is ours, and folding it in here would read as an operator
    // edit that never happened.
    const { error: uErr } = await sb.from('b2b_drafts')
      .update({
        status: 'sent', sent_at: res.sent_at, operator_edited: edited,
        sent_subject: sendSubject || null, sent_body: sendBody,
      })
      .eq('id', draft_id);
    if (uErr) console.error(`[queueService] draft #${draft_id} sent but status update failed: ${uErr.message}`);
  }
  return { ...res, draft_id };
}

/**
 * Merge a fact-verification toggle into a draft's structured payload. Pure.
 * structured.facts_verified is a sorted array of verified fact indices.
 */
function mergeFactVerification(structured, index, verified) {
  const s = structured || {};
  const set = new Set(Array.isArray(s.facts_verified) ? s.facts_verified : []);
  if (verified) set.add(index); else set.delete(index);
  return { ...s, facts_verified: [...set].sort((a, b) => a - b) };
}

/**
 * Recipient overrides merged into a draft's `structured`. `undefined` leaves a
 * field alone; an empty string clears it (To falls back to the resolved
 * contact, Cc means cc nobody). Pure.
 */
function mergeRecipients(structured, { to, cc } = {}) {
  const out = { ...(structured || {}) };
  if (to !== undefined) { if (String(to).trim()) out.to = String(to).trim(); else delete out.to; }
  if (cc !== undefined) { if (String(cc).trim()) out.cc = String(cc).trim(); else delete out.cc; }
  return out;
}

/**
 * The queue entry a hand-written message inherits its thread from.
 *
 * A deferred company (On Me, paused, snoozed) has no queue entry — that is what
 * deferring means — but a reply they are waiting on still belongs in the thread
 * they wrote in. Without this, claiming a Tier-1 row On Me and then answering
 * it from the panel sent the answer as a brand-new email, with no thread and no
 * cc, which is the opposite of what a claim is for. Same predicate as Tier 1
 * without the deferral gate; the entry, when there is one, always wins. Pure.
 */
function composeInheritEntry(entry, ctx) {
  if (entry) return entry;
  if (replyWaiting(ctx) && ctx?.lastInboundThreadId) return { thread_id: ctx.lastInboundThreadId };
  return undefined;
}

/**
 * What a message typed into an EMPTY composer becomes, before any draft row
 * exists: the thread it will inherit from the queue entry and the reply-all cc
 * that thread implies. The panel shows this the moment the company opens.
 * Until it did, "starts a new email" and a blank Cc stood over a reply the
 * autosave would thread and cc correctly, and editing the To line then saved
 * that blank Cc over the default, dropping the colleague the contact had kept
 * on the conversation. Same inputs as composeDraft, so the line the operator
 * reads and the row it becomes cannot disagree. Pure.
 */
function composeTarget({ entry, threads, ourEmail } = {}) {
  const threadId = entry?.thread_id || null;
  if (!threadId) return null;
  const thread = (threads || []).find(t => t.id === threadId) || null;
  return {
    thread_id: threadId,
    subject: thread?.subject || null,
    cc: thread ? computeReplyCc(pickReplyAnchor(thread.messages || []), ourEmail) : null,
  };
}

/**
 * Persist edited recipients on a pending draft. Stored on `structured`
 * alongside the attachment specs, so the send path reads one place.
 * Empty string clears an override and falls back to the resolved contact.
 */
async function setDraftRecipients(sb, { draft_id, to, cc } = {}) {
  if (!draft_id) throw new Error('draft_id required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  if (draft.status !== 'pending') throw new Error(`draft #${draft_id} is '${draft.status}' — only pending drafts can be changed`);

  const structured = mergeRecipients(draft.structured, { to, cc });

  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, to: structured.to || null, cc: structured.cc || null };
}

/** Persist a fact-verification toggle on a pending draft. */
async function setFactVerified(sb, { draft_id, index, verified } = {}) {
  if (!draft_id || !Number.isInteger(index) || index < 0) throw new Error('draft_id and a non-negative fact index are required');
  const { data: draft, error } = await sb.from('b2b_drafts')
    .select('id, structured, status').eq('id', draft_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) throw new Error(`draft #${draft_id} not found`);
  const structured = mergeFactVerification(draft.structured, index, !!verified);
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', draft_id);
  if (uErr) throw new Error(uErr.message);
  return { draft_id, facts_verified: structured.facts_verified };
}

/** All known emails for a company: active contacts + the general front door. */
async function getCompanyEmails(sb, companyId) {
  const { data: contacts, error } = await sb.from('b2b_contacts')
    .select('email').eq('company_id', companyId).eq('is_active', true);
  if (error) throw new Error(error.message);
  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('general_email').eq('id', companyId).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  const set = new Set((contacts || []).map(c => c.email.toLowerCase()));
  if (company?.general_email) set.add(company.general_email.toLowerCase());
  return [...set];
}

/**
 * Gmail sync (thread discovery + manual-send reconcile) runs in the
 * BACKGROUND so the detail payload returns at DB speed. Per-company in-flight
 * guard here; both steps carry their own 15-min cooldowns, so the client's
 * one follow-up re-fetch is cheap and can't loop.
 */
const gmailSyncInFlight = new Set();
function startCompanyGmailSync(sb, companyId, emails) {
  if (gmailSyncInFlight.has(companyId)) return 'in_flight';
  gmailSyncInFlight.add(companyId);
  (async () => {
    try {
      await discoverCompanyThreads(sb, { companyId, emails });
      // includeClosed: this is the one-company view, where the operator is
      // reading the actual conversation. A concluded thread still has to be
      // COMPLETE — the queue-wide sweep is the one that can afford to skip it.
      await reconcileThreads(sb, { companyIds: [companyId], includeClosed: true });
    } catch (err) {
      console.error(`[queueService] gmail sync (${companyId}) failed: ${err.message}`);
    } finally {
      gmailSyncInFlight.delete(companyId);
    }
  })();
  return 'started';
}

/**
 * Full context for one company — the dashboard detail payload:
 *   threads    newest-first, each with messages oldest-first
 *   orders     recent Shopify orders matched via the company's known emails
 *   company    order_count / total_sales / last_order_date summary
 *   recipient  where a send would go (primary contact, general_email fallback)
 *   gmail_sync 'started' when a background Gmail sync kicked off — the client
 *              re-fetches once shortly after to pick up newly-imported threads
 * Returns immediately from the DB; Gmail work never blocks the response.
 */
async function fetchCompanyThreads(sb, companyId) {
  // Round 1 — independent lookups in parallel.
  const [emails, threadsRes, companyRes, recipient, contactsRes, draftRes, meetingsRes, commitmentsRes] = await Promise.all([
    getCompanyEmails(sb, companyId).catch(err => {
      console.error(`[queueService] emails lookup failed: ${err.message}`);
      return [];
    }),
    sb.from('b2b_threads')
      .select('id, thread_type, subject, status, gmail_thread_id, created_at, last_message_at')
      .eq('company_id', companyId)
      .order('last_message_at', { ascending: false, nullsFirst: false }),
    sb.from('b2b_companies').select('*').eq('id', companyId).maybeSingle(),
    resolveDelivery(sb, companyId).catch(() => null),
    // Retired contacts included, and separated in the panel rather than hidden.
    // Filtering them out here meant that retiring someone erased them from the
    // UI entirely: you could not see who you used to write to, could not check
    // the claim that their history was kept, and could not undo a wrong click.
    sb.from('b2b_contacts')
      .select('email, full_name, role, title, is_primary, is_active, bounced_at')
      .eq('company_id', companyId)
      .order('is_active', { ascending: false })
      .order('is_primary', { ascending: false }),
    // The queue payload carries pending drafts, but the directory and activity
    // feed reach companies the queue never listed — without this a company with
    // a draft waiting would open looking like it had none.
    sb.from('b2b_drafts').select('*').eq('company_id', companyId).eq('status', 'pending').maybeSingle(),
    // Calls on the record, recent and upcoming — the panel's Calls block and
    // its Held / Didn't happen buttons render from this. Rows exist for every
    // call on the calendar now, partner-booked ones included.
    sb.from('b2b_meetings')
      .select('id, title, starts_at, ends_at, status, booked_by, source, outcome, outcome_at, meet_url, html_link, their_timezone, google_event_id, summary, wispr_share_link')
      .eq('company_id', companyId)
      .gte('starts_at', new Date(Date.now() - 45 * 86400000).toISOString())
      .order('starts_at', { ascending: false })
      .limit(12),
    // What is owed either way (2026-09-10) — the block under "Where this stands".
    sb.from('b2b_commitments').select('*').eq('company_id', companyId).order('created_at', { ascending: true }),
  ]);
  if (threadsRes.error) throw new Error(threadsRes.error.message);
  const threads = threadsRes.data || [];
  const gmailSync = emails.length ? startCompanyGmailSync(sb, companyId, emails) : 'skipped';

  // Round 2 — messages + orders + donation routing in parallel (each depends on round 1).
  const round2 = await Promise.all([
    threads.length
      ? sb.from('b2b_messages')
        .select('thread_id, direction, message_type, from_email, to_email, cc_email, body_text, sent_at, source, undelivered_at, undelivered_reason')
        .in('thread_id', threads.map(t => t.id))
        .order('sent_at', { ascending: true })
      : Promise.resolve({ data: [] }),
    emails.length
      ? sb.from('orders')
        .select('shopify_order_id, order_number, created_at, total_price, shop_currency, financial_status, fulfillment_status, cancelled_at')
        .in('customer_email', emails)
        .order('created_at', { ascending: false })
        .limit(8)
      : Promise.resolve({ data: [] }),
    // The company's TRUE message count, which is not the same as the number of
    // messages hanging off its threads. `b2b_threads.gmail_thread_id` is UNIQUE,
    // so when two orgs share a Gmail thread (Gmail threads on subject) there is
    // only ONE thread row and it belongs to whoever created it first — the other
    // org's messages carry the right company_id but hang off a thread this query
    // never selects. 8.9% of b2b_messages are in that state. The summary reads by
    // company_id, so the header count has to as well or the block contradicts
    // itself. (The conversation list below still shows the thread-derived set —
    // that discrepancy is the parked thread-ownership bug, not this one.)
    sb.from('b2b_messages').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    // Same reasoning as the advisor's donation facts: where our own records can
    // answer "how is this partnership actually going", the operator should not
    // have to go and look it up either. Org-only, and fail-soft — a missing
    // routing count is a thinner header, not a broken pane.
    companyRes.data?.relationship_type === 'lgbtq_org'
      ? fetchDonationRouting(sb, companyRes.data).catch(err => {
        console.error(`[queueService] donation routing lookup failed: ${err.message}`);
        return null;
      })
      : Promise.resolve(null),
    // The same context the queue reasons from, for one company, so the header
    // can say what the cadence will do next. Fail-soft: no context, no line.
    companyRes.data
      ? buildContexts(sb, [companyRes.data]).catch(err => {
        console.error(`[queueService] context build failed: ${err.message}`);
        return new Map();
      })
      : Promise.resolve(new Map()),
  ]);
  const [messagesRes, ordersRes, msgCountRes, donation, ctxMap] = round2;
  if (messagesRes.error) throw new Error(messagesRes.error.message);
  if (ordersRes.error) console.error(`[queueService] orders lookup failed: ${ordersRes.error.message}`);

  const byThread = new Map(threads.map(t => [t.id, { ...t, messages: [] }]));
  for (const m of messagesRes.data || []) byThread.get(m.thread_id)?.messages.push(m);

  // Logo: store-locator logo if the company has one, else the donation
  // partner registry's logo when this org is a partner (domain/name match).
  const company = companyRes.data || null;
  let logoUrl = company?.locator_logo_url || null;
  if (!logoUrl && company?.relationship_type === 'lgbtq_org') {
    const domain = (company.website || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || null;
    const { data: partners } = await sb.from('donation_partners')
      .select('name, website_url, logo_url').eq('active', true);
    const match = (partners || []).find(p =>
      (domain && (p.website_url || '').toLowerCase().includes(domain))
      || (p.name || '').toLowerCase().trim() === (company.name || '').toLowerCase().trim());
    logoUrl = match?.logo_url || null;
  }

  const threadsOut = [...byThread.values()];
  // The queue entry composeDraft will inherit from, computed the same way it
  // does. Fail-soft: the target is a line in the panel, never a reason to lose
  // the pane.
  let target = null;
  try {
    const ctx = (company && ctxMap.get(company.id)) || {};
    const [queued] = company
      ? assembleQueue([{ company, ctx: { ...ctx, hasPendingDraft: false } }])
      : [];
    target = composeTarget({ entry: composeInheritEntry(queued, ctx), threads: threadsOut, ourEmail: FROM_EMAIL });
  } catch (err) {
    console.error(`[queueService] compose target failed: ${err.message}`);
  }

  return {
    threads: threadsOut,
    compose_target: target,
    orders: ordersRes.data || [],
    // Derived here rather than in the panel so the detail pane and the directory
    // rows can never disagree about what stage a company is at.
    //
    // send_time_zone is the zone a scheduled follow-up is timed against, so the
    // panel can render "sends Thu 09:47 (Europe/London)" rather than converting
    // to Jamie's clock — where the email LANDS is the question the schedule
    // exists to answer. Null when we genuinely do not know, and the panel then
    // says "your time" rather than implying we know theirs.
    company: company
      ? {
        ...company,
        stage: companyStage(company),
        send_time_zone: require('./companyLocation').resolveCompanyTimeZone(company).timeZone,
        // Their zone as the sidebar shows it: the name, and where it came from,
        // so an inference is never mistaken for something they told us.
        their_time_zone: require('./companyLocation').resolveCompanyTimeZone(company),
        their_time_zone_label: (() => {
          const tz = require('./companyLocation').resolveCompanyTimeZone(company).timeZone;
          return tz ? require('./meetingTimezone').timeZoneLabel(tz) : null;
        })(),
      }
      : null,
    contacts: contactsRes.error ? [] : (contactsRes.data || []),
    pending_draft: draftRes.error ? null : (draftRes.data || null),
    meetings: meetingsRes?.error ? [] : (meetingsRes?.data || []),
    // Open first in reading order, then the ten most recent done. Fail-soft
    // before the migration.
    commitments: (() => {
      if (!commitmentsRes || commitmentsRes.error) return [];
      const C = require('./commitments');
      const rows = (commitmentsRes.data || []).map(r => C.decorate(r, company));
      return [...C.orderCommitments(rows.filter(r => r.status === 'open')), ...rows.filter(r => r.status === 'done').slice(-10).reverse()];
    })(),
    logo_url: logoUrl,
    // `recipient` keeps its old shape for email companies so nothing downstream
    // has to special-case the common path; `delivery` carries the mode so the
    // panel knows whether a Send button is even honest here.
    recipient: recipient?.mode === 'email' ? recipient : null,
    delivery: recipient || { mode: 'none' },
    message_count: msgCountRes?.count ?? null,
    // The cadence's own next date for this company, or null. The display the
    // snooze deprecation (2026-08-27) said was missing.
    next_touch: company ? nextScheduledTouch(company, ctxMap.get(company.id) || {}, new Date()) : null,
    donation: donation ? {
      shipments: donation.shipments, items: donation.items,
      firstAt: donation.firstAt, lastAt: donation.lastAt,
    } : null,
    gmail_sync: gmailSync,
  };
}


// ── Vetting ────────────────────────────────────────────────────────────────
// The admission gate as a list. Tier 4 only ever surfaces prospects a human
// has kept (`vetted_at`), so every imported cohort waits here until someone
// looks at it. The console had `b2b_triage` from the start; 119 discovery
// retailers at once is not a console job (retailer plan D8).

/**
 * How we can reach a company, for the vetting row's contact chip. Pure.
 *   own_domain   an address at their own website domain
 *   other_domain a real address at some other business domain
 *   free_mail    Gmail and friends
 *   form         no address, a contact page on file
 *   none         nothing — the row can never draft
 */
function contactStatus({ email, website, contact_form_url } = {}) {
  const { isGenericDomain, emailDomain } = require('./emailDomains');
  const { companyDomain } = require('./queueContext');
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return contact_form_url ? 'form' : 'none';
  const d = emailDomain(e);
  if (isGenericDomain(d)) return 'free_mail';
  const site = companyDomain(website);
  if (site && d !== site && !d.endsWith(`.${site}`) && !site.endsWith(`.${d}`)) return 'other_domain';
  return 'own_domain';
}

/**
 * Every unvetted prospect, best discovery score first. Deferred rows (paused,
 * on me) are left out: a deferral already IS a decision about the company.
 */
async function fetchVetting(sb, { channel } = {}) {
  let q = sb.from('b2b_companies')
    .select('id, name, relationship_type, relationship_state, website, general_email, contact_form_url, city, region, country, source, enrich_facts, metadata, created_at, contact_unknown, triage_reason')
    .is('vetted_at', null).eq('relationship_state', 'prospect')
    .is('outreach_paused_at', null).is('on_me_at', null);
  if (channel) q = q.eq('relationship_type', channel);
  const companies = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(error.message);
    companies.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  if (!companies.length) return { companies: [], total: 0 };
  const ids = companies.map(c => c.id);
  const contactsBy = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await sb.from('b2b_contacts')
      .select('company_id, email, full_name, is_primary').in('company_id', ids.slice(i, i + 500)).eq('is_active', true);
    if (error) throw new Error(error.message);
    for (const c of data || []) contactsBy.set(c.company_id, [...(contactsBy.get(c.company_id) || []), c]);
  }
  const readMeta = (m) => {
    if (typeof m === 'string') { try { return JSON.parse(m) || {}; } catch { return {}; } }
    return (m && typeof m === 'object') ? m : {};
  };
  const pickEmail = (c) => {
    const contacts = (contactsBy.get(c.id) || []).sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
    return { primary: contacts[0] || null, email: contacts[0]?.email || c.general_email || null };
  };
  // Kickbox ran on entry; a verdict of undeliverable is the one fact that
  // blocks a send, so it belongs on the row where the keep decision is made
  // rather than surfacing as a refused send after the intro drafts. Fails
  // open: no table, no verdicts, the row still renders.
  const { fetchVerifications } = require('./emailVerify');
  const { byEmail } = await fetchVerifications(sb, companies.map(c => pickEmail(c).email).filter(Boolean));
  const rows = companies.map(c => {
    const { primary, email } = pickEmail(c);
    const facts = (c.enrich_facts && typeof c.enrich_facts === 'object') ? c.enrich_facts : {};
    const meta = readMeta(c.metadata);
    return {
      ...c,
      contact_email: email,
      contact_name: primary?.full_name || null,
      contact_status: contactStatus({ email, website: c.website, contact_form_url: c.contact_form_url }),
      verification: email ? (byEmail.get(String(email).trim().toLowerCase())?.status || null) : null,
      discovery: {
        score: facts.discovery_score ?? meta.discovery?.score ?? null,
        subcategory: facts.discovery_subcategory || meta.discovery?.subcategory || null,
        angle: facts.discovery_angle || null,
      },
    };
  });
  rows.sort((a, b) => {
    const sa = a.discovery.score, sb2 = b.discovery.score;
    if (sa != null && sb2 != null && sa !== sb2) return sb2 - sa;
    if ((sa == null) !== (sb2 == null)) return sa == null ? 1 : -1;
    return (a.name || '').localeCompare(b.name || '');
  });
  return { companies: rows, total: rows.length };
}

module.exports = {
  fetchVetting, contactStatus,
  draftSnippet,
  attachDrafts,
  mergePendingDraftEntries,
  SCHEDULED_STALE_HOURS,
  withoutLadderWork,
  LADDER_GRACE_BUSINESS_DAYS,
  fetchOutreachQueue,
  fetchQueueWithDrafts,
  fetchQueueCount,
  fetchOnMe,
  fetchCompanyThreads,
  getCompanyEmails,
  generateDraftForCompany, assignVariant,
  isDraftableEntry,
  draftAllDue,
  composeDraft,
  saveOperatorDraft,
  composeDraftRow,
  sendDraftById,
  mergeFactVerification,
  setFactVerified,
  setDraftRecipients,
  mergeRecipients,
  composeTarget,
  composeInheritEntry,
  // directory / activity / thread state
  sanitizeSearchTerm,
  rollupThreads,
  companyThreadStatus,
  companyStage,
  DIRECTORY_STAGES,
  matchReason,
  searchCompanies,
  fetchActivity,
  setThreadStatus,
  applyStatedNextTouch,
  reopenThread,
  DIRECTORY_STATUSES,
};
