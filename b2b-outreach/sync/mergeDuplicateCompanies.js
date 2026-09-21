/**
 * mergeDuplicateCompanies.js — finish the merges that only got half done.
 *
 * The 2026-08-11 duplicate sweep repointed each loser's history onto the
 * survivor, marked the loser `lost`, and wrote the decision into its
 * `triage_reason` ("merged into <id>"). It never deleted the row. A year on
 * those tombstones are still in the book: they turn up in scans, they hold
 * their own copy of the order totals, and "we last wrote never" on a row that
 * looks like a live org is exactly the confusing state the merge was meant to
 * remove.
 *
 * The authority here is that `triage_reason`, not a guess. Which row survives
 * was a human decision, it is already recorded in the data, and this pass only
 * carries it out — never picks a winner by row count or name similarity, which
 * is how two unrelated orgs get fused (see domain_b2b_sales.md, 2026-08-11).
 *
 * Stragglers are repointed before the delete, because the earlier sweep missed
 * a few: Skipping Stone's tombstone still held the OPENING message of a
 * conversation whose later messages sit on the survivor, so repointing it
 * recovers history rather than merely tidying up. Where the survivor already
 * holds the same Gmail thread or message, the duplicate child is dropped
 * instead of repointed — a unique violation there means the survivor already
 * has the better copy.
 *
 *   node b2b-outreach/sync/mergeDuplicateCompanies.js           # print only
 *   node b2b-outreach/sync/mergeDuplicateCompanies.js --write
 */
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');

const UNIQUE_VIOLATION = '23505';
const UNDEFINED_COLUMN = '42703';

/** Tables carrying a thread_id foreign key, swept when a thread is collapsed. */
const THREAD_REFERENCING = ['b2b_messages', 'b2b_drafts', 'b2b_commitments', 'b2b_meetings'];

/** The survivor a tombstone names, or null. PURE. */
function mergedInto(triageReason) {
  const m = /^merged into ([A-Za-z0-9_-]+)/.exec(String(triageReason || '').trim());
  return m ? m[1] : null;
}

/**
 * The tombstones to finish, from every company row. PURE.
 * A row only qualifies when it names a survivor that actually exists and is
 * not itself — a dangling or self-referential pointer is left alone and
 * reported, never guessed at.
 */
function planMerges(companies) {
  const byId = new Map(companies.map(c => [c.id, c]));
  const merges = [];
  const problems = [];
  for (const c of companies) {
    const target = mergedInto(c.triage_reason);
    if (!target) continue;
    if (target === c.id) { problems.push({ id: c.id, why: 'names itself' }); continue; }
    if (!byId.has(target)) { problems.push({ id: c.id, why: `names ${target}, which does not exist` }); continue; }
    merges.push({ dup: c, keep: byId.get(target) });
  }
  return { merges, problems };
}

/** Repoint one child row, dropping it instead when the survivor already has it. */
async function repoint(sb, table, row, patch, { write }) {
  if (!write) return 'would repoint';
  const { error } = await sb.from(table).update(patch).eq('id', row.id);
  if (!error) return 'repointed';
  if (error.code !== UNIQUE_VIOLATION) throw new Error(`${table} ${row.id}: ${error.message}`);
  const { error: dErr } = await sb.from(table).delete().eq('id', row.id);
  if (dErr) throw new Error(`${table} ${row.id} delete: ${dErr.message}`);
  return 'dropped (survivor already has it)';
}

async function mergeOne(sb, { dup, keep }, { write }) {
  const log = [];

  // Threads first: a duplicate of a thread the survivor already holds is
  // collapsed onto it so the messages underneath still land somewhere real.
  const { data: dThreads } = await sb.from('b2b_threads').select('id, gmail_thread_id, subject').eq('company_id', dup.id);
  const { data: kThreads } = await sb.from('b2b_threads').select('id, gmail_thread_id').eq('company_id', keep.id);
  const keepByGmail = new Map((kThreads || []).map(t => [t.gmail_thread_id, t.id]));
  const threadRemap = new Map();

  for (const t of dThreads || []) {
    const collapseTo = keepByGmail.get(t.gmail_thread_id);
    if (collapseTo) {
      threadRemap.set(t.id, collapseTo);
      log.push(`  thread ${t.id} "${String(t.subject).slice(0, 48)}" collapses onto survivor thread ${collapseTo}`);
    } else {
      log.push(`  thread ${t.id} "${String(t.subject).slice(0, 48)}" → ${await repoint(sb, 'b2b_threads', t, { company_id: keep.id }, { write })}`);
    }
  }

  // Messages: company always, thread too where its thread was collapsed.
  const { data: dMsgs } = await sb.from('b2b_messages').select('id, thread_id, direction, sent_at').eq('company_id', dup.id);
  for (const m of dMsgs || []) {
    const patch = { company_id: keep.id };
    if (threadRemap.has(m.thread_id)) patch.thread_id = threadRemap.get(m.thread_id);
    log.push(`  message ${m.id} (${m.direction} ${m.sent_at.slice(0, 10)}) → ${await repoint(sb, 'b2b_messages', m, patch, { write })}`);
  }

  for (const table of ['b2b_contacts', 'b2b_drafts', 'b2b_commitments', 'b2b_meetings']) {
    const { data: rows, error } = await sb.from(table).select('id').eq('company_id', dup.id);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of rows || []) {
      log.push(`  ${table.replace('b2b_', '')} ${r.id} → ${await repoint(sb, table, r, { company_id: keep.id }, { write })}`);
    }
  }

  // Everything still pointing at a collapsed thread, swept BY THREAD rather
  // than by company. A draft owned by the SURVIVOR can point at the duplicate's
  // thread (it does for The Center on Colfax), so the company-scoped passes
  // above cannot see it, and the delete below then trips its foreign key.
  for (const [from, to] of threadRemap) {
    for (const table of THREAD_REFERENCING) {
      const { data: rows, error } = await sb.from(table).select('id').eq('thread_id', from);
      if (error) {
        if (error.code === UNDEFINED_COLUMN) continue; // no thread_id on this table
        throw new Error(`${table} by thread ${from}: ${error.message}`);
      }
      for (const r of rows || []) {
        log.push(`  ${table.replace('b2b_', '')} ${r.id} thread ${from}→${to} ${await repoint(sb, table, r, { thread_id: to }, { write })}`);
      }
    }
  }

  // A collapsed thread row is now empty and must go, or it re-appears as a
  // company-less thread the panel cannot render.
  for (const threadId of threadRemap.keys()) {
    if (!write) { log.push(`  would delete emptied thread ${threadId}`); continue; }
    const { count } = await sb.from('b2b_messages').select('*', { count: 'exact', head: true }).eq('thread_id', threadId);
    if (count) throw new Error(`thread ${threadId} still holds ${count} messages — not deleting`);
    const { error } = await sb.from('b2b_threads').delete().eq('id', threadId);
    if (error) throw new Error(`thread ${threadId} delete: ${error.message}`);
    log.push(`  deleted emptied thread ${threadId}`);
  }

  if (write) {
    const { error } = await sb.from('b2b_companies').delete().eq('id', dup.id);
    if (error) throw new Error(`${dup.id} delete: ${error.message}`);
  }
  log.push(`  ${write ? 'deleted' : 'would delete'} company ${dup.id}`);
  return log;
}

async function run({ write = false } = {}) {
  const sb = getSupabaseClient();
  const companies = await fetchAllPaginated(() => sb.from('b2b_companies')
    .select('id, name, relationship_type, relationship_state, triage_reason').order('id'));

  const { merges, problems } = planMerges(companies);
  console.log(`${companies.length} companies; ${merges.length} tombstones naming a survivor.\n`);

  for (const m of merges) {
    console.log(`── ${m.dup.id}  →  ${m.keep.id}`);
    console.log(`   "${m.dup.name}" into "${m.keep.name}"`);
    for (const line of await mergeOne(sb, m, { write })) console.log(line);
    console.log('');
  }

  if (problems.length) {
    console.log('left alone — the pointer does not resolve:');
    for (const p of problems) console.log(`   ${p.id}: ${p.why}`);
  }
  if (!write) console.log(`\nprint only — pass --write to apply these ${merges.length}.`);
  return { total: companies.length, merged: merges.length, problems: problems.length };
}

if (require.main === module) {
  run({ write: process.argv.includes('--write') }).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { run, planMerges, mergedInto };
