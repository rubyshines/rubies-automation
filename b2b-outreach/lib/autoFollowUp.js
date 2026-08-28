/**
 * autoFollowUp.js — the two passes that make the follow-up ladder run itself.
 *
 * The ladder in cadence.js has always been correct and has never fired, because
 * the sweep that would run it was deliberately left unscheduled (pull-mode,
 * 2026-07-23). These are the halves that close that loop:
 *
 *   DRAFT PASS  (daily)      what is due → an Opus draft, stamped with the
 *                            moment it should land in THEIR business hours.
 *                            Also ends the ladder: retire a lead, or hand a live
 *                            relationship to the operator.
 *   SEND PASS   (every 15m)  scheduled drafts whose moment has come, through the
 *                            same sendDraftById every other send uses.
 *
 * ## Why this can send without a click
 *
 * The prose of a follow-up is low-variance — the advisor has the whole thread
 * plus the relationship recap, and "circling back on this" is hard to get wrong.
 * What goes wrong in this system is TARGETING, so that is what is guarded, and
 * every guard is machine-checkable:
 *
 *   1. The reply re-check, run immediately BEFORE the send rather than at draft
 *      time. The engine has repeatedly turned out not to see its own
 *      correspondence — manualSendReconcile, sweepEmptyCompanies and the
 *      shared-thread fix each found real replies the queue was reading as
 *      silence, one of them 332 days old. A late follow-up is embarrassing; a
 *      cheerful "just following up!" to someone who answered on Tuesday is worse.
 *   2. Address health. The 19 Aug 2026 round bounced at 12% against the ~2% that
 *      damages sender reputation on rubyshines.com — the domain Klaviyo shares
 *      to reach customers. Automation is what turns that from a surprise into a
 *      trend, so a known-dead address is never auto-sent to.
 *   3. A daily cap, so a bad batch cannot be a big batch.
 *   4. Scope: engine-sent threads only, inside FOLLOWUP_MAX_AGE_DAYS. Enforced
 *      in cadence.js, which is what keeps 51 manual-send threads (some 1575 days
 *      old) out of an automatic pass entirely.
 *
 * The scheduling gap is a free review window: a draft written by the daily sync
 * sends hours later, in their morning. Look if you want to; it goes if you don't.
 */
const { assembleQueue } = require('./queue');
const { buildContexts } = require('./queueContext');
const { exhaustedDecision } = require('./cadence');
const { nextSendSlot, describeSlot } = require('./sendWindow');
const { timezoneFromLocation } = require('./meetingTimezone');
const { triageCompany } = require('./triage');
const { fetchAllPaginated } = require('../../shared/supabaseClient');

/**
 * Message types this pass is allowed to send unattended.
 *
 * Everything else the queue surfaces — Tier-1 replies, first touches, seasonal
 * check-ins — stays pull-mode and waits for an operator. A chase is the narrow
 * case where the content is genuinely mechanical: we asked, nobody answered, we
 * are asking once more. Widening this set is a decision, not a config tweak.
 */
const AUTO_SEND_TYPES = new Set(['followup_1', 'followup_2']);

/**
 * Ceiling on automatic sends per calendar day, across all companies.
 *
 * Bounds the blast radius of anything that goes wrong upstream — a bad prompt, a
 * data repair that resets a hundred anchors at once, a bug in the ladder. Ten is
 * far above real volume (the whole in-scope cohort is eight companies) and far
 * below a number that could hurt sender reputation in a day.
 */
const DAILY_AUTOSEND_CAP = 10;

/** How long a reply check may be considered fresh enough to send on. */
const REPLY_CHECK_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Are the scheduling columns actually there?
 *
 * Checked BEFORE either pass does anything, because the failure without it is
 * expensive rather than merely noisy: the draft pass would generate real Opus
 * drafts, fail to stamp a schedule on them, and leave unscheduled pending rows
 * that block their companies from being chased at all. Paying for a draft and
 * then dropping it on the floor is the worst of the available outcomes.
 *
 * A deploy landing before the migration is the ordinary case here, not an
 * exotic one — DDL is a hand-run step in the Supabase SQL Editor.
 */
async function schemaReady(sb) {
  const { error } = await sb.from('b2b_drafts').select('scheduled_send_at').limit(1);
  if (!error) return { ok: true };
  return {
    ok: false,
    why: 'follow-up scheduling columns are missing — run the b2b_drafts / b2b_companies '
      + 'ALTERs in gmail-management/b2b-outreach-schema.sql in the Supabase SQL Editor',
  };
}

/** The company's IANA zone for scheduling purposes, or null. Pure. */
function companyTimeZone(company) {
  const { timeZone } = timezoneFromLocation({
    region: company.region,
    country: company.country,
    address: company.address,
  });
  return timeZone;
}

/**
 * Where and when a follow-up to this company should land. Pure given `now`.
 */
function scheduleFor(company, now = new Date()) {
  const slot = nextSendSlot({
    timeZone: companyTimeZone(company),
    country: company.country,
    companyId: company.id,
    now,
  });
  return {
    scheduled_send_at: slot.at.toISOString(),
    schedule_reason: slot.reason,
    display: describeSlot(slot),
  };
}

// ---------------------------------------------------------------------------
// Draft pass
// ---------------------------------------------------------------------------

/**
 * Generate and schedule every follow-up that is due; end the ladder where it has
 * run out.
 *
 * @param sb
 * @param {object} opts { dry, now, limit }
 * @returns a report — always, including on a dry run, because the report IS the
 *          artifact an operator reads before enabling this.
 */
async function runDraftPass(sb, { dry = false, now = new Date(), limit = 25 } = {}) {
  // A dry run is allowed through: it writes nothing, so it is exactly the thing
  // you want to be able to run while the migration is still pending.
  if (!dry) {
    const ready = await schemaReady(sb);
    if (!ready.ok) {
      return { scheduled: [], retired: [], handed_off: [], skipped: [], blocked: [], errors: [], dry, schema_missing: ready.why };
    }
  }
  const companies = await fetchAllPaginated(() => sb.from('b2b_companies').select('*'));
  const contexts = await buildContexts(sb, companies);

  const report = { scheduled: [], retired: [], handed_off: [], skipped: [], blocked: [], errors: [], dry };

  // --- the end of the ladder ------------------------------------------------
  // Applied BEFORE drafting: a company whose ladder is spent must not also be
  // handed a fresh draft in the same pass.
  for (const company of companies) {
    const ctx = contexts.get(company.id);
    if (!ctx) continue;
    let decision;
    try {
      decision = exhaustedDecision(company, ctx, now);
    } catch (err) {
      report.errors.push({ company_id: company.id, name: company.name, error: err.message });
      continue;
    }
    if (!decision) continue;

    const row = {
      company_id: company.id,
      name: company.name,
      reason: decision.reason,
      ...(decision.note ? { note: decision.note } : {}),
    };
    if (dry) {
      (decision.decision === 'retire' ? report.retired : report.handed_off).push(row);
      continue;
    }
    try {
      if (decision.decision === 'retire') {
        await triageCompany(sb, {
          company_id: company.id, action: 'pause', reason: decision.reason,
          source: 'cadence', now,
        });
        report.retired.push(row);
      } else {
        await triageCompany(sb, {
          company_id: company.id, action: 'on_me', note: decision.note,
          source: 'cadence', now,
        });
        report.handed_off.push(row);
      }
    } catch (err) {
      report.errors.push({ company_id: company.id, name: company.name, error: err.message });
    }
  }

  // --- what is due ----------------------------------------------------------
  // Rebuilt after the decisions above so a company just retired or handed off is
  // no longer eligible. Cheap: it is arithmetic over rows already in memory,
  // apart from the eligibility flags the writes above changed.
  const justDeferred = new Set([...report.retired, ...report.handed_off].map(r => r.company_id));
  const queue = assembleQueue(
    companies
      .filter(c => dry || !justDeferred.has(c.id))
      .map(c => ({ company: c, ctx: contexts.get(c.id) })),
    now,
  );
  const due = queue.filter(e => AUTO_SEND_TYPES.has(e.message_type)).slice(0, limit);
  if (queue.filter(e => AUTO_SEND_TYPES.has(e.message_type)).length > due.length) {
    report.truncated = `limit ${limit} — more follow-ups were due than this pass drafted`;
  }

  // --- due, but held back by the eligibility gate ---------------------------
  //
  // `companyEligible` is checked before any cadence branch, so a company that is
  // paused, claimed, has a call booked, or is already holding a pending draft
  // never reaches the queue at all. Without this the report says "3 scheduled,
  // 0 skipped" while two companies are genuinely overdue for a chase — an empty
  // result reading as a complete one, which is the failure mode this subsystem
  // hits over and over.
  //
  // Not an error and not something to fix by drafting anyway: a pending draft IS
  // work waiting, and drafting a follow-up underneath an unsent intro would be
  // absurd. It just has to be SAYABLE.
  const { followUpRung } = require('./cadence');
  const { companyEligible } = require('./cadence');
  for (const company of companies) {
    const ctx = contexts.get(company.id);
    if (!ctx || justDeferred.has(company.id)) continue;
    if (companyEligible(company, ctx, now)) continue;
    let rung = null;
    try { rung = followUpRung(company, ctx, now); } catch { continue; }
    if (!rung || !AUTO_SEND_TYPES.has(rung.message_type)) continue;
    const why = company.outreach_paused_at ? 'outreach paused'
      : company.on_me_at ? 'claimed by the operator'
        : ctx.upcomingMeetingAt ? 'a call is booked'
          : company.contact_unknown ? 'no working address'
            : ctx.hasPendingDraft ? 'a draft is already pending — send or dismiss it and the chase resumes'
              : company.snoozed_until ? 'snoozed'
                : 'not eligible for cadence outreach';
    report.blocked.push({
      company_id: company.id, name: company.name,
      message_type: rung.message_type, reason: rung.reason, why,
    });
  }

  const byId = new Map(companies.map(c => [c.id, c]));
  for (const entry of due) {
    const company = byId.get(entry.company_id);
    // A company we cannot email is not a company we can auto-chase. The panel
    // still surfaces it; the copy-paste path is an operator act.
    if (entry.delivery !== 'email') {
      report.skipped.push({
        company_id: entry.company_id, name: entry.company_name,
        why: `delivery is '${entry.delivery}' — needs a human`,
      });
      continue;
    }
    let schedule;
    try {
      schedule = scheduleFor(company, now);
    } catch (err) {
      report.errors.push({ company_id: company.id, name: company.name, error: err.message });
      continue;
    }
    const row = {
      company_id: entry.company_id,
      name: entry.company_name,
      message_type: entry.message_type,
      reason: entry.reason,
      sends: schedule.display,
      schedule_reason: schedule.schedule_reason,
    };
    if (dry) { report.scheduled.push(row); continue; }

    try {
      const { generateDraftForCompany } = require('./queueService');
      const draft = await generateDraftForCompany(sb, { company_id: entry.company_id });
      if (!draft) {
        report.skipped.push({ company_id: entry.company_id, name: entry.company_name, why: 'nothing due at draft time' });
        continue;
      }
      // The advisor may pick a different type than the queue predicted (a steer,
      // a thread that reads as something else). Only stamp a schedule on what we
      // actually agreed to auto-send; anything else stays pull-mode with no
      // scheduled_send_at, so the send pass will never pick it up.
      if (!AUTO_SEND_TYPES.has(draft.message_type)) {
        report.skipped.push({
          company_id: entry.company_id, name: entry.company_name,
          why: `advisor produced '${draft.message_type}' — left for the operator`,
        });
        continue;
      }
      const { error } = await sb.from('b2b_drafts')
        .update({ scheduled_send_at: schedule.scheduled_send_at, schedule_reason: schedule.schedule_reason })
        .eq('id', draft.draft_id);
      if (error) throw new Error(`schedule stamp: ${error.message}`);
      report.scheduled.push({ ...row, draft_id: draft.draft_id, message_type: draft.message_type });
    } catch (err) {
      report.errors.push({ company_id: entry.company_id, name: entry.company_name, error: err.message });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Send pass
// ---------------------------------------------------------------------------

/**
 * Did anyone write to us since the message this draft is chasing?
 *
 * Goes to GMAIL first rather than trusting the local mirror, because the whole
 * failure mode this guards against is the mirror being behind. `discoverCompanyThreads`
 * and `reconcileThreads` both carry 15-minute cooldowns designed for a panel that
 * re-fetches on every render; here a skipped check is not a cheap no-op but the
 * difference between a guard and the appearance of one, so the cooldown is
 * bypassed and a check that could not run FAILS CLOSED.
 *
 * @returns {{ ok: boolean, why?: string }} ok:false means do not send.
 */
async function replyGuard(sb, draft, { now = new Date() } = {}) {
  const { discoverCompanyThreads, reconcileThreads } = require('./manualSendReconcile');
  const { getCompanyEmails } = require('./queueService');

  let emails = [];
  try {
    emails = await getCompanyEmails(sb, draft.company_id);
  } catch (err) {
    return { ok: false, why: `could not resolve addresses to check (${err.message})` };
  }
  // Both of these are FAIL-SOFT by design — they catch their own Gmail errors
  // and return a count rather than throwing, because their other callers (a
  // nightly sweep, a panel render) would rather degrade than crash. So a
  // try/catch alone is not a guard here: it would pass cleanly in exactly the
  // case that matters, Gmail being unreachable, and we would send blind. The
  // return value has to be inspected.
  try {
    const discovered = await discoverCompanyThreads(sb, { companyId: draft.company_id, emails, force: true });
    if (discovered?.error) return { ok: false, why: `thread discovery could not run (${discovered.error})` };
    if (discovered?.failed) return { ok: false, why: `${discovered.failed} thread(s) failed to import — reply state is incomplete` };
    const reconciled = await reconcileThreads(sb, { companyIds: [draft.company_id], includeClosed: true, force: true });
    if (reconciled?.error) return { ok: false, why: `reply reconcile could not run (${reconciled.error})` };
  } catch (err) {
    // Failing closed costs a delayed follow-up. Failing open costs writing
    // "just following up!" to someone who already answered.
    return { ok: false, why: `reply check failed (${err.message}) — not sending on stale data` };
  }

  // The anchor: the outbound this draft is chasing. Anything inbound after it
  // means the chase is obsolete.
  const { data: company } = await sb.from('b2b_companies').select('*').eq('id', draft.company_id).maybeSingle();
  if (!company) return { ok: false, why: 'company disappeared' };
  const ctx = (await buildContexts(sb, [company])).get(draft.company_id);
  if (!ctx) return { ok: false, why: 'could not rebuild context' };

  if (ctx.lastInboundAt && ctx.lastOutboundMessageAt
    && new Date(ctx.lastInboundAt) > new Date(ctx.lastOutboundMessageAt)) {
    return { ok: false, why: `they replied ${ctx.lastInboundAt} — chase is obsolete`, replied: true };
  }
  // Belt and braces: the eligibility gate may have changed since drafting (a
  // meeting booked, a pause set, the operator claiming it).
  const { companyEligible } = require('./cadence');
  if (!companyEligible(company, { ...ctx, hasPendingDraft: false }, now)) {
    return { ok: false, why: 'company is no longer eligible for cadence outreach' };
  }
  return { ok: true };
}

/** Is every address this send would reach known to be alive? */
async function addressGuard(sb, draft) {
  const { data: company } = await sb.from('b2b_companies')
    .select('id, contact_unknown, general_email').eq('id', draft.company_id).maybeSingle();
  if (company?.contact_unknown) {
    return { ok: false, why: 'contact_unknown — no working address on file' };
  }
  const { data: contacts, error } = await sb.from('b2b_contacts')
    .select('email, is_primary, bounced_at').eq('company_id', draft.company_id).eq('is_active', true);
  if (error) return { ok: false, why: `contact lookup failed (${error.message})` };

  // Verified-undeliverable is a recorded bounce we didn't have to send to get.
  // The lookup itself FAILS OPEN (unverified addresses are the whole book's
  // starting state, and a verification guard that blocks on its own
  // infrastructure being missing is the fail-closed-forever trap) — only a
  // positive 'undeliverable' row removes an address from consideration.
  const { fetchVerifications, filterUndeliverable, isUndeliverable, normalizeEmail } =
    require('./emailVerify');
  const { byEmail } = await fetchVerifications(sb,
    [...(contacts || []).map(c => c.email), company?.general_email].filter(Boolean));

  const live = filterUndeliverable(contacts, byEmail);
  if ((contacts || []).length && !live.length) {
    return { ok: false, why: 'every active contact has bounced or verified undeliverable — needs a new address' };
  }
  // No contacts → the send falls through to general_email; a dead one blocks.
  if (!(contacts || []).length && company?.general_email
    && isUndeliverable(byEmail.get(normalizeEmail(company.general_email)))) {
    return { ok: false, why: `general_email ${company.general_email} verified undeliverable — needs a new address` };
  }
  return { ok: true };
}

/** Auto-sends already made today, for the cap. */
async function autoSentToday(sb, now) {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { data, error } = await sb.from('b2b_drafts')
    .select('id').eq('status', 'sent')
    .not('scheduled_send_at', 'is', null)
    .gte('sent_at', dayStart.toISOString());
  if (error) throw new Error(`cap lookup: ${error.message}`);
  return (data || []).length;
}

/**
 * Send every scheduled follow-up whose moment has passed and whose guards hold.
 */
async function runSendPass(sb, { now = new Date(), cap = DAILY_AUTOSEND_CAP, dry = false } = {}) {
  const report = { sent: [], held: [], errors: [], dry };

  // Silently doing nothing every 15 minutes is the wrong failure. Say why once
  // per tick and let the deploy-before-migration window be visible in the logs.
  const ready = await schemaReady(sb);
  if (!ready.ok) return { ...report, schema_missing: ready.why };

  const { data: drafts, error } = await sb.from('b2b_drafts')
    .select('*').eq('status', 'pending')
    .not('scheduled_send_at', 'is', null)
    .lte('scheduled_send_at', now.toISOString())
    .order('scheduled_send_at', { ascending: true });
  if (error) throw new Error(`scheduled draft lookup: ${error.message}`);
  if (!drafts?.length) return report;

  const already = dry ? 0 : await autoSentToday(sb, now);
  let budget = Math.max(0, cap - already);
  if (drafts.length > budget) {
    // Said out loud rather than silently truncated: a cap nobody can see reads
    // as "everything was covered".
    report.capped = `${drafts.length} due, ${budget} within today's cap of ${cap} (${already} already sent)`;
  }

  for (const draft of drafts) {
    if (budget <= 0) {
      report.held.push({ draft_id: draft.id, company_id: draft.company_id, why: 'daily cap reached — will go tomorrow' });
      continue;
    }
    try {
      const addr = await addressGuard(sb, draft);
      if (!addr.ok) { report.held.push({ draft_id: draft.id, company_id: draft.company_id, why: addr.why }); continue; }

      const reply = await replyGuard(sb, draft, { now });
      if (!reply.ok) {
        // A chase made obsolete by a reply is not held, it is withdrawn: the
        // company comes back as Tier 1 and the operator answers the human.
        // Superseded rather than dismissed so the advisor's text survives as
        // training signal, same as everywhere else.
        if (reply.replied) {
          await sb.from('b2b_drafts').update({ status: 'superseded' }).eq('id', draft.id);
        }
        report.held.push({ draft_id: draft.id, company_id: draft.company_id, why: reply.why, withdrawn: !!reply.replied });
        continue;
      }

      if (dry) {
        report.sent.push({ draft_id: draft.id, company_id: draft.company_id, message_type: draft.message_type, dry: true });
        budget -= 1;
        continue;
      }

      const { sendDraftById } = require('./queueService');
      const res = await sendDraftById(sb, { draft_id: draft.id, confirmed: true });
      if (res.phase === 'sent') {
        report.sent.push({ draft_id: draft.id, company_id: draft.company_id, message_type: draft.message_type, to: res.to });
        budget -= 1;
      } else {
        // Blocked by the send flag, a form-only company, an unbacked invite
        // claim: all real refusals that leave the draft pending for a human.
        report.held.push({ draft_id: draft.id, company_id: draft.company_id, why: res.error || res.phase });
      }
    } catch (err) {
      report.errors.push({ draft_id: draft.id, company_id: draft.company_id, error: err.message });
    }
  }
  return report;
}

module.exports = {
  runDraftPass,
  runSendPass,
  schemaReady,
  replyGuard,
  addressGuard,
  scheduleFor,
  companyTimeZone,
  AUTO_SEND_TYPES,
  DAILY_AUTOSEND_CAP,
  REPLY_CHECK_MAX_AGE_MS,
};
