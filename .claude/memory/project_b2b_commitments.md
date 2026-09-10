---
name: B2B commitments
description: One structured list of what Jamie owes and is waiting on, fed by meeting notes, mail and the operator; On Me derived from it; Wispr notes fetched by the server
type: project
domains: [b2b_sales, community, tech]
done_when: see the numbered list at the bottom — every item verified against the live rows, schema applied before deploy, Wispr token on Railway
originSessionId: 4b5ef4e5-3452-4089-b27e-b09a8164ffda
---
Design record: `.claude/plans/b2b-commitments.md` (decisions locked with Jamie 2026-09-10; this file
tracks execution). Absorbs `project_meeting_sync.md` piece 4 (Wispr notes ingest).

## What was built (2026-09-10, branch `wt/b2b-commitments`)

- **Table** `b2b_commitments` + `b2b_meetings` notes columns + `linked_event_ids` + `oauth_tokens`:
  `gmail-management/migrations-2026-09-10-commitments.sql` (schema record in
  `b2b-commitments-schema.sql`). Apply BEFORE deploy.
- **`b2b-outreach/lib/commitments.js`** — the one write path (`upsertCommitments`, dedupe on
  owner + normalised text against open rows), `completeCommitment` (engine may close `them`
  only), `settleOnSend`, `abandonClaims`, `listCommitments` (reading order: pinned, overdue,
  dated, undated oldest), `companiesOnMe`, `syncOnMeFlag` (the only writer of the derived
  `on_me_*` columns), `parseNextSteps` (Wispr "### Next Steps" bullets, "(Name)" → owner).
- **On Me is a query.** `triage on_me` creates a claim row (text = what the operator typed, else
  the suggested next step; completes on any send to the company); `resume` removes claim and
  cadence stubs only; the ladder hand-off is a `cadence` row. `sendB2bEmail` calls
  `settleOnSend` instead of nulling `on_me_at`. `fetchOnMe` reads `companiesOnMe`.
- **Summariser** (`relationshipSummary.js`): output gains `commitments[]` + `settled[]`; the prompt
  carries OPEN COMMITMENTS and held calls' notes in the timeline; after the summary write, new
  rows are upserted (`source` email/backfill) and `them` ids settled; `mine` never.
- **Wispr from the server**: `wisprClient.js` (MCP client over streamable HTTP, bearer token,
  refresh with rotation, token in `oauth_tokens` row → `WISPR_TOKEN_JSON` → file);
  `scripts/authWispr.js` (dynamic registration + PKCE loopback, one browser approval,
  `--print-env`). `meetingNotes.js`: lookup by every linked event id, fallback by start ±45 min +
  title token, store summary/transcript/link, mark held (never overwrite a no-show), lift Next
  Steps (theirs prefixed with the person's name), force a recap refresh. Triggers: nightly
  "Meeting Notes" step in `daily-sync-all` after Calendar Meetings; `recordMeetingOutcome(held)`.
- **Calendar dedupe**: `meetingSync.sameCallSibling` links a second event id for the same call
  (same company, start ±15 min) instead of inserting a second row.
- **Tools**: `b2b_meeting_notes` (fetch / force / manual fallback with summary + commitments),
  `b2b_commitments` (list/add/done/reopen/delete/edit). `b2b_meeting_outcome held` reports the
  notes result.
- **Dashboard**: Outreach sidebar modes To do (rows are promises; add box with company
  datalist; check, edit via prompts, delete; folds for waiting-on-them / general / done) and
  On Me (company-grouped, items as the reason line). "Where this stands" gains a You owe / They
  owe block with I owe / They owe add, Done, and "Done, write to them" (rides on the draft as
  `structured.completes_commitment_id`; the send completes it and links the message). Calls
  block shows folded notes + Wispr link. "On me" button → "Add to my list" (prompt prefilled
  with the next step). Endpoints: `GET/POST /api/b2b/commitments`, `POST /api/b2b/commitments/:id`.
- **Backfill**: `b2b-outreach/sync/backfillCommitments.js` (print-only; `--write` runs the
  summariser with `commitmentSource: 'backfill'` over non-prospect companies with a human reply
  in the last 60 days).
- **Tests**: `b2bCommitments.test.js`, `meetingNotes.test.js`, `b2bOnMeList.test.js` (rewritten).

## Deviations from the plan

- The post-call template does NOT pre-fill its notes slot from the summary: the summary is Sonnet
  text and the template's send guard exists so that Jamie writes the notes to a partner in his
  own words. The summary is shown in the Calls block right above the composer instead.
- The advisor's `open_commitments` on a just-sent draft is not passed to the summariser as a
  hint; the summariser reads the sent message itself. Revisit if extraction misses our promises.
- Meeting Next Steps carry no due dates (deterministic parse); Jamie adds dates inline.

## Progress

Done 2026-09-10: migration applied; Wispr connected (token lives in the `oauth_tokens` row, so
the Railway env var is a bootstrap only, not required); Le JAG duplicate merged (row 13 linked
onto 7); the nightly Meeting Notes step run by hand fetched all three recordings through the
server (two by calendar id, Stand with Trans by time + title), marked them held with summary,
transcript and link, and lifted 13 items; the recap refresh then added 3 more from mail and
settled one of theirs (Katy's organizer contact, from message 7399). The two pre-existing On Me
claims migrated to claim rows keeping their age. Endpoints smoke-tested with a signed session.

## Remaining (in order)

1. Backfill: dry run lists 39 companies with a human reply in 60 days; `--write` after Jamie's
   go, then he tidies in To do.
2. Push, verify Railway's nightly line "Meeting Notes".
3. Close-out memory: domain Key Decision, `project_meeting_sync.md` piece 4 done by this,
   parked entries (digest section, CS as a source, aged-theirs chase, "gave up" close).

## done_when

- The fourteen items from the three calls exist as rows with the right owners and show in the
  To do view; Le JAG has one meeting row. They got there by the server fetching the recordings
  (nightly run or the Held button) with `WISPR_TOKEN_JSON` on Railway and no Claude session
  involved; each call is marked held with its summary and Wispr link on the row.
- Pressing Held on a call whose recording exists shows its notes on the company in the same
  visit; a call with no recording yet stays held with "notes pending".
- Blue Mountain Clinic shows one their-item (sign + survey) and one my-item (size run +
  listing) produced by the backfill without hand entry.
- The two On Me companies appear under On Me with no `on_me_at` written by anything but
  `syncOnMeFlag`; claiming creates an item; "Done, write to them" completes it on send and links
  the message.
- A their-item is closed by the summariser when the matching reply lands; a my-item never is
  (unit test).
- Ticking off works on the phone. Full suite green, handler static test green, schema applied
  before deploy.
