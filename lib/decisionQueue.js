/**
 * decisionQueue.js — "Needs your decision" aggregator for the daily digest.
 *
 * The forgetting problem: features that wait on a one-time human decision
 * (pending advisor facts, an auto-send category that's proven itself in
 * shadow, facts about to expire) have no voice — a passive dashboard badge is
 * easy to never see, and a stats line in the digest reads as information, not
 * a to-do. This task turns each waiting decision into an explicit digest item
 * with the data that justifies acting, and repeats daily until it's resolved.
 * Empty when nothing needs deciding — silence means genuinely nothing to do.
 *
 * Items produced:
 *  - pending advisor facts (count + oldest age; nags harder past 7 days)
 *  - active facts expiring within 14 days (refresh or let lapse)
 *  - auto-send shadow categories that meet the promotion bar:
 *    ≥30 would-have-sent drafts in the trailing 60d, ZERO judged
 *    substantive/factual/action among them. That is the go/no-go rule from
 *    the shadow design — when it holds, the data says flip the category live.
 *
 * All reads fail-soft: a missing table produces no items, never an error.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

const PROMOTE_MIN_MARKED = 30;
const PROMOTE_WINDOW_DAYS = 60;
const EXPIRY_LOOKAHEAD_DAYS = 14;

async function pendingFactItems(sb) {
  const { data, error } = await sb.from('advisor_facts')
    .select('id, created_at').eq('status', 'pending').order('created_at');
  if (error || !data?.length) return [];
  const oldestDays = Math.floor((Date.now() - Date.parse(data[0].created_at)) / 86400000);
  return [{
    kind: 'facts_pending',
    urgent: oldestDays > 7,
    text: `${data.length} advisor fact${data.length === 1 ? '' : 's'} waiting for review (oldest ${oldestDays}d)`,
    action: 'Dashboard → Facts panel. Approve, edit, or reject — pending facts teach the advisor nothing.',
  }];
}

async function expiringFactItems(sb) {
  const horizon = new Date(Date.now() + EXPIRY_LOOKAHEAD_DAYS * 86400000).toISOString();
  const { data, error } = await sb.from('advisor_facts')
    .select('id, fact, expires_at').eq('status', 'active')
    .not('expires_at', 'is', null).lte('expires_at', horizon)
    .gte('expires_at', new Date().toISOString())
    .order('expires_at');
  if (error || !data?.length) return [];
  return data.map(f => ({
    kind: 'fact_expiring',
    urgent: false,
    text: `Fact expires ${f.expires_at.slice(0, 10)}: “${f.fact.slice(0, 90)}${f.fact.length > 90 ? '…' : ''}”`,
    action: 'If still true, re-approve with a new date in the Facts panel; otherwise let it lapse.',
  }));
}

async function autosendPromotionItems(sb) {
  const since = new Date(Date.now() - PROMOTE_WINDOW_DAYS * 86400000).toISOString();
  const marked = await fetchAllPaginated(() =>
    sb.from('cs_ai_drafts')
      .select('id, message_type')
      .eq('auto_close_path', 'autosend_shadow')
      .gte('sent_at', since)
      .order('id')
  ).catch(() => []);
  if (!marked.length) return [];

  const byType = {};
  for (const d of marked) (byType[d.message_type || 'unknown'] = byType[d.message_type || 'unknown'] || []).push(d.id);

  const items = [];
  for (const [type, ids] of Object.entries(byType)) {
    if (ids.length < PROMOTE_MIN_MARKED) continue;
    const verdicts = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from('cs_draft_judgments')
        .select('category').in('draft_id', ids.slice(i, i + 200));
      if (error) return []; // can't verify cleanliness → recommend nothing
      verdicts.push(...(data || []));
    }
    const erred = verdicts.filter(v => ['substantive', 'factual_correction', 'action_divergence'].includes(v.category)).length;
    if (erred === 0 && verdicts.length >= PROMOTE_MIN_MARKED) {
      items.push({
        kind: 'autosend_promote',
        urgent: false,
        text: `Auto-send “${type}” has earned promotion: ${ids.length} would-have-sent drafts over ${PROMOTE_WINDOW_DAYS}d, ${verdicts.length} judged, 0 wrong`,
        action: 'Dashboard → Auto-send panel → enable the category. Shadow keeps marking either way, so this is reversible.',
      });
    }
  }
  return items;
}

async function collectDecisions() {
  const sb = getSupabaseClient();
  const settled = await Promise.allSettled([
    pendingFactItems(sb),
    expiringFactItems(sb),
    autosendPromotionItems(sb),
  ]);
  return settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
}

// Daily-sync task-runner shape.
async function run() {
  try {
    const items = await collectDecisions();
    return { sources: { decision_queue: { items, count: items.length } }, status: 'ok' };
  } catch (e) {
    return { sources: { decision_queue: { skipped: true, error: e.message } }, status: 'warning' };
  }
}

module.exports = { run, collectDecisions };
