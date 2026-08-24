#!/usr/bin/env node
/**
 * Label historical calendar notifications in b2b_messages.
 *
 * Inbound calendar mail (RSVPs, invitations, updates, cancellations) arrives
 * from the contact's own address and was stored with message_type null — or,
 * where Google's footer happened to trip the auto-responder heuristic,
 * 'auto_reply'. The null ones are the problem: queueContext reads them as a
 * human reply, so an acceptance of a call we just booked reads as "replied,
 * waiting on us". Going forward classifyInbound labels these at ingest; this
 * catches what is already on the record.
 *
 * b2b_messages has no subject column, so the subject comes from the thread.
 * That is a proxy — Gmail threads on subject, so a human CAN reply inside a
 * notification's thread — which is why every row must ALSO pass the body test
 * (a real reply's body looks nothing like a calendar notification, and the
 * empty-body case is itself the Pub/Sub RSVP shape).
 *
 * Print-only by default. Pass --live to write.
 */
require('dotenv').config();
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');
const { detectCalendarNotice } = require('../b2b-outreach/lib/replyCorrelation');

const CALENDAR_BODY = /(calendar\.google\.com\/calendar\/event|has (accepted|declined|tentatively accepted) this invitation|this event has been (updated|cancell?ed|canceled)|BEGIN:VCALENDAR)/i;

async function main() {
  const live = process.argv.includes('--live');
  const sb = getSupabaseClient();

  const threads = await fetchAllPaginated(() => sb.from('b2b_threads').select('id, subject'));
  const subjectById = new Map(threads.map(t => [t.id, t.subject || '']));

  const messages = await fetchAllPaginated(() => sb.from('b2b_messages')
    .select('id, thread_id, company_id, message_type, body_text, sent_at')
    .eq('direction', 'inbound')
    .order('id', { ascending: true }));

  const hits = [];
  for (const m of messages) {
    if (m.message_type && m.message_type !== 'auto_reply') continue;
    const subject = subjectById.get(m.thread_id) || '';
    if (!detectCalendarNotice({ subject, body: m.body_text })) continue;
    // Belt and braces on the thread-subject proxy: the row's own body must
    // agree, or be empty (the Pub/Sub RSVP, which carries no text at all).
    const body = String(m.body_text || '').trim();
    if (body && !CALENDAR_BODY.test(body)) continue;
    hits.push({ ...m, subject });
  }

  console.log(`${messages.length} inbound messages scanned, ${hits.length} calendar notifications found`);
  for (const h of hits) {
    console.log(`  #${h.id} ${h.sent_at?.slice(0, 10)} ${h.company_id} [${h.message_type || 'null'}] ${h.subject.slice(0, 80)}`);
  }
  if (!hits.length) return;
  if (!live) {
    console.log('\nPrint-only. Re-run with --live to write message_type=calendar_notice.');
    return;
  }
  for (const h of hits) {
    const { error } = await sb.from('b2b_messages')
      .update({ message_type: 'calendar_notice' }).eq('id', h.id);
    if (error) console.error(`  #${h.id} FAILED: ${error.message}`);
  }
  console.log(`\nLabeled ${hits.length} messages.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
