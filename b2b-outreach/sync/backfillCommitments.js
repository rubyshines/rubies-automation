#!/usr/bin/env node
/**
 * backfillCommitments.js — seed the commitments list from recent conversations.
 *
 * The list starts empty (2026-09-10); nothing before it was written to the
 * definition of a commitment. But the engine has only been live since late
 * July, so "recent" is a small, recognisable set: the companies with a real
 * back-and-forth since then. This runs the relationship summariser over each
 * with force, and its commitments step lifts the promises it can see — marked
 * source 'backfill', created by the engine — for Jamie to tidy in the To do
 * view once. After that the summariser only adds as new mail lands.
 *
 * Candidates: not a prospect, not lost, and a human inbound message inside the
 * window (default 60 days). Print-only by default.
 *
 * Usage:
 *   node b2b-outreach/sync/backfillCommitments.js            # list candidates
 *   node b2b-outreach/sync/backfillCommitments.js --write    # run the extractor
 *   options: --days 60  --limit 40  --company <id>
 */
require('dotenv').config();
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { refreshCompanySummary } = require('../lib/relationshipSummary');
const { listCommitments } = require('../lib/commitments');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

async function candidates(sb, { days, companyId }) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = sb.from('b2b_messages').select('company_id, sent_at')
    .eq('direction', 'inbound').is('message_type', null).gte('sent_at', since);
  if (companyId) q = q.eq('company_id', companyId);
  const { data: inbound, error } = await q;
  if (error) throw new Error(error.message);
  const ids = [...new Set((inbound || []).map(m => m.company_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: companies, error: cErr } = await sb.from('b2b_companies')
    .select('id, name, relationship_type, relationship_state, relationship_summary_at')
    .in('id', ids);
  if (cErr) throw new Error(cErr.message);
  const lastInbound = new Map();
  for (const m of inbound) {
    if (!lastInbound.has(m.company_id) || m.sent_at > lastInbound.get(m.company_id)) lastInbound.set(m.company_id, m.sent_at);
  }
  return (companies || [])
    .filter(c => c.relationship_state !== 'prospect' && c.relationship_state !== 'lost')
    .map(c => ({ ...c, last_inbound_at: lastInbound.get(c.id) }))
    .sort((a, b) => String(b.last_inbound_at).localeCompare(String(a.last_inbound_at)));
}

async function main() {
  const write = process.argv.includes('--write');
  const days = parseInt(arg('--days', '60'), 10);
  const limit = parseInt(arg('--limit', '40'), 10);
  const companyId = arg('--company', null);
  const sb = getSupabaseClient();

  const rows = await candidates(sb, { days, companyId });
  console.log(`${rows.length} companies with a human reply in the last ${days} days (not prospects, not lost)${rows.length > limit ? `; running the first ${limit}` : ''}:`);
  for (const c of rows.slice(0, limit)) {
    console.log(`  ${c.id.padEnd(32)} ${c.relationship_type.padEnd(10)} last reply ${String(c.last_inbound_at).slice(0, 10)}  ${c.name}`);
  }
  if (!write) {
    console.log('\nPrint-only. Re-run with --write to extract commitments (one summariser call per company).');
    return;
  }

  let added = 0;
  for (const c of rows.slice(0, limit)) {
    try {
      const r = await refreshCompanySummary(sb, c.id, { force: true, commitmentSource: 'backfill' });
      const n = r.commitments ? r.commitments.added : 0;
      added += n;
      console.log(`  ${c.name}: ${r.status}${n ? `, ${n} added` : ''}${r.commitments?.settled ? `, ${r.commitments.settled} of theirs settled` : ''}`);
      for (const i of (r.commitments?.items || [])) console.log(`      - ${i.owner === 'me' ? 'Jamie' : 'them'}: ${i.text}${i.due_on ? ` (by ${i.due_on})` : ''}`);
    } catch (err) {
      console.error(`  ${c.name}: FAILED ${err.message}`);
    }
  }

  const open = await listCommitments(sb, { status: 'open' });
  console.log(`\n${added} added this run. Open now: ${open.filter(r => r.owner === 'me').length} on Jamie, ${open.filter(r => r.owner === 'them').length} waiting on them.`);
  console.log('Review them in the Outreach panel under To do — delete what is wrong, fix what is close.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
