# Meeting scheduling from the Outreach panel (RUBIES x <Company>)

Design session 2026-08-20. Decisions below are **closed** unless marked open.

## Problem

Org partnerships are call-shaped — every org relationship that advanced did so on a video call, and
the community advisor prompt already pushes threads toward one. But once an org replies "Tuesday or
Thursday afternoon works, we're on Pacific", everything after that is manual: read the times, check
three calendars, pick one, create an event with a Meet link, invite them, and write a reply stating
the time in both zones. That gap is where meetings get missed — the community prompt names *missed
scheduled calls* as a leading reason org relationships stalled, and two of three historically missed
meetings were timezone or calendar confusion.

Two distinct moments get called "scheduling" and they need different things:

1. **Propose** — we want to move an engaged thread to a call. The prompt handles the *wording* well
   already; what is missing is only the lookup, i.e. knowing which times are actually free without
   leaving the panel. Solved by a read-only availability view, not by generating text — see below.
2. **Confirm** — they named times and someone has to turn that into a booked call. **This is the
   manual work and the feature is aimed here.**

## Locked decisions

### Calendars and availability

- **All three of Jamie's calendars count as busy**, queried explicitly by ID via `freebusy.query`:
  `jamie@rubyshines.com`, `iamjamiealexander@gmail.com`, `jamie@bridgecard.app`. Verified 2026-08-20
  — all three are on one calendar list and all three report `America/Toronto`, so Eastern is their
  native zone and no per-calendar zone conversion is needed.
- **Overlaying a calendar in the Google UI is not the same as freebusy seeing it.** `freebusy.query`
  returns only the calendar IDs asked for. Assert all three IDs resolve at startup and fail loudly if
  one doesn't — a missing calendar produces a confidently empty busy list, which is the silent-wrong
  failure mode this codebase keeps getting bitten by.
- **The OAuth token must be minted from the Google account that owns that calendar list.** Re-authing
  as a different rubyshines identity makes the other two calendars vanish with no error.
- `Holidays in Canada` (`en.canadian#holiday@group.v.calendar.google.com`) is on the list. Treat a
  holiday as *grey the day*, not *hide it* — offering an org a call on Boxing Day is a bad look, but
  the operator may have a reason.
- Working window: **9:00–17:00 ET, Mon–Fri**, 30-minute slots.
- **No same-day booking** — earliest offer is the next business day.
- **No padding** around existing events.
- **No soft-holds on proposed times.** Volume is low enough that double-offering the same slot to two
  orgs is not a real risk; skip the machinery. (Revisit only if it actually happens.)

### Meeting defaults

- Title: `RUBIES x <Company>`, prefilled from `b2b_companies.name`, editable.
- Duration: **30 minutes default, overridable per booking.** Not a per-company setting.
- Attendees: prefilled from the thread's contacts via the existing `resolveRecipient` path.
- **The Meet link lives in the Google invite only.** It does not go in the reply body. Google sends
  the invite (`sendUpdates`), the reply states the time.
- Meet link generated via `events.insert` with `conferenceData.createRequest` and
  `conferenceDataVersion: 1`.

### The reply

- Booking and telling them are **one action**: picking a slot creates the event *and* sends the
  reply, with the confirmed time written into the draft. A booked event the other side was never told
  about is worse than no feature.
- The confirmed time is written **in both zones** ("Tuesday 4pm Eastern, 1pm your time"). This is an
  existing prompt rule earned from real missed meetings — the feature fits underneath it and does not
  reopen it. The related rules stay intact: never narrate the scheduling mechanics, never announce
  that an invite is coming, name Google Meet only when the reader wouldn't otherwise know where to
  turn up.

### Reading their proposed times

- **Sonnet** extracts proposed times and any stated timezone from the latest inbound message.
  Justified under the model policy because it fails visibly — the operator sees resolved slots and
  picks one before anything is booked. Add the code comment saying so.
- **Timezone fallback is deterministic, not a second model guess:** state/province → IANA zone for US
  and Canada, country → zone for single-zone countries, and a multi-zone country with no region gets
  **no answer rather than a wrong one**. This follows the domain's standing rule that no match must
  mean no facts — a bad inference lands directly in customer-facing text.
- The panel shows the **source** of the zone, editable inline: "they said Pacific" /
  "assuming Pacific — inferred from Portland, OR" / "unknown, please set". A wrong inference must be
  catchable at a glance and can never be silently applied.
- Once their zone is known, each slot shows **their local time alongside ET**, and slots landing
  outside roughly 08:00–20:00 local for them are **greyed, not hidden**. Without this the grid looks
  fine while every option is unsociable for the German and Australian partners.

### Proposing times is a lookup, not a draft (decided 2026-08-20)

**Nothing writes proposed times into a draft.** When no time is being booked, the panel is a
**read-only availability view** — free and busy across the three calendars — and Jamie types whatever
times he wants into the draft himself. No slot selection, no text insertion, no "Offer & Send".

This is the deliberate simplification, and it removes the riskiest part of the feature along with a
lot of machinery that only existed to make it safe:

- No availability injected into the advisor's context, so **the advisor never names a time** and
  cannot invent one in customer-facing text.
- No trigger rules, no org-only gate, no "slots in context license naming a time" safety property.
  The lookup is simply always available.
- No send-time freebusy re-check for proposed slots, and no `sendB2bEmail` changes at all.

Accepted trade: a time typed by hand into a draft that then sits pending is not re-validated against
the calendar before it sends. At current volumes that is a human-owned risk and not worth machinery.

The existing prompt behaviour is untouched — the advisor keeps asking openly ("Send me a few times
that work in the next week or two"), which the prompt already documents as a complete ask on its own.

### Architecture

Business logic in MCP tools, panel is a thin interface (standing technical rule).

- `calendar_availability` — freebusy across the three calendars → slot list. Read-only.
- `schedule_meeting` — creates the event + Meet link, invites attendees.

Both **agent-agnostic** with `company_id` optional, so a supplier or freelancer call can be booked
later by any advisor. V1 surfaces them only in the Outreach panel.

- **Auth:** Gmail runs on a user OAuth token scoped `gmail.modify` only
  (`gmail-management/lib/gmailClient.js`). Calendar needs a re-auth adding calendar scopes. Request
  both scopes and write to a **separate token file / env var**, leaving Gmail's untouched — re-issuing
  a token that drops `gmail.modify` breaks CS intake. Railway needs the new env var.
- **Storage:** a `b2b_meetings` table, keyed on company + thread, holding the Google event ID, start,
  duration, attendee list and their resolved timezone. A relationship has several calls over its life,
  so this is a table and not a column on `b2b_threads`. Per the shared-thread lesson, do not make
  `google_event_id` globally UNIQUE without checking whether one event can legitimately serve two
  company rows.

### Cadence integration

This is where most of the value is — a meeting that is a record rather than a sentence in an email
can change what the engine does.

- A company with a call booked in the near future is **not nudged** — it is not waiting on us.
- **`post_call_followup`** message type, due shortly after the call happens.
- ⚠️ **Trap to respect:** `cadence.js` branches may only read context that `buildContexts` actually
  sets — seven branches were unreachable for months because the table was written to the design and
  the context to what Tier 1 needed. Adding `post_call_followup` to `NEXT_ACTION_DAYS` means adding
  its meeting fields to `buildContexts` in the same change, and there is an existing test asserting
  deleted message types stay deleted that will need to accommodate the new one.
- Scope call: booked-call suppression is small and stays in V1. `post_call_followup` is the piece to
  cut first if scope bites.

## Out of scope (phase 2)

- **Reschedule and cancel.** "Can we push to Thursday?" is common and nearly free once the event ID is
  held, but deliberately deferred. Until it lands, a change of time means going into Google Calendar
  by hand.
- Soft-holds on proposed slots.
- Any surface for company-less meetings (the tools support it; no UI).

## done_when

- The three calendar IDs resolve and freebusy returns busy blocks from all three.
- Opening Schedule on any company shows a read-only free/busy view of the next ~10 business days,
  9–5 ET, with existing appointments visible — enough to type times into a draft by hand.
- Opening a company with an inbound message proposing times shows those times resolved to ET, marked
  free/busy, with the timezone source labelled.
- Picking a slot creates a Google event titled `RUBIES x <Company>` with a Meet link, invites the
  contact, and sends a reply stating the time in both zones — in one action.
- A company with a booked call does not appear in the cadence queue as due.
- Tests cover the deterministic pieces: slot generation against busy blocks, the 9–5/no-same-day/
  Mon–Fri window, and the address → timezone lookup including the "no answer" case.
