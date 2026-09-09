---
name: Calendar-driven meetings
description: Google Calendar becomes the source of truth for every B2B call (ours or partner-booked), with no-show handling and Wispr meeting notes on top
type: project
domains: [b2b_sales, community, tech]
done_when: see the numbered list at the bottom — pieces 1 to 3 shipped and verified against the live cases; piece 4 (Wispr notes ingest) specced after the first recorded calls and built as its own session
originSessionId: e4986406-755d-414a-adf5-4842e350a8bf
---
## Problem

`b2b_meetings` only ever held calls booked from the Outreach panel (Book & Send). A call a
partner books through their own scheduler (Calendly, their Google Calendar) has no row, so
the cadence does not suppress under it, the post-call follow-up never fires for it, and the
thank-you closer had to parse "Invitation: …" email subjects as a stopgap. Reschedules and
cancellations of OUR bookings also never reached the row. Three live cases on 2026-09-09:

- **Stand with Trans**: Dion booked via Calendly (Thu Sep 10, 10:00 ET after a reschedule).
  No row. The engine saw only the "Updated invitation" email.
- **Le JAG**: Philippe's Outlook is French, so the RSVP arrived as "Acceptée : RUBIES x Le
  JAG" with an empty body and a `text/calendar; method=REPLY` part. The English-only
  subject detector filed it as a human reply on a new open thread in Tier 1.
- **P10 Qc**: a no-show. Row 5 stayed `booked`, so the next morning proposed "Great talking
  with you on Wednesday" for a call that never happened. The only exit was a dismiss whose
  meaning conflates "no follow-up needed" with "it did not happen".

Separately, meeting NOTES: Jamie now records calls with Wispr Flow Notetaker (system audio,
no bot, works on Meet/Zoom/anything) and its read-only MCP is connected to Claude Code
(`claude mcp get wispr`). Wispr's `calendar_id` for an event IS the Google event id, so notes
join to meeting rows on that key once the rows exist for every call.

## Design (locked with Jamie 2026-09-09; build order is the numbering)

### 1. Calendar-driven meeting sync (foundation)

`b2b-outreach/lib/meetingSync.js`. Reads events on the organizer calendar
(`jamie@rubyshines.com`, the one the engine writes to and the one partner invites land on)
from 7 days back to 90 days ahead, `singleEvents` + `showDeleted`. For each timed event with
at least one external attendee, resolve attendees to companies with the SAME matching the
inbound correlator uses (exact contact → general_email → identifying domain via website /
peer contacts; free-mail excluded) — extracted into `b2b-outreach/lib/companyMatch.js` so
the two can never disagree. Upsert `b2b_meetings` keyed on `(company_id, google_event_id)`:

- New event → row with `source='calendar_sync'`, `booked_by='partner'` when the organizer is
  not us (else `'operator'`), `their_timezone` from `timezoneFromLocation(company)` (no
  guess when the country is multi-zone, same rule as Book & Send), `thread_id` null.
- Existing row → `starts_at`/`ends_at`/`duration_minutes`/`title`/`attendee_emails`/
  `attendee_responses`/`meet_url`/`html_link`/`organizer_email`/`synced_at` refreshed.
  `notes`, `their_timezone`, `thread_id`, `booked_by`, `outcome*` are never overwritten.
- Status: event cancelled or Jamie declined → `cancelled`. A cancelled row whose event is
  live again → `booked`. A `followup_dismissed` row flips back to `booked` only when its
  start moved into the future (a real reschedule); otherwise the dismissal stands.
- Unmatched events (external attendees, no company) are counted and named in the run
  result, never guessed onto a company.

Runs nightly in `daily-sync-all` ("Calendar Meetings", before Thread Discovery) and live
from the Gmail push handler whenever an inbound classifies as `calendar_notice` (scoped to
that company). Fail-soft in both places.

### 2. No-show outcome + missed-call template

The engine cannot detect attendance, so the operator records it. `b2b_meetings.outcome`
(`held` | `no_show`) + `outcome_at` + `outcome_note`, recorded with its own timestamp rather
than by overwriting `status`, so a rescheduled event on the same row keeps history and
no-shows stay countable. Only for calls whose start is past.

Marking `no_show`: the post-call queue entry disappears (`postCallFollowupDue` returns null
on a no-show), and the composer opens with the `missed_call` template — neutral, blame-free,
times theirs to suggest (standing rule): "Sorry we missed each other on Wednesday. Let me
know if you would like to find another time. Feel free to suggest a few." Sent as
`message_type='missed_call'` with `next_touch_days=7`, and the follow-up ladder chases it
after 5 business days like any other ask. After TWO no-shows on a company, no reschedule
ask is offered: the annual October check-in carries the relationship.

Surfaces: a "Calls" block in the panel's relationship section (upcoming call with link and
who booked it; recent past calls with Held / Didn't happen buttons until an outcome is
recorded), a "Didn't happen" button on the post-call queue entry beside "No follow-up
needed", `POST /api/b2b/meetings/:id/outcome`, and the `b2b_meeting_outcome` console tool.
`b2b_dismiss_post_call` keeps meaning only "no email follow-up needed".

### 3. Cleanup

- `thankYouCloser.describeBookedCall` reads meeting rows only ("Booked via our/their
  calendar"). The invitation-subject parsing and `INVITE_SUBJECT`/`CANCEL_SUBJECT` are
  deleted.
- Gmail intake records the calendar MIME method (`REQUEST`/`REPLY`/`CANCEL`) from any
  `text/calendar` part into `email_messages.calendar_method`, and the push handler passes
  it to `classifyInbound` as a hint that outranks the subject test. Language-independent,
  same pattern as the auto-reply header hint.

### 4. Wispr meeting notes ingest (after the first recorded calls; own session)

A Claude session reads a recording via the Wispr MCP (`get_meeting` with transcript,
`get_meeting_attendee_emails`, `calendar_id` = Google event id) and calls an agent-agnostic
ingest tool with the event id + attendee emails + structured summary (decisions, our
commitments, their commitments, org facts) + consent flag + Wispr share link. The tool finds
the row by event id (falls back to domain matching, refuses when nothing matches), writes
the summary onto the meeting row; the relationship summariser treats meeting summaries as a
dated input beside messages; the post-call template pre-fills its notes slot from the
stored summary (the send guard on the placeholder stays). Decisions still open for Jamie:
store transcripts (recommend: yes on the row, but only the summary ever reaches an AI
context) and non-company calls (recommend: list as unmatched, no records). Pull is
session-driven; whether a scheduled cloud routine can hold the Wispr connector is unverified.

## Alternatives considered

- Parsing partner invitation emails (the shipped stopgap): language-dependent, misses
  reschedules, cannot see RSVPs. Removed in piece 3.
- Deriving no-show from the absence of a Wispr recording: a recording Jamie forgot to start
  would read as a no-show. Attendance is an operator fact.
- Overwriting `status='no_show'`: loses the booked → rescheduled history on a row and makes
  no-shows uncountable.

## Verification against the live cases (done_when)

1. Nightly/live sync creates a `booked_by='partner'` row for Stand with Trans' Calendly call
   (event `tfe2njp80v0nrdlqq7ufopk4ok`, Thu Sep 10 10:00 ET) and the company stops appearing
   in the cadence while it is upcoming; the day after, it surfaces as post-call follow-up.
2. Le JAG's French RSVP (or any `method=REPLY` mail) classifies as `calendar_notice`, born
   closed, never Tier 1.
3. Marking P10-style no-show clears the post-call entry and opens the missed-call template;
   a second no-show on the same company offers no template and says why.
4. Closer tests pass with the invitation parsing gone; `describeBookedCall` describes
   partner-booked rows.
5. `email_messages.calendar_method` and the `b2b_meetings` columns exist in production
   BEFORE the code deploys (the push path upserts the new column).
6. `node --test customer-service/test/*.test.js` green; dashboard handler static test green.
7. Railway `daily-sync-all` carries `GOOGLE_CALENDAR_TOKEN_JSON` (verified 2026-09-09) so the
   nightly step runs; the digest shows a "Calendar Meetings" line.
