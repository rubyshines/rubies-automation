#!/usr/bin/env node
/**
 * splitSharedB2bThreads.js — give each company its own thread row for a Gmail
 * conversation it shares with another org, and repoint its messages onto it.
 *
 * Gmail threads on subject, so one conversation regularly contains two orgs. The
 * old UNIQUE(gmail_thread_id) made that unrepresentable, and both writers keyed
 * on gmail_thread_id alone, so the second org's messages hung off the first org's
 * thread row. The panel reads the conversation by thread ownership, so it showed
 * one org's messages under another's name and hid the ones that had drifted away.
 *
 * A message's company_id is the trustworthy field — it is set per message by the
 * membership rule (an address of that company must appear in from/to/cc). This
 * script takes it as ground truth and moves the thread structure to match, never
 * the other way round.
 *
 * Idempotent: re-running finds nothing to do. Prints a plan and changes nothing
 * unless --execute is passed.
 *
 *   node scripts/splitSharedB2bThreads.js              # dry run
 *   node scripts/splitSharedB2bThreads.js --execute    # apply
 *
 * Prerequisite: the UNIQUE(company_id, gmail_thread_id) index from
 * gmail-management/b2b-outreach-schema.sql must be applied first, or the inserts
 * below can race into duplicates.
 */
require('dotenv').config();
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const sb = getSupabaseClient();

  const threads = await fetchAllPaginated(() => sb.from('b2b_threads')
    .select('id, company_id, gmail_thread_id, subject, status, thread_type, last_message_at'));
  const messages = await fetchAllPaginated(() => sb.from('b2b_messages')
    .select('id, thread_id, company_id, sent_at'));

  const byId = new Map(threads.map(t => [t.id, t]));
  const byPair = new Map(threads.map(t => [`${t.company_id}|${t.gmail_thread_id}`, t]));

  // Messages sitting on a thread that belongs to a different company.
  const misparented = messages.filter(m => {
    const t = m.thread_id && byId.get(m.thread_id);
    return t && t.company_id !== m.company_id;
  });

  if (!misparented.length) {
    console.log('Nothing to do — every message sits on a thread owned by its own company.');
    return;
  }

  // Group by the (company, gmail thread) pair each message SHOULD live under.
  const groups = new Map();
  for (const m of misparented) {
    const src = byId.get(m.thread_id);
    const key = `${m.company_id}|${src.gmail_thread_id}`;
    if (!groups.has(key)) {
      groups.set(key, { company_id: m.company_id, source: src, messages: [] });
    }
    groups.get(key).messages.push(m);
  }

  console.log(`${misparented.length} messages are parented to another company's thread.`);
  console.log(`They belong under ${groups.size} (company, gmail thread) pairs.\n`);

  let created = 0, reused = 0, moved = 0;
  for (const [key, g] of groups) {
    const existing = byPair.get(key);
    const last = g.messages.reduce((max, m) =>
      !max || new Date(m.sent_at) > new Date(max) ? m.sent_at : max, null);
    const label = `${g.company_id}  (gmail ${g.source.gmail_thread_id}, from "${g.source.company_id}")`;

    if (existing) {
      reused++;
      console.log(`  reuse  ${label} -> thread ${existing.id}, ${g.messages.length} messages`);
      if (EXECUTE) await moveMessages(sb, g.messages, existing.id, last, existing);
      moved += g.messages.length;
      continue;
    }

    created++;
    console.log(`  CREATE ${label} -> new thread, ${g.messages.length} messages`);
    if (EXECUTE) {
      const { data: row, error } = await sb.from('b2b_threads').insert({
        company_id: g.company_id,
        // Carry the source thread's descriptive fields: it is the same Gmail
        // conversation, so the subject and type are genuinely shared. Status is
        // NOT carried — 'closed' on the other org's row is their decision about
        // their relationship, and this one starts open so it can surface.
        thread_type: g.source.thread_type || 'other',
        subject: g.source.subject,
        gmail_thread_id: g.source.gmail_thread_id,
        status: 'open',
        last_message_at: last,
      }).select('id').single();
      if (error) throw new Error(`create thread for ${key}: ${error.message}`);
      byPair.set(key, { id: row.id });
      await moveMessages(sb, g.messages, row.id, last, null);
    }
    moved += g.messages.length;
  }

  console.log(`\n${EXECUTE ? 'APPLIED' : 'DRY RUN'} — ${created} threads to create, `
    + `${reused} existing to reuse, ${moved} messages to repoint.`);
  if (!EXECUTE) console.log('Re-run with --execute to apply.');
}

/** Repoint messages onto the correct thread and keep last_message_at honest. */
async function moveMessages(sb, msgs, threadId, last, existing) {
  const { error } = await sb.from('b2b_messages')
    .update({ thread_id: threadId }).in('id', msgs.map(m => m.id));
  if (error) throw new Error(`repoint messages -> ${threadId}: ${error.message}`);

  if (existing && last && (!existing.last_message_at || new Date(last) > new Date(existing.last_message_at))) {
    await sb.from('b2b_threads').update({ last_message_at: last }).eq('id', threadId);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
