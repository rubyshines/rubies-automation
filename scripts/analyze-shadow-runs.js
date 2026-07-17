// Analyze shadow model eval runs in cs_diagnostic_runs, per the canonical
// Sample Methodology in .claude/memory/project_cs_efficiency.md:
//   PRIMARY   = first draft per unique ticket (decision rules apply to this)
//   SECONDARY = all rows (includes redrafts/steers — operator-steering signal)
//
// Usage:
//   node scripts/analyze-shadow-runs.js --since 2026-07-10T11:21:01Z [--show-better] [--show-worst]
//
// --since        created_at floor (default: last 14 days is NOT assumed — pass
//                the flag-enable timestamp of the eval you're analyzing)
// --show-better  print judge reasoning for score 4-5 rows
// --show-worst   print judge reasoning for score 1 rows
const { getSupabaseClient } = require('../shared/supabaseClient');

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const since = argVal('--since');
if (!since) {
  console.error('Required: --since <ISO timestamp> (the flag-enable time of the eval run)');
  process.exit(1);
}

(async () => {
  const sb = getSupabaseClient();
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('cs_diagnostic_runs')
      .select('id, source, customer_email, ticket_id, draft_id, created_at, judge_result, opus_timing, sonnet_timing')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  if (!rows.length) {
    console.log(`No rows in cs_diagnostic_runs since ${since}`);
    return;
  }

  const dist = (scores) => {
    const d = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, null: 0 };
    for (const s of scores) d[s == null ? 'null' : s]++;
    return d;
  };
  const mean = (scores) => {
    const v = scores.filter((s) => s != null);
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : 'n/a';
  };
  const avgLatency = (rs, key) => {
    const v = rs.map((r) => r[key]?.total_ms).filter((x) => x > 0);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const judgeNote = (r) => {
    const j = r.judge_result || {};
    const n = j.score_reason || j.overall?.note || j.tone?.note || '';
    return String(n).replace(/\s+/g, ' ');
  };

  const bySource = {};
  for (const r of rows) (bySource[r.source] = bySource[r.source] || []).push(r);

  for (const [source, rs] of Object.entries(bySource)) {
    console.log(`\n=== source: ${source} (${rs.length} rows) ===`);

    // First row per unique ticket; fall back to customer_email when ticket_id
    // is null (pre-2026-04-27 rows and any intake path that lacks a ticket).
    const seen = new Set();
    const firsts = [];
    for (const r of rs) {
      const key = r.ticket_id != null ? `t${r.ticket_id}` : `e${r.customer_email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      firsts.push(r);
    }
    const firstScores = firsts.map((r) => r.judge_result?.score ?? null);
    const allScores = rs.map((r) => r.judge_result?.score ?? null);
    const nullStructured = rs.filter((r) => r.judge_result?.structured?.rating === 'MAJOR_DIFF' && /null|missing|broken/i.test(r.judge_result?.structured?.note || '')).length;

    console.log(`PRIMARY   (first draft/ticket, n=${firsts.length}): mean=${mean(firstScores)} dist=${JSON.stringify(dist(firstScores))}`);
    console.log(`SECONDARY (all rows, n=${rs.length}): mean=${mean(allScores)} dist=${JSON.stringify(dist(allScores))}`);
    const p1 = firstScores.filter((s) => s === 1).length;
    console.log(`primary % rated 1: ${firsts.length ? ((p1 / firsts.length) * 100).toFixed(1) : 'n/a'}%`);
    console.log(`avg latency ms: production=${avgLatency(rs, 'opus_timing')} candidate=${avgLatency(rs, 'sonnet_timing')}`);
    if (nullStructured) {
      console.log(`⚠ ${nullStructured} rows judged MAJOR_DIFF on structured output for null/missing/broken — if this dominates, check the harness before trusting the scores (see 2026-07 harness bug in project_cs_efficiency.md)`);
    }

    if (args.includes('--show-better')) {
      console.log('\n-- score 4-5 (all rows) --');
      rs.filter((r) => r.judge_result?.score >= 4).forEach((r) => console.log(`  #${r.id} [${r.judge_result.score}] ${judgeNote(r)}`));
    }
    if (args.includes('--show-worst')) {
      console.log('\n-- score 1 (all rows) --');
      rs.filter((r) => r.judge_result?.score === 1).forEach((r) => console.log(`  #${r.id} [1] ${judgeNote(r)}`));
    }
  }

  const byDay = {};
  for (const r of rows) byDay[r.created_at.slice(0, 10)] = (byDay[r.created_at.slice(0, 10)] || 0) + 1;
  console.log('\n=== runs per day ===');
  Object.entries(byDay).forEach(([d, c]) => console.log(`  ${d}: ${c}`));
})();
