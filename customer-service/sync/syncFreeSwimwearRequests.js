/**
 * Sync Free Swimwear applications from the Google Sheet into Supabase.
 *
 * INSERT-IF-ABSENT keyed on (email, submitted_at). Once a row lands in Supabase,
 * Supabase owns its operational state (status, discount code, dates) — the sheet
 * is only the intake feed for NEW submissions. Re-running never clobbers a
 * portal/lifecycle decision, so it's safe to run on a schedule and concurrently.
 *
 * Repeat / duplicate handling (go-forward intake only; skipped during backfill):
 * for each genuinely-new eligible submission whose email already has prior
 * applications, an Opus call decides which priors are the SAME recipient, then a
 * pure rule (lib/freeSwimwearRepeats.js) collapses same-day resubmits, closes
 * too-soon repeats with a friendly reapply email, and flags possible second
 * children for review. External side effects run AFTER the insert and are keyed
 * by the inserted row id, so a retried/concurrent run never re-emails or
 * re-collapses (idempotent).
 *
 * Runs as a sub-pipeline of daily-sync-all.js (live, current form only); also
 * runnable directly:
 *   node customer-service/sync/syncFreeSwimwearRequests.js            # dry-run, current form only
 *   node customer-service/sync/syncFreeSwimwearRequests.js --backfill # dry-run, include legacy tab
 *   node customer-service/sync/syncFreeSwimwearRequests.js --live     # write new rows
 *   node customer-service/sync/syncFreeSwimwearRequests.js --backfill --live  # one-time full history import
 */

require('dotenv').config();
const { readApplications, identityKey } = require('../lib/freeSwimwearSurvey');
const { classifySameRecipient, decideRepeat, isCountablePrior } = require('../lib/freeSwimwearRepeats');
const { sendRepeatNotice } = require('../lib/freeSwimwear');
const { writeBackToSheet } = require('../lib/freeSwimwearSheet');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const TABLE = 'free_swimwear_requests';
const PRIOR_COLS = 'id, email, submitted_at, status, applicant_name, recipient_age, situation, why, discount_code';

// Identity is (email, submitted_at) — NOT sheet position. The sheet re-sorts,
// so keying on sheet_row would re-insert every applicant as a duplicate whenever
// the row order changes.
async function fetchExistingKeys(supabase) {
  const keys = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('email, submitted_at')
      // Stable ordering is required for .range() paging — without it, pages can
      // overlap/skip and a missed identity key re-inserts a duplicate that then
      // aborts the whole run on the unique index.
      .order('email', { ascending: true })
      .order('submitted_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch existing keys: ${error.message}`);
    for (const r of data) keys.add(identityKey(r));
    if (data.length < pageSize) break;
  }
  return keys;
}

// Prior applications for the candidate emails, grouped by lowercased email.
// Only countable statuses (a real application we acted on) are kept, so a silent
// rejection or a collapsed duplicate neither triggers a reapply email nor resets
// the window. Matched case-insensitively (raw + lowercased in the IN list).
async function fetchPriorsByEmail(supabase, emails) {
  const byEmail = {};
  if (!emails.length) return byEmail;
  const variants = [...new Set(emails.flatMap(e => [e, e.toLowerCase()]))];
  for (let i = 0; i < variants.length; i += 200) {
    const chunk = variants.slice(i, i + 200);
    const { data, error } = await supabase.from(TABLE).select(PRIOR_COLS).in('email', chunk);
    if (error) throw new Error(`fetch priors: ${error.message}`);
    for (const r of data) {
      if (!isCountablePrior(r)) continue;
      const k = (r.email || '').toLowerCase();
      (byEmail[k] = byEmail[k] || []).push(r);
    }
  }
  return byEmail;
}

function tally(rows, field) {
  const t = {};
  for (const r of rows) t[r[field]] = (t[r[field]] || 0) + 1;
  return t;
}

/**
 * Decide repeat/duplicate disposition for each new eligible row. Mutates the
 * row objects in place (status + repeat/duplicate flags) so the subsequent
 * insert carries the final state. Does NOT perform external side effects —
 * emails + DB-prior collapses are returned as deferred effects so the caller can
 * run them AFTER a successful insert (idempotency). AI classification is
 * read-only, so it's safe to run in dry-run for an accurate preview.
 *
 * @returns {{stats:Object, emailEffects:Array, supersedeIds:Array<number>}}
 */
async function planRepeats({ supabase, newRows, now }) {
  const stats = { repeat: 0, duplicate: 0, second_child: 0, returning: 0, collapsed_prior: 0 };
  const emailEffects = []; // [{ identity, reapplyAfter }]
  const supersedeIds = []; // DB prior ids to close as 'duplicate'

  // Only eligible (would-be 'new') rows participate; ineligible rows are already
  // closed silently by the deterministic gate and must not be re-opened.
  const candidates = newRows.filter(r => r.status === 'new');
  if (!candidates.length) return { stats, emailEffects, supersedeIds };

  const emails = [...new Set(candidates.map(r => r.email).filter(Boolean))];
  const priorsByEmail = await fetchPriorsByEmail(supabase, emails);

  // Oldest-first, so an earlier same-batch submission counts as a prior for a
  // later one (handles two same-day rows that are both new in this run).
  const ordered = [...candidates].sort((a, b) => new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0));

  for (const row of ordered) {
    const key = (row.email || '').toLowerCase();
    const priors = priorsByEmail[key] || [];
    const addAsPrior = () => { (priorsByEmail[key] = priorsByEmail[key] || []).push(row); };
    if (!priors.length) { addAsPrior(); continue; }

    const { same, reasoning } = await classifySameRecipient(row, priors);
    const decision = decideRepeat({ newRow: row, samePriorRows: same, hadAnyPrior: priors.length > 0, now });

    Object.assign(row, decision.patch);
    if (decision.disposition === 'repeat' || decision.disposition === 'duplicate') {
      row.status = decision.disposition;
      row.decided_at = now.toISOString();
      row.decided_by = 'system:repeat-check';
    }

    if (decision.disposition === 'repeat') stats.repeat++;
    else if (decision.disposition === 'duplicate') stats.duplicate++;
    else if (row.possible_second_child) stats.second_child++;
    else if (row.prior_application_at) stats.returning++;
    console.log(`  ${row.email} @ ${(row.submitted_at || '').slice(0, 10)} → ${decision.disposition}` +
      `${row.possible_second_child ? ' (possible 2nd child)' : ''}` +
      `${decision.reapplyAfter ? ` (reapply after ${decision.reapplyAfter.slice(0, 10)})` : ''} — ${reasoning}`);

    if (decision.supersede) {
      stats.collapsed_prior++;
      if (decision.supersede.id != null) {
        supersedeIds.push(decision.supersede.id); // existing DB row → defer the UPDATE
      } else {
        // In-batch prior not yet inserted → mutate it so it inserts as 'duplicate'.
        decision.supersede.status = 'duplicate';
        decision.supersede.decided_at = now.toISOString();
        decision.supersede.decided_by = 'system:repeat-check';
      }
    }

    if (decision.disposition === 'repeat') {
      emailEffects.push({ identity: identityKey(row), reapplyAfter: decision.reapplyAfter });
    }
    addAsPrior();
  }

  return { stats, emailEffects, supersedeIds };
}

/**
 * Import new applications. Returns a daily-sync-all pipeline result.
 * @param {Object} opts
 * @param {boolean} opts.backfill - include the legacy "Sheet5" tab.
 * @param {boolean} opts.live - actually insert (default false = dry run).
 */
async function run({ backfill = false, live = false } = {}) {
  const now = new Date();
  console.log(`[freeSwimwearSync] reading sheet (${backfill ? 'form + legacy' : 'form only'})...`);
  const rows = await readApplications({ legacy: backfill });
  console.log(`[freeSwimwearSync] read ${rows.length} rows`);

  const supabase = getSupabaseClient();
  const existing = await fetchExistingKeys(supabase);
  const newRows = rows.filter(r => !existing.has(identityKey(r)));

  console.log(`[freeSwimwearSync] ${existing.size} already in Supabase, ${newRows.length} new`);

  // Repeat / duplicate handling — go-forward intake only. Backfill is a one-time
  // historical import; these are ongoing-intake semantics, so skip it there.
  let plan = { stats: null, emailEffects: [], supersedeIds: [] };
  if (!backfill && newRows.length) {
    console.log('[freeSwimwearSync] checking repeats/duplicates...');
    plan = await planRepeats({ supabase, newRows, now });
    console.log('[freeSwimwearSync] repeat outcomes:', JSON.stringify(plan.stats));
  }

  console.log(`[freeSwimwearSync] new by status:`, JSON.stringify(tally(newRows, 'status')));

  if (!live) {
    console.log('[freeSwimwearSync] DRY RUN — pass --live to insert + send. No writes made.');
    return { status: 'ok', sources: { applications: { success: true, rowsWritten: 0, note: `${newRows.length} new (dry run)` } } };
  }

  // Insert first, capturing ids, so the deferred side effects (reapply emails,
  // collapsing prior rows) key off persisted state and never double-fire.
  const idByIdentity = new Map();
  let inserted = 0;
  const chunk = 500;
  for (let i = 0; i < newRows.length; i += chunk) {
    const batch = newRows.slice(i, i + chunk);
    const { data, error } = await supabase.from(TABLE).insert(batch).select('id, email, submitted_at');
    if (error) throw new Error(`insert batch ${i}-${i + batch.length}: ${error.message}`);
    for (const r of data) idByIdentity.set(identityKey(r), r.id);
    inserted += batch.length;
    console.log(`[freeSwimwearSync] inserted ${inserted}/${newRows.length}`);
  }

  // Deferred: collapse same-day priors that already lived in the DB.
  for (const id of plan.supersedeIds) {
    await supabase.from(TABLE).update({ status: 'duplicate', decided_at: now.toISOString(), decided_by: 'system:repeat-check' }).eq('id', id);
  }

  // Deferred: email the reapply notice for too-soon repeats, then stamp the send
  // date on the persisted row (null stays = not delivered, visible + retryable).
  let emailed = 0;
  for (const eff of plan.emailEffects) {
    const id = idByIdentity.get(eff.identity);
    const row = newRows.find(r => identityKey(r) === eff.identity);
    if (!id || !row) continue;
    const res = await sendRepeatNotice(row, eff.reapplyAfter, now);
    if (res.emailSent) {
      await supabase.from(TABLE).update({ repeat_notice_sent_at: now.toISOString() }).eq('id', id);
      row.repeat_notice_sent_at = now.toISOString();
      emailed++;
    } else {
      console.warn(`[freeSwimwearSync] ⚠️ reapply email FAILED for ${row.email}: ${res.email.error}`);
    }
    try { await writeBackToSheet({ ...row, id }); } catch (_) { /* fail-soft */ }
  }

  console.log(`[freeSwimwearSync] done — inserted ${inserted}, collapsed ${plan.supersedeIds.length} prior(s), emailed ${emailed} repeat notice(s).`);
  return { status: 'ok', sources: { applications: { success: true, rowsWritten: inserted } } };
}

module.exports = { run, planRepeats };

if (require.main === module) {
  const args = process.argv.slice(2);
  run({ backfill: args.includes('--backfill'), live: args.includes('--live') })
    .catch(err => {
      console.error('[freeSwimwearSync] FAILED:', err.message);
      process.exit(1);
    });
}
