#!/usr/bin/env node
/**
 * Validate the reply-containment guard against every draft the advisor has
 * actually written.
 *
 * The number that matters is NOT recall on the known leaks (there are only
 * two, and any guard can be tuned to catch two). It is the false-positive rate
 * over the whole population: a guard that trims a clean draft is worse than
 * the leak it prevents, because a leak is embarrassing while a silent cut can
 * remove a refund offer. So this replays the real containReply over the
 * unfiltered advisor corpus and reports every draft it would have changed, for
 * reading by eye.
 *
 *   node scripts/evalReplyContainment.js              # full corpus
 *   node scripts/evalReplyContainment.js --limit 200  # recent slice, cheap
 *   node scripts/evalReplyContainment.js --ids 2959,3131
 */

require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { containReply } = require('../customer-service/lib/replyContainment');

const CONCURRENCY = 8;

// Confirmed leaks, read by hand out of the corpus. The guard must catch these.
const KNOWN_LEAKS = new Set([2959, 3131]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function fetchDrafts() {
  const sb = getSupabaseClient();
  const ids = arg('--ids');
  if (ids) {
    const { data, error } = await sb.from('cs_ai_drafts')
      .select('id, ticket_id, draft_response, sent_at')
      .in('id', ids.split(',').map(s => parseInt(s.trim(), 10)));
    if (error) throw error;
    return data;
  }

  // Only drafts the advisor wrote — auto_follow_up is a fixed template and
  // operator_reply/manual_send are Jamie composing from scratch, so including
  // them would measure the guard against text it never runs on.
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from('cs_ai_drafts')
      .select('id, ticket_id, draft_response, sent_at')
      .eq('source', 'poller').eq('draft_kind', 'advisor_draft')
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const limit = parseInt(arg('--limit') || '0', 10);
  return limit ? all.slice(0, limit) : all;
}

(async () => {
  const drafts = (await fetchDrafts()).filter(d => (d.draft_response || '').trim());
  console.log(`Replaying containment over ${drafts.length} advisor drafts...\n`);

  const changed = [], flaggedOnly = [], skipped = [];
  let done = 0;

  const queue = [...drafts];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const d = queue.shift();
      if (!d) return;
      const res = await containReply(d.draft_response, { ticket_id: d.ticket_id, draft_id: d.id });
      if (res.warning?.startsWith('CONTAINMENT_SKIPPED')) skipped.push({ d, res });
      else if (res.text !== d.draft_response) changed.push({ d, res });
      else if (res.leaked) flaggedOnly.push({ d, res });
      if (++done % 100 === 0) console.log(`  ${done}/${drafts.length}`);
    }
  }));

  const changedIds = new Set(changed.map(c => c.d.id));
  const touchedIds = new Set([...changedIds, ...flaggedOnly.map(f => f.d.id)]);

  console.log(`\n${'='.repeat(66)}`);
  console.log(`drafts replayed        ${drafts.length}`);
  console.log(`text CHANGED           ${changed.length}  (${(changed.length / drafts.length * 100).toFixed(2)}%)`);
  console.log(`flagged, not changed   ${flaggedOnly.length}`);
  console.log(`guard errored/skipped  ${skipped.length}`);

  const missed = [...KNOWN_LEAKS].filter(id => drafts.some(d => d.id === id) && !touchedIds.has(id));
  const caught = [...KNOWN_LEAKS].filter(id => touchedIds.has(id));
  console.log(`known leaks caught     ${caught.length}/${[...KNOWN_LEAKS].filter(id => drafts.some(d => d.id === id)).length}${missed.length ? `  MISSED: ${missed.join(', ')}` : ''}`);
  console.log(`${'='.repeat(66)}\n`);

  console.log('--- every draft the guard would have CHANGED (read these by eye) ---');
  for (const { d, res } of changed.sort((a, b) => a.d.id - b.d.id)) {
    const tag = KNOWN_LEAKS.has(d.id) ? 'KNOWN LEAK' : '*** NOT A KNOWN LEAK — inspect ***';
    console.log(`\n#${d.id} ticket=${d.ticket_id} sent=${!!d.sent_at} ${d.draft_response.length}->${res.text.length} chars  [${tag}]`);
    console.log(`   ${res.warning}`);
    console.log(`   REMOVED HEAD: ${JSON.stringify(d.draft_response.slice(0, 120))}`);
    console.log(`   KEPT  HEAD:   ${JSON.stringify(res.text.slice(0, 120))}`);
  }

  if (flaggedOnly.length) {
    console.log('\n--- flagged but not cut (operator would see a banner) ---');
    for (const { d, res } of flaggedOnly) console.log(`#${d.id}: ${res.warning}`);
  }
  if (skipped.length) {
    console.log('\n--- skipped ---');
    for (const { d, res } of skipped.slice(0, 10)) console.log(`#${d.id}: ${res.warning}`);
  }
})();
