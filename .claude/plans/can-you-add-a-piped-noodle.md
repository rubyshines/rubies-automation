# B2B follow-up cadence — auto-chase, auto-schedule, auto-retire

## Context

Orgs we emailed through the outreach advisor are sitting unanswered with nothing
happening to them. The follow-up ladder already exists and is correct
([cadence.js:224-230](b2b-outreach/lib/cadence.js#L224-L230)) — `followup_1` at 5
business days after a first touch, `followup_2` 10 business days after that. It is
not firing, for two separate reasons, and there is no ending: after `followup_2` a
company gets `next_action_date` +180d and reappears as a Tier-5 "overdue follow-up"
forever. There is no way to say "we tried, it didn't land, stop."

Jamie's ask: run the chase on a real cadence, retire what never answers, and land the
send inside the recipient's business hours. Autonomy decision made this session:
**guarded auto-send — no click, no shadow period**, with the guards below.

### What's actually broken

**1. Nothing runs the sweep.** `b2b-outreach/sweep.js` is deliberately unscheduled
(pull-mode, decided 2026-07-23). Five orgs are due for `followup_1` right now at
28–33 days against a 5-business-day trigger.

**2. `answered` is scoped to all time, so the ladder can never fire for any company
with history.** `cadence.js:200` reads `const answered = !!ctx.lastInboundAt` — *any*
inbound ever. P10 Qc last replied in **2022**, RISE @ LA in **2025**, LGBT Center of
Raleigh in **Nov 2025**. All three got a `community_checkin` on 19 Aug and all three
are permanently ineligible for a follow-up, because they wrote to us years ago. This
is the bug behind the complaint, and it is invisible: the queue simply shows nothing.

**3. The ladder only hangs off first-touch types.** `FIRST_TOUCH_TYPES.find(t => sent.has(t))`
means `community_checkin`, `donation_closet_pitch`, `post_samples_checkin` and
`reorder_nudge` get no chase at all — the 19 Aug partner round is booked for its next
touch on **2027-02-15**.

The all-time `answered` rule was introduced to fix a real case: an org declines, we
send a graceful close, our close is newer than their reply, and a timestamp
comparison re-arms the ladder to chase someone who already said no. That case is
solved more precisely below by making `reply_close` non-chaseable, which lets the
timestamp comparison come back safely.

## Scope

**In:** threads the outreach advisor sent (`b2b_messages.source = 'send_tool'`), last
outbound within 90 days. That is 8 companies today:

| company | last outbound | age | ladder step due |
|---|---|---|---|
| Mermaids | `intro_outreach` | 33d | `followup_1` |
| The Clare Project | `intro_outreach` | 29d | `followup_1` |
| Trans Pride Brighton | `intro_outreach` | 29d | `followup_1` |
| Not A Phase | `intro_outreach` | 29d | `followup_1` |
| The Q Corner | `intro_outreach` | 28d | `followup_1` |
| P10 Qc | `community_checkin` | 7d | `followup_1` (blocked by bug 2) |
| LGBT Center of Raleigh | `community_checkin` | 7d | `followup_1` (blocked by bug 2) |
| RISE @ LA LGBT Center | `community_checkin` | 7d | `followup_1` (blocked by bug 2) |

Correctly excluded and staying excluded: **TransActual** and **SoCirC** (last outbound
`reply_close` — they answered, we closed), **Transgender Victoria** (snoozed).

**Out:** the 51 companies whose last outbound is a manual Gmail send (`message_type`
null), including the ~32-retailer batch from ~189 days ago and org threads up to
1575 days old. Those are re-approaches, not follow-ups, and they are Jamie's call
case by case. The build must not touch them: the `source='send_tool'` + 90-day
anchor is what keeps them out.

## The cadence

Every step requires that **our outbound is still the newest message in the thread**.
If they wrote back, it is Tier 1 and we are answering, not chasing — which is also
the "nothing owed" guard, since everything we owe an org arrives as an inbound.

| step | fires | notes |
|---|---|---|
| first touch / check-in | day 0 | existing behaviour |
| `followup_1` | **5 business days** for cold types, **10 business days** for relationship types | a partner is not a lead being worked; a gentler beat matches "how are things going?" |
| `followup_2` | **10 business days** after `followup_1` | unchanged |
| retire *or* hand off | **10 business days** after `followup_2` | prospect → retire; active partner → On Me, with a note saying why |

Total arc ≈ 6 weeks from first touch to retirement.

**Chaseable types** (an ask that went unanswered): `intro_pitch`, `intro_outreach`,
`affiliate_intro`, `re_approach` (cold, 5d) and `community_checkin`,
`donation_closet_pitch`, `post_samples_checkin`, `first_order_checkin`,
`reorder_nudge`, `sample_feedback_request`, `referral_ask` (relationship, 10d).

**Never chaseable:** `reply_close`, `operator_message`, `followup_1`/`followup_2`
themselves as anchors for a third rung, and any outbound with a null `message_type`.
That last exclusion is what keeps the 51 manual sends out.

### Retire

Retire is **not** a `relationship_state`. Per the 2026-08-19 decision, `lost` claims
they went away or said no, which is false for someone who simply never replied, and
it destroys the state needed to resume. Retire reuses the existing orthogonal pause
axis: `outreach_paused_at` + `outreach_paused_reason`, indefinite, reversible, never
touching `relationship_state`, and — via `deferredSince`/`staleReply` in
`computeQueueEntry` — never able to suppress a reply that arrives afterwards. A new
`outreach_paused_source` column (`'operator' | 'cadence'`) makes auto-retired rows
queryable and bulk-reversible without string-matching the reason.

**Active partners are never retired** (Jamie's call). An org we ship donation boxes
to that misses a seasonal check-in is not a dead lead. After `followup_2` the engine
has exhausted what it can usefully do, so it **hands the relationship to Jamie** by
setting `on_me_at` — a partner going quiet must be visible now, not next season.
Donation routing is untouched throughout: that is the separate
`donation_partners.paused_at` axis, and boxes keep flowing.

On Me is the right vehicle rather than a new list. It already carries days-on-you
ageing, its own tab count and a digest section — which is precisely the visibility
this needs — and a parallel structure would be a worse copy of it. The engine going
quiet on a claimed company is the *designed* behaviour
([cadence.js:131-135](b2b-outreach/lib/cadence.js#L131-L135)), and correct here: the
last thing an unresponsive partner needs is a fourth automated email underneath the
operator.

**The claim carries a note.** The 2026-08-26 decision removed the note from On Me,
but its reasoning was that *asking a human to type one* is friction in front of a
one-click decision — which does not apply to a claim the cadence sets, where there is
no click and the engine knows the reason exactly. The `on_me_note` column already
exists and is unused. To avoid re-breaking what that decision protected (a note
written once, decaying on the one list whose defining problem is age), the note
carries only the **durable fact**:

> 3 unanswered since 19 Aug 2026; contact may have moved on

That stays true forever. What to *do* about it keeps coming live from the
relationship summary's suggested next step, rebuilt as messages land — reason static,
next step derived. The wording points at the likely cause, since three unanswered
messages to a partner usually means the contact has moved on (the standing org
failure mode: Oasis handed off in June, Carleton's turns over yearly, Valid USA's
contact left the state).

A new `on_me_source` column (`'operator' | 'cadence'`, same shape as
`outreach_paused_source`) lets the list badge engine hand-offs so they never blur
with companies Jamie picked up himself. Discharge is unchanged: send or Back to
queue, and nothing else.

## Design

### 1. Fix the ladder anchor — `b2b-outreach/lib/cadence.js`

- Anchor on the **last chaseable outbound** rather than "the first-touch type ever
  sent". Requires two new context fields (below).
- `answered` becomes `inbound after that anchor outbound`, restoring the timestamp
  comparison. Safe now because `reply_close` is not a chaseable anchor, which was the
  case the all-time rule existed to cover.
- Add `CHASEABLE_TYPES` with per-family chase intervals, and a `FOLLOWUP_MAX_AGE_DAYS
  = 90` ceiling on the anchor — past that it is a re-approach, same reasoning as the
  existing `SAMPLES_CHECKIN_MAX_AGE_DAYS`.
- Add the third rung: `followup_2` + 10 business days, still unanswered → emit a
  `retire` (prospect) or `hand_off` (active partner) decision. Neither is a message
  type — nothing is drafted either way.
- Expose an `unansweredRun` count + the run's start date on the context, so the
  hand-off note can name both. Derived from `b2b_messages`, not stored.

### 2. Context fields — `b2b-outreach/lib/queueContext.js`

`buildContexts` currently tracks `sentTypes` and `lastTypeSent` but not which
outbound was last, or how it was sent. Add `lastOutboundType`, `lastOutboundSource`
and `lastOutboundMessageAt` from the message loop (note `lastOutboundAt` is seeded
from the denormalized `b2b_companies.last_outbound_at` and is not a message anchor).
Per the standing rule, every field the new cadence branches read must be one
`buildContexts` actually sets — seven branches were unreachable for months for
exactly this reason.

### 3. Send window — new `b2b-outreach/lib/sendWindow.js` (pure)

`nextSendSlot({ timeZone, country, now })` → `{ at, timeZone, reason }`.

- Target **Mon–Fri 09:30–11:30 in the recipient's zone**. Mid-morning avoids both
  the "arrived 6am" and "arrived 5pm Friday" failure modes.
- Minute within the window is a deterministic hash of the company id, so eight
  emails don't all land at 09:30:00. No `Math.random` — it must stay pure and
  testable.
- Slot already past today → tomorrow; weekend → Monday.
- Timezone from the existing `timezoneFromLocation` in
  [meetingTimezone.js](b2b-outreach/lib/meetingTimezone.js). It resolves for 6 of the
  8 in scope (118 of 222 live companies overall).
- **Unresolved zone → do not guess one.** Pick a time that is business hours in
  *every* zone the country spans: US/Canada → 12:00–14:00 ET (= 9–11am Pacific).
  No country at all → `America/Toronto`, stated in `reason` so it is visible rather
  than assumed. This keeps the domain's "no match means no facts" rule while still
  answering, because the cost of being wrong here is an email arriving early, not a
  false sentence in customer-facing text.
- One-time backfill: run the existing [geocoder.js](customer-service/lib/geocoder.js)
  over companies with a `city` or `address` but no `region`/`country` (142 rows have
  a city) to populate the real fields. LGBT Center of Raleigh has `city='Raleigh'`
  and no country — a data gap, not an inference problem. Benefits meeting scheduling
  too.

### 4. Scheduling — schema + `b2b-outreach/lib/autoFollowUp.js`

Migration: `b2b_drafts` gains `scheduled_send_at timestamptz` and
`schedule_reason text`; `b2b_companies` gains `outreach_paused_source text` and
`on_me_source text` (`on_me_note` already exists, unused).

Two passes, both idempotent:

**Draft pass** (daily, in `daily-sync-all` after Relationship Summaries so drafts
read fresh recaps): for each in-scope company the ladder says is due, generate the
draft via the existing `generateDraftForCompany`, then stamp `scheduled_send_at` from
`nextSendSlot`. Also applies the retire/escalate decisions.

**Send pass** (every 15 min on the webhook server, alongside the existing
`reconcilePendingHolds` 3-min and `sweepUnnotifiedPreOrders` 10-min sweeps — no new
Railway service): pick up pending drafts whose `scheduled_send_at` has passed and
send via the existing `sendDraftById`, so thread bookkeeping, cadence dates,
`b2b_messages` and the `sent_body` training signal all stay on one path.

### 5. Pre-send guards (the reason auto-send is safe without a click)

Checked immediately before each send, not at draft time:

- **Fresh reply re-check.** `await discoverCompanyThreads` + `reconcileThreads` for
  that one company, then re-evaluate. Any inbound newer than the anchor → cancel the
  send, supersede the draft, let it surface as Tier 1. This is the guard that matters:
  the engine has repeatedly turned out not to see its own correspondence
  (`manualSendReconcile`, `sweepEmptyCompanies`, the shared-thread fix), each time
  finding real replies the queue read as silence. Note both functions carry 15-minute
  cooldowns — the guard needs a bypass, and a cooldown-skipped run must not be
  treated as "checked".
- **Address health.** Refuse to auto-send to a contact with `bounced_at`, or to a
  company with `contact_unknown`. Those revert to the queue. The 19 Aug round bounced
  at 12% against the ~2% that damages sender reputation on rubyshines.com, the domain
  Klaviyo shares.
- **Daily cap** on auto-sends (start at 10) so a bad batch cannot be a big batch.
  Enforced in the send pass, logged when it truncates — a silent cap reads as
  "covered everything".
- Existing gates still apply unchanged: `b2b_send_enabled`, `companyEligible`
  (pause / snooze / on-me / booked meeting), and the `deliveryMode === 'form'`
  fail-closed.

### 6. Surfaces

- **MCP tool** `b2b_followups` in
  [b2bOutreach.js](customer-service/lib/tools/b2bOutreach.js) — list what is
  scheduled, what auto-sent, what was retired; cancel a scheduled send; un-retire.
  Business logic lives in `autoFollowUp.js`; the tool is a thin interface.
- **Panel** — a scheduled draft shows its send time and zone ("sends Thu 09:47
  London") with Cancel and Send-now. The On Me list badges `on_me_source='cadence'`
  rows and renders the note, so an engine hand-off is never mistaken for something
  Jamie picked up. Any new inline handler must resolve, per the static assertion in
  `dashboardHandlers.test.js`.

## Files

- `b2b-outreach/lib/cadence.js` — anchor fix, `CHASEABLE_TYPES`, third rung
- `b2b-outreach/lib/queueContext.js` — `lastOutboundType` / `lastOutboundSource`
- `b2b-outreach/lib/sendWindow.js` — **new**, pure
- `b2b-outreach/lib/autoFollowUp.js` — **new**, draft pass + send pass + guards
- `gmail-management/b2b-outreach-schema.sql` — the three new columns
- `daily-sync-all.js` — draft pass sub-pipeline
- `webhooks/server.js` — 15-min send sweep
- `customer-service/lib/tools/b2bOutreach.js` + `customer-service/server.js` — tool + registration in `allTools`
- `customer-service/dashboard/public/app.js` — schedule display + controls
- `customer-service/test/` — new `cadenceFollowups.test.js`, `sendWindow.test.js`

## Verification

1. `node --test customer-service/test/*.test.js` — full suite green.
2. New unit tests: the P10 Qc shape (inbound in 2022, outbound 19 Aug 2026) yields
   `followup_1`; a `reply_close` anchor yields nothing; a manual send with null
   `message_type` yields nothing; a 189-day anchor yields nothing; an exhausted
   prospect retires while an exhausted `active` org is handed off with
   `on_me_source='cadence'` and a note naming the run and its start date;
   `nextSendSlot` lands inside 09:30–11:30 local across DST boundaries,
   US-no-region, and unknown country.
3. `node b2b-outreach/sweep.js` — expect the 8 companies above and **not** the 51
   manual-send rows. Diff the queue against the run captured in this session.
4. Dry-run the draft pass with a `--dry` flag: prints each company, message type,
   resolved zone and scheduled slot, writing nothing.
5. Send pass against one company with `test_send` (real email, to Jamie only,
   writes nothing) before enabling the sweep.
6. Confirm the reply guard by hand: point it at a company with a recent inbound and
   check it cancels rather than sends.
7. Deploy, then verify the first real auto-send arrived in the recipient's morning.

## After the build

Work the 8 due follow-ups. The first pass should be run with the sweep in `--dry`
mode and read before anything sends, since it is the first fully automatic B2B mail.
Then hand Jamie the named list of the ~40 out-of-scope threads (189d retailer batch,
older org threads) for the case-by-case re-approach call.

## Memory delta (propose at close-out, before push)

- `domain_b2b_sales.md` Key Decision — the ladder anchors on the last chaseable
  outbound, and why an all-time `answered` silently disabled the chase for every
  company with history. Second decision: a cadence-set On Me claim carries a note
  where an operator-set one deliberately does not, because the 2026-08-26 removal was
  about friction in front of a click, not about notes being wrong.
- `initiative_b2b_expansion.md` — push-mode cadence is live for follow-ups
  (supersedes the 2026-07-23 pull-mode-only decision).
- `parked.md` — the out-of-scope re-approach cohort; the daily send cap partially
  discharges the "send rate + sender reputation" entry.
