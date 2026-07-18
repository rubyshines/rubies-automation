/**
 * Weekly KB refresh (corpus harvest step 5) — runs as a daily-sync-all step,
 * self-gated to Mondays UTC (every daily run calls it; it no-ops six days a week).
 *
 * Monday flow:
 *   1. Re-harvest kb_sources from Shopify + rubyshines.com (content_hash
 *      changes bump last_changed_at).
 *   2. Rebuild pass over cs_knowledge_base (propagates kb_candidates
 *      amendments, embeds anything new/changed — idempotent, cheap when
 *      nothing changed).
 *   3. Stale-extraction report: candidates whose source_hash no longer matches
 *      their kb_sources content_hash need a zero-API re-extraction session
 *      (Claude Code, per kb-extraction-protocol.md) — the cron can only flag
 *      them, loudly, in the daily digest.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

async function fetchAll(sb, table, columns, filter) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function run({ force = false } = {}) {
  if (!force && new Date().getUTCDay() !== 1) {
    return { sources: { kb_refresh: { success: true, skipped: 'weekly (runs Mondays UTC)' } }, status: 'ok' };
  }

  const harvest = await require('../import/harvestKbSources').run({});
  const rebuild = await require('../import/rebuildKnowledgeBase').run({});

  const sb = getSupabaseClient();
  const sources = await fetchAll(sb, 'kb_sources', 'id, content_hash', q => q.eq('status', 'active'));
  const hashById = new Map(sources.map(s => [s.id, s.content_hash]));
  const candidates = await fetchAll(sb, 'kb_candidates', 'id, source_id, source_hash', q => q.neq('status', 'dropped'));
  const stale = candidates.filter(c => hashById.has(c.source_id) && hashById.get(c.source_id) !== c.source_hash);

  if (stale.length) {
    console.warn(`[KB Refresh] ${stale.length} candidate(s) have DRIFTED sources and need re-extraction (Claude Code session per kb-extraction-protocol.md):`);
    for (const c of stale.slice(0, 20)) console.warn(`  - ${c.id} (source ${c.source_id})`);
    if (stale.length > 20) console.warn(`  ...and ${stale.length - 20} more`);
  }

  return {
    sources: {
      kb_refresh: {
        success: true,
        harvested: true,
        rebuild: rebuild?.sources?.kb_rebuild || null,
        stale_extractions: stale.length,
        stale_ids: stale.slice(0, 20).map(c => c.id),
      },
    },
    status: 'ok',
  };
}

if (require.main === module) {
  run({ force: process.argv.includes('--force') }).then(r => console.log(JSON.stringify(r, null, 1))).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run };
