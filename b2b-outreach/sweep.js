/**
 * sweep.js — the outreach daily sweep (Trigger 3) + queue report.
 *
 * Assembles per-company context, computes the 6-tier queue, and (optionally)
 * has the advisors generate drafts for the top entries. DRAFTS ONLY — sending
 * is a separate operator act through sendB2bEmail (itself gated off).
 *
 * Usage:
 *   node b2b-outreach/sweep.js                  # report the queue, draft nothing
 *   node b2b-outreach/sweep.js --draft 5        # also generate drafts for top 5
 *   node b2b-outreach/sweep.js --company <id>   # queue/draft a single company
 *
 * Railway-ready: exits 0 even when the queue is empty; fail-soft per company.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { assembleQueue } = require('./lib/queue');

const sb = getSupabaseClient();

async function fetchAll(buildQuery, pageSize = 1000) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

/** Build the evaluateDue/queue context for each company from b2b_messages. */
async function buildContexts(companies) {
  const ids = companies.map(c => c.id);
  const messages = ids.length ? await fetchAll(() =>
    sb.from('b2b_messages')
      .select('company_id, direction, message_type, sent_at')
      .in('company_id', ids)
      .order('sent_at', { ascending: true })
  ) : [];
  const drafts = ids.length ? await fetchAll(() =>
    sb.from('b2b_drafts').select('company_id').eq('status', 'pending').in('company_id', ids)
  ) : [];
  const pendingSet = new Set(drafts.map(d => d.company_id));

  const byCompany = new Map();
  for (const c of companies) {
    byCompany.set(c.id, {
      hasPendingDraft: pendingSet.has(c.id),
      sentTypes: new Set(),
      lastInboundAt: null,
      lastOutboundAt: c.last_outbound_at || null,
      lastOrderAt: c.last_order_date || null,
      orderCount: c.order_count || 0,
      lastTypeSent: new Map(),
    });
  }
  for (const m of messages) {
    const ctx = byCompany.get(m.company_id);
    if (!ctx) continue;
    if (m.direction === 'inbound') {
      ctx.lastInboundAt = m.sent_at;
    } else {
      ctx.lastOutboundAt = ctx.lastOutboundAt && ctx.lastOutboundAt > m.sent_at ? ctx.lastOutboundAt : m.sent_at;
      if (m.message_type) {
        ctx.sentTypes.add(m.message_type);
        ctx.lastTypeSent.set(m.message_type, m.sent_at);
      }
    }
  }
  for (const ctx of byCompany.values()) {
    const map = ctx.lastTypeSent;
    ctx.lastTypeSentAt = (type) => map.get(type) || null;
  }
  return byCompany;
}

async function main() {
  const argv = process.argv.slice(2);
  const draftIdx = argv.indexOf('--draft');
  const draftN = draftIdx > -1 ? Number(argv[draftIdx + 1] || 0) : 0;
  const companyIdx = argv.indexOf('--company');
  const onlyCompany = companyIdx > -1 ? argv[companyIdx + 1] : null;

  let q = sb.from('b2b_companies').select('*');
  if (onlyCompany) q = q.eq('id', onlyCompany);
  const { data: companies, error } = await q;
  if (error) throw new Error(error.message);

  const contexts = await buildContexts(companies || []);
  const queue = assembleQueue((companies || []).map(c => ({ company: c, ctx: contexts.get(c.id) })));

  console.log(`Outreach queue — ${queue.length} entr${queue.length === 1 ? 'y' : 'ies'}:`);
  for (const e of queue) {
    console.log(`  T${e.tier} ${String(e.channel).padEnd(10)} ${e.company_name.padEnd(32)} ${e.message_type || '(reply)'} — ${e.reason}`);
  }

  if (draftN > 0 && queue.length) {
    const { generateDraft } = require('./lib/outreachAdvisor');
    const targets = queue.slice(0, draftN);
    console.log(`\nDrafting top ${targets.length}…`);
    for (const e of targets) {
      try {
        const d = await generateDraft({ company_id: e.company_id, queueEntry: e });
        console.log(`  ✓ ${e.company_name} → draft ${d.draft_id} (${d.advisor}, ${d.message_type}, confidence ${d.confidence})`);
      } catch (err) {
        console.error(`  ✗ ${e.company_name}: ${err.message}`);
      }
    }
  }
}

main().catch(e => {
  if (/Could not find the table 'public\.b2b_(messages|threads|drafts)'/.test(e.message)) {
    console.error('Outreach schema not yet applied — run gmail-management/b2b-outreach-schema.sql in the Supabase SQL Editor, then re-run this sweep.');
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
