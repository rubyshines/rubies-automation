/**
 * backfillFeedbackSignals.js — one-time backfill for the training-signal gaps (#6).
 *
 * 1. Historical manual sends: cs_ai_drafts rows with draft_kind='manual_send'
 *    that have no cs_ai_feedback_log row → insert action='manual_backfilled'
 *    (created_at = original sent_at so time-series stats stay truthful).
 * 2. Historical steers: sent drafts with operator_steer set whose feedback row
 *    is missing operator_steer/regen_count → update those columns in place.
 *
 * Idempotent: re-running skips rows already covered.
 * Dry-run by default. Pass --execute to write.
 *
 * Usage: node customer-service/scripts/backfillFeedbackSignals.js [--execute]
 */
require('dotenv').config();
const { getSupabaseClient } = require('../../shared/supabaseClient');
const sb = getSupabaseClient();

const EXECUTE = process.argv.includes('--execute');

async function fetchAll(query, pageSize = 1000) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await query().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function backfillManualSends() {
  const manualDrafts = await fetchAll(() =>
    sb.from('cs_ai_drafts')
      .select('id, gorgias_ticket_id, sent_response, sent_at, turn_number')
      .eq('draft_kind', 'manual_send')
      .order('id', { ascending: true })
  );
  console.log(`Manual-send drafts found: ${manualDrafts.length}`);
  if (!manualDrafts.length) return { inserted: 0, skipped: 0 };

  const draftIds = manualDrafts.map(d => d.id);
  const existing = await fetchAll(() =>
    sb.from('cs_ai_feedback_log')
      .select('draft_id')
      .in('draft_id', draftIds)
      .order('id', { ascending: true })
  );
  const covered = new Set(existing.map(r => r.draft_id));

  let inserted = 0, skipped = 0;
  for (const d of manualDrafts) {
    if (covered.has(d.id)) { skipped++; continue; }
    const row = {
      draft_id: d.id,
      gorgias_ticket_id: d.gorgias_ticket_id,
      action: 'manual_backfilled',
      original_response: '',
      final_response: d.sent_response || '',
      advisor_status: null,
      confidence: null,
      message_type: null,
      turn_number: d.turn_number,
      operator_steer: null,
      regen_count: 0,
      created_at: d.sent_at || undefined,
    };
    if (EXECUTE) {
      const { error } = await sb.from('cs_ai_feedback_log').insert(row);
      if (error) throw error;
    } else {
      console.log(`  [dry-run] would insert manual_backfilled for draft ${d.id} (${(d.sent_response || '').slice(0, 60)}…)`);
    }
    inserted++;
  }
  return { inserted, skipped };
}

async function backfillSteers() {
  const steeredDrafts = await fetchAll(() =>
    sb.from('cs_ai_drafts')
      .select('id, operator_steer, draft_history')
      .not('operator_steer', 'is', null)
      .eq('status', 'sent')
      .order('id', { ascending: true })
  );
  console.log(`Sent drafts with steer: ${steeredDrafts.length}`);
  if (!steeredDrafts.length) return { updated: 0, skipped: 0, noFeedbackRow: 0 };

  const byDraft = new Map(steeredDrafts.map(d => [d.id, d]));
  const feedback = await fetchAll(() =>
    sb.from('cs_ai_feedback_log')
      .select('id, draft_id, operator_steer')
      .in('draft_id', steeredDrafts.map(d => d.id))
      .order('id', { ascending: true })
  );

  let updated = 0, skipped = 0;
  const seenDrafts = new Set();
  for (const f of feedback) {
    seenDrafts.add(f.draft_id);
    if (f.operator_steer != null) { skipped++; continue; }
    const d = byDraft.get(f.draft_id);
    const patch = {
      operator_steer: d.operator_steer,
      regen_count: Array.isArray(d.draft_history) ? d.draft_history.length : 0,
    };
    if (EXECUTE) {
      const { error } = await sb.from('cs_ai_feedback_log').update(patch).eq('id', f.id);
      if (error) throw error;
    } else {
      console.log(`  [dry-run] would set steer on feedback ${f.id} (draft ${f.draft_id}): "${d.operator_steer.slice(0, 50)}…" regens=${patch.regen_count}`);
    }
    updated++;
  }
  const noFeedbackRow = steeredDrafts.filter(d => !seenDrafts.has(d.id)).length;
  return { updated, skipped, noFeedbackRow };
}

(async () => {
  console.log(EXECUTE ? '=== EXECUTE MODE ===' : '=== DRY RUN (pass --execute to write) ===');
  const m = await backfillManualSends();
  console.log(`Manual sends: ${EXECUTE ? 'inserted' : 'would insert'} ${m.inserted}, already covered ${m.skipped}`);
  const s = await backfillSteers();
  console.log(`Steers: ${EXECUTE ? 'updated' : 'would update'} ${s.updated}, already set ${s.skipped}, steered-but-no-feedback-row ${s.noFeedbackRow}`);
})().catch(e => { console.error(e); process.exit(1); });
