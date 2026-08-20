#!/usr/bin/env node
/**
 * testMeetingSchedule.js — rehearse the scheduling feature safely.
 *
 * Print-only by default. Nothing here touches a real organization unless you
 * pass --book, and even then the invite goes to Jamie and nothing is written to
 * any company's record.
 *
 *   node scripts/testMeetingSchedule.js
 *       Check the three calendars resolve, then print the availability grid.
 *
 *   node scripts/testMeetingSchedule.js --company <id>
 *       Same, plus that company's inferred timezone and any times they proposed
 *       in their latest inbound message. Reads only.
 *
 *   node scripts/testMeetingSchedule.js --company <id> --book
 *       The full end-to-end: creates a REAL calendar event with a REAL Meet
 *       link titled "[TEST] RUBIES x <Company>", invites ONLY jamie@rubyshines.com,
 *       and sends the confirmation email to you. Writes NOTHING to the company
 *       record, consumes no draft, changes no cadence dates. Delete the event
 *       afterwards.
 *
 * Flags are CLI args, not env vars, so what ran is visible in shell history.
 */
require('dotenv').config();

const { assertCalendarsResolve, BUSY_CALENDAR_IDS } = require('../shared/googleCalendarClient');
const { fetchAvailability } = require('../b2b-outreach/lib/availability');
const { timezoneFromLocation } = require('../b2b-outreach/lib/meetingTimezone');
const { extractProposedTimes } = require('../b2b-outreach/lib/proposedTimes');
const { scheduleMeeting, renderConfirmationLine } = require('../b2b-outreach/lib/scheduleMeeting');
const { getSupabaseClient } = require('../shared/supabaseClient');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = name => process.argv.includes(`--${name}`);

async function main() {
  const companyId = arg('company');
  const duration = parseInt(arg('duration', '30'), 10);
  const days = parseInt(arg('days', '5'), 10);
  const book = has('book');

  // 1. The check that matters most: can this token actually see all three?
  //    A calendar it cannot see contributes no busy blocks and reads as free.
  console.log('Checking calendars…');
  await assertCalendarsResolve();
  console.log(`✅ All ${BUSY_CALENDAR_IDS.length} calendars resolve: ${BUSY_CALENDAR_IDS.join(', ')}\n`);

  // 2. Their timezone, if a company was named.
  let company = null;
  let theirTz = { timeZone: null, source: 'unknown', reason: null, split: false };
  if (companyId) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('b2b_companies')
      .select('id, name, city, region, country, address').eq('id', companyId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`No company "${companyId}"`);
    company = data;
    theirTz = timezoneFromLocation(company);
    console.log(`Company: ${company.name} (${[company.city, company.region, company.country].filter(Boolean).join(', ') || 'no location on file'})`);
    console.log(`Their timezone: ${theirTz.timeZone || 'UNKNOWN'} — ${theirTz.source}`);
    if (theirTz.reason) console.log(`  ⚠️  ${theirTz.reason}`);
    console.log('');
  }

  // 3. The grid.
  const grid = await fetchAvailability({ durationMinutes: duration, days, theirTimeZone: theirTz.timeZone });
  console.log(`Availability — ${duration} min slots, 9-5 Eastern, weekdays, from tomorrow:\n`);
  for (const day of grid.days) {
    const notes = day.notes.length ? `   [${day.notes.map(n => n.summary).join('; ')}]` : '';
    const free = day.slots.filter(s => !s.busy);
    const busy = day.slots.filter(s => s.busy);
    console.log(`  ${day.label}${notes}`);
    console.log(`    free (${free.length}): ${free.map(s => (s.theirLabel ? `${s.label}→${s.theirLabel}` : s.label)).join('  ') || '—'}`);
    if (busy.length) {
      const blocks = [...new Set(busy.map(s => s.busyWith))];
      console.log(`    busy: ${blocks.join(', ')}`);
    }
  }
  console.log('');

  // 4. What they proposed, if anything.
  let firstProposed = null;
  if (company) {
    const sb = getSupabaseClient();
    const { data: inbound } = await sb.from('b2b_messages')
      .select('body_text, sent_at').eq('company_id', companyId).eq('direction', 'inbound')
      .order('sent_at', { ascending: false }).limit(1).maybeSingle();
    if (!inbound?.body_text) {
      console.log('No inbound message on file — nothing to read times from.\n');
    } else {
      const res = await extractProposedTimes({
        message: inbound.body_text, fallbackTimeZone: theirTz.timeZone, company_id: companyId,
      });
      console.log(`Times read from their message of ${new Date(inbound.sent_at).toLocaleDateString()}:`);
      if (res.error) console.log(`  ⚠️  ${res.error}`);
      if (!res.times.length) console.log('  (none proposed)');
      for (const t of res.times) {
        if (!t.start) { console.log(`  ${t.dayLabel || t.date} — day only${t.quote ? ` ("${t.quote}")` : ''}`); continue; }
        console.log(`  ${t.dayLabel} ${t.label} ET / ${t.theirLabel} theirs — zone ${t.zoneSource}${t.quote ? ` ("${t.quote}")` : ''}`);
        if (!firstProposed) firstProposed = t;
      }
      console.log('');
    }
  }

  if (!book) {
    console.log('Print-only. Add --book (with --company) to rehearse a real booking to yourself.');
    return;
  }

  // 5. The rehearsal booking.
  if (!company) throw new Error('--book needs --company <id>');
  const chosen = firstProposed?.start
    || grid.days.flatMap(d => d.slots).find(s => !s.busy)?.start;
  if (!chosen) throw new Error('No free slot in the window to test with.');

  const line = renderConfirmationLine({ start: new Date(chosen), theirTimeZone: theirTz.timeZone });
  const body = `Hi there,\n\nThis is a test of the RUBIES scheduling flow. ${line}\n\nJamie Alexander, RUBIES Founder`;

  console.log(`Booking a TEST meeting at ${new Date(chosen).toISOString()}…`);
  const res = await scheduleMeeting({
    company_id: companyId,
    start: chosen,
    duration_minutes: duration,
    their_timezone: theirTz.timeZone,
    subject: `[TEST] RUBIES x ${company.name}`,
    body,
    confirmed: true,
    test_mode: true,
  });

  if (!res.ok) {
    console.error(`\n❌ ${res.error}`);
    process.exit(1);
  }
  console.log(`\n✅ ${res.phase}`);
  console.log(`   Title:     ${res.title}`);
  console.log(`   When:      ${res.when_ours}${res.when_theirs ? ` (${res.when_theirs})` : ''}`);
  console.log(`   Meet link: ${res.meet_url || '(none returned)'}`);
  console.log(`   Event:     ${res.html_link}`);
  console.log(`   Invited:   you only (would have been ${res.would_invite})`);
  console.log(`\n   ${res.note}`);
}

main().catch(e => { console.error(`\n${e.message}`); process.exit(1); });
