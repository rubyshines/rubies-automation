/**
 * runJudgeBaseline.js — run the closeness-to-final judge (#3) over historical
 * sent advisor drafts and store verdicts in cs_draft_judgments.
 *
 * Idempotent: drafts already judged are skipped (UNIQUE on draft_id).
 * Dry-run by default (counts + cost estimate only). Flags:
 *   --execute     actually call the judge and write verdicts
 *   --limit N     judge at most N drafts this run (default 25; use a small
 *                 limit first so Jamie can review verdicts before the full run)
 *   --days N      lookback window (default 90)
 *
 * Usage: node customer-service/scripts/runJudgeBaseline.js [--execute] [--limit 25] [--days 90]
 */
require('dotenv').config();
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { judgeDraftVsSent } = require('../lib/closenessJudge');
const { normalizeForCompare } = require('../lib/feedbackSignals');

const sb = getSupabaseClient();
const EXECUTE = process.argv.includes('--execute');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const LIMIT = arg('--limit', 25);
const DAYS = arg('--days', 90);

(async () => {
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

  const drafts = await fetchAllPaginated(() =>
    sb.from('cs_ai_drafts')
      .select('id, gorgias_ticket_id, draft_response, sent_response, message_type, conversation_history, sent_at')
      .eq('status', 'sent')
      .eq('draft_kind', 'advisor_draft')
      .gte('sent_at', cutoff)
      .not('sent_response', 'is', null)
      .neq('draft_response', '')
      .order('sent_at', { ascending: false })
  );

  const judged = await fetchAllPaginated(() =>
    sb.from('cs_draft_judgments').select('draft_id').order('id', { ascending: true })
  );
  const done = new Set(judged.map(j => j.draft_id));

  const pending = drafts.filter(d => !done.has(d.id));
  const identical = pending.filter(d => normalizeForCompare(d.draft_response) === normalizeForCompare(d.sent_response));
  const needsAi = pending.length - identical.length;

  console.log(`Sent advisor drafts in last ${DAYS}d: ${drafts.length}`);
  console.log(`Already judged: ${done.size} · pending: ${pending.length} (identical short-circuit: ${identical.length}, need AI judge: ${needsAi})`);
  console.log(`Rough cost if all judged: ~$${(needsAi * 0.03).toFixed(2)} (Opus, ~3¢/verdict)`);

  if (!EXECUTE) {
    console.log('\nDry run — pass --execute to judge (respects --limit, default 25).');
    return;
  }

  const batch = pending.slice(0, LIMIT);
  console.log(`\nJudging ${batch.length} drafts (limit ${LIMIT})…`);
  let counts = {};
  for (const d of batch) {
    try {
      const verdict = await judgeDraftVsSent({
        draftResponse: d.draft_response,
        sentResponse: d.sent_response,
        conversationHistory: d.conversation_history,
        messageType: d.message_type,
      });
      const { error } = await sb.from('cs_draft_judgments').insert({
        draft_id: d.id,
        gorgias_ticket_id: d.gorgias_ticket_id,
        category: verdict.category,
        draft_may_be_right: verdict.draft_may_be_right,
        severity: verdict.severity,
        rationale: verdict.rationale,
        message_type: d.message_type,
        judge_model: verdict.judge_model,
        source: 'baseline',
      });
      if (error && error.code !== '23505') throw error; // 23505 = already judged by a concurrent run
      counts[verdict.category] = (counts[verdict.category] || 0) + 1;
      const flag = verdict.draft_may_be_right ? '  ⚑ draft_may_be_right' : '';
      console.log(`  draft ${d.id} [${d.message_type || '—'}] → ${verdict.category}/${verdict.severity}${flag}`);
    } catch (e) {
      console.error(`  draft ${d.id} FAILED: ${e.message}`);
    }
  }
  console.log('\nBatch summary:', JSON.stringify(counts));
})().catch(e => { console.error(e); process.exit(1); });
