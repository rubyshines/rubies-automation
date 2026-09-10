# B2B commitments — one structured list of what Jamie owes and is waiting on

Status: planned (discussed 2026-09-10). Promote to `project_b2b_commitments.md` when the build starts.
Domains: b2b_sales, community, tech
Related: `project_meeting_sync.md` piece 4 (Wispr notes ingest) is absorbed by this plan.

## Problem

Three partner calls on 2026-09-10 (Le JAG, Stand with Trans, COLAGE) produced seven things
Jamie owes and seven he is waiting on. Nothing in the system can hold them. What exists is
prose: the summariser writes a paragraph and ONE next-step sentence per company with one
owner, and the advisor lists promises on a draft as free text. A commitment was never defined
as a thing (who owes it, to whom, by when, is it done), so it cannot be listed, counted or
checked off, and it is rewritten every time the summary reruns. Blue Mountain Clinic's "waiting
on Fearne to sign the agreement" survives only because the model said it again yesterday, and
it is visible only by opening that one company out of 240.

On Me today is a per-company timestamp meaning "I will answer this myself". Both rows in it
are tasks ("send the QR code you promised", "follow up about the February call"). It is the
same thing as a commitment, minus the structure.

## Decisions locked with Jamie (2026-09-10)

1. **One entity, a commitment (shown as "To do").** Text, company (optional), owner
   (`me` | `them`), source (`meeting` | `email` | `claim` | `cadence` | `manual`) with a
   reference to the meeting or message it came from, optional due date, `open` | `done`,
   and when done, the message that settled it if one did. Original captured text kept
   beside the editable text (operator edits are training signal).
2. **On Me is a query, not a state.** A company is On Me when it has at least one open
   commitment owned by me. Nothing sets On Me directly; `on_me_at` stops being written.
   Every reader of the flag today (cadence suppression, pending-draft exclusion, tab count,
   digest section) reads the query and behaves as it does now. This is the sync guarantee:
   one store, nothing to keep in step.
3. **Three ways in, one write path.** Meeting (Wispr ingest reads Next Steps lines; the
   "(Name)" prefix decides owner), email (the summariser's output grows a commitments list,
   with the company's open items passed in so it returns only new ones and which existing
   ones the latest message settled), by hand (the On Me button becomes "Add to my list",
   prefilled from the stored next step; plain add box in the To do view, typing a company
   name attaches it).
4. **The engine may complete theirs, never mine.** When Dion's intro lands the summariser
   closes "Dion: intro Jamie to Affirmations". Nothing Jamie promised is marked done by a
   model reading mail. Mine close by his check or by his send.
5. **Finishing mine leads back to the company.** Clicking a row opens the company detail
   (composer ready, that item highlighted). Two finishes: a plain check (no email needed),
   and "Done, write to them" (opens the composer; the item completes when that message
   sends, and the two are linked). A claim-created item ("reply to X") is linked to its
   thread and completes on any send in that thread, so today's On Me habit costs no click.
6. **Waiting on them is the same row, owner `them`.** Own fold, aged in days, quiet (no red).
   The engine closes them as they deliver. No chasing built now: the existing ladder already
   chases engine sends for "no reply"; an aged-commitment cadence condition is a later
   decision after watching the fold for a few weeks.
7. **Edit, delete, done.** Text and date editable inline. Delete removes a wrong capture.
   No "dropped" state for now (open: a quiet "gave up" close for theirs, so the recap and the
   October check-in know they never came through; decide when the fold has history).
8. **Two views over one table, replacing the On Me sidebar mode in Outreach.** "To do": rows
   are commitments; mine first (overdue, dated soonest, undated oldest), then the
   waiting-on-them fold, then a general fold for items with no company, then done this week.
   "On Me": rows are companies (the existing render) with the count of open items and the
   oldest one as the reason line. Company-less items never affect On Me.
9. **Backfill from recent conversations, reviewed once.** The engine went live late July, so
   "recent" is small and recognisable. Seed from companies with a back-and-forth since then
   (non-prospect state, conversation in the last ~60 days) plus the three calls. Rows are
   marked engine-created; Jamie deletes and fixes on the first pass, then the engine only
   adds going forward.
10. **Noise kills it.** The extractor adds only when someone clearly says they will do
    something. Miss one rather than invent one. Sonnet, as the summariser is today (narrow
    extraction over text we hold, operator reads it before acting).
11. **Not in the daily sync yet.** Eventually the digest's On Me section becomes this list;
    not part of this build.
12. **CS stays out.** CS tickets keep their own On Me and follow-up logic. Shape the table so
    a ticket could be a source later; do not wire it.
13. **Phone matters.** The To do view must work as a simple list in the PWA; ticking off after
    a call happens on the phone.
14. **This is the seed of the supervisor's first question** ("what does Jamie owe, what is he
    waiting on"). Keep the tool agent-agnostic and the table not B2B-specific in shape.

## Data

New table `b2b_commitments` (name kept in the b2b_ family for now; schema SQL in
`gmail-management/`, idempotent, applied BEFORE code deploys):

- `id`, `company_id` (nullable FK), `thread_id` (nullable), `meeting_id` (nullable),
  `source_message_id` (nullable), `owner` (`me`|`them`), `text`, `original_text`,
  `due_on` (date, nullable), `status` (`open`|`done`), `done_at`, `done_message_id`,
  `completes_on_send` (bool; true for claim-created reply items),
  `blocked_by` (nullable self-FK; e.g. COLAGE shipment waits on the organizer contact),
  `source` (`meeting`|`email`|`claim`|`cadence`|`manual`|`backfill`), `created_by`
  (`operator`|`engine`), `created_at`, `updated_at`.
- Indexes: `(company_id, status)`, `(owner, status, due_on)`.

`b2b_meetings` gains `summary` (text), `wispr_share_link`, `wispr_meeting_id`,
`transcript` (stored on the row; only the summary ever reaches an AI context).

## Code (all business logic in one lib + agent-agnostic tools)

- `b2b-outreach/lib/commitments.js`: `upsertCommitments` (the one write path; dedupes on
  open items by company + normalised text), `completeCommitment`, `deleteCommitment`,
  `listCommitments`, `companiesOnMe` (the query that replaces `on_me_at`).
- `queueService.fetchOnMe` reads `companiesOnMe`. Cadence On Me suppression and
  `mergePendingDraftEntries` read the same query. Ladder hand-off writes a `cadence`
  commitment with its count-and-date note instead of `on_me_at`/`on_me_note`.
- `relationshipSummary.js`: output schema gains `commitments: [{owner, text, due_on}]` and
  `settled: [id]`; open items are rendered into its input; writes through
  `upsertCommitments`; may only settle `owner='them'` rows. The advisor's
  `open_commitments` for a just-sent draft is passed as a hint.
- **Meeting notes come in by themselves** (decided 2026-09-10; replaces the session-driven
  pull in `project_meeting_sync.md` piece 4). The server holds its own Wispr connection:
  `b2b-outreach/lib/wisprClient.js` is an MCP client (`@modelcontextprotocol/sdk`, already a
  dependency) against `https://api.wisprflow.ai/connect/mcp`. Auth verified feasible
  2026-09-10 from the published discovery metadata: the auth server
  (`mcp-auth.wisprflow.com`) offers dynamic client registration, `refresh_token` and
  `device_code` grants, and `offline_access`. One-time setup script
  (`scripts/wisprAuth.js`): registers a client, runs the device-code flow (Jamie approves
  once in a browser), prints the refresh token; stored as `WISPR_TOKEN_JSON` on Railway,
  same pattern as `GOOGLE_CALENDAR_TOKEN_JSON`. The client refreshes on use and fails soft:
  a dead token logs a warning and the panel's Calls block says "notes not fetched, run
  `b2b_meeting_notes` by hand", so the manual path (a Claude session reading Wispr through
  its own connector and calling the tool) stays as the fallback.
- `b2b-outreach/lib/meetingNotes.js` `ingestMeetingNotes(meetingRow)`: looks the recording up
  by calendar event id (`get_meeting_by_calendar_id`, trying every event id linked to the
  row); when found, stores summary, share link, Wispr meeting id and transcript on the row,
  marks `outcome='held'` (a recording is proof the call happened; absence proves nothing,
  per the no-show decision), and runs the commitments extractor over the Next Steps section
  (Sonnet, narrow extraction, `me`/`them` from the name prefix) through `upsertCommitments`.
  Idempotent: a row with a summary is skipped unless `force`.
- **Two triggers, same function.** (1) Nightly in `daily-sync-all`, after Calendar Meetings:
  every row with `starts_at` in the last 7 days, not cancelled, no summary yet. (2) The
  panel's "Held" button and `b2b_meeting_outcome held` run it immediately for that row, so
  the notes are on the company before Jamie writes the post-call email; if Wispr has not
  finalised yet, the nightly pass catches it.
- Console tool `b2b_meeting_notes` (agent-agnostic): `{meeting_id | google_event_id,
  force?}` runs the same ingest, or accepts an explicit summary + commitments for the manual
  fallback. Finds the row by event id, falls back to company match, refuses when nothing
  matches.
- The post-call template pre-fills its notes slot from the summary (placeholder send guard
  stays). The panel's Calls block shows a held call with its summary expandable in place and
  a link to the Wispr notes page; the relationship summariser reads meeting summaries as
  dated inputs beside messages, so the recap says "call held 10 September, agreed X" rather
  than inferring it from a thank-you email.
- Non-company recordings (a call with no company match) are listed in the run result as
  unmatched, never guessed onto a company. Only the summary ever reaches an AI context.
- Meeting sync dedupe: Le JAG has two rows for the same call (our Book & Send event and
  Philippe's own invite arrived as separate Google events). Same company, same start, both
  live: treat as one call (keep the operator row, link the partner event id on it).
- Console tools: `b2b_commitments` (list/add/complete/delete) alongside `b2b_meeting_notes`.
- Dashboard: `GET/POST /api/b2b/commitments`, the two sidebar modes, inline edit/check/
  delete, "Add to my list" in the detail pane replacing the On Me button, the commitments
  block in "Where this stands" (replaces the single Next line when items exist), and the
  send path completing a linked item. Handler static test must stay green.
- `sendDraftById`: completes the commitment named in the draft's `structured` (set by "Done,
  write to them") and any `completes_on_send` item on that thread.

## Backfill (one script, dry-run by default, `--write` to apply)

`b2b-outreach/scripts/backfillCommitments.js`: companies with `relationship_state` not
prospect and a message in the last 60 days; run the extractor over their recent messages
(same prompt as the summariser's commitments step); insert with `source='backfill'`,
`created_by='engine'`. Migrate the two `on_me_at` rows as `claim` items
(`completes_on_send`). Ingest the three 2026-09-10 calls via `b2b_meeting_notes`.

## Build order

1. Schema + `commitments.js` + tests (dedupe, complete rules, the On Me query).
2. Summariser extension + the engine-never-completes-mine test.
3. Wispr client + one-time auth script (token on Railway) + `ingestMeetingNotes` + the
   nightly and Held triggers + `b2b_meeting_notes` tool + meeting-row dedupe. Prove it on
   the three calls: run it, and they come in without a session reading Wispr.
4. On Me readers switched to the query; migrate the two claims; ladder hand-off writes items.
5. Backfill script, dry run reviewed with Jamie, then written.
6. Dashboard: To do + On Me modes, detail-pane block, add/edit/check/delete, send completion.
7. Close-out: `project_meeting_sync.md` piece 4 marked done by this; domain file Key Decision
   ("a commitment is a row, On Me is a query over it"); parked entries for the digest section,
   CS as a source, aged-theirs cadence condition, "gave up" close.

## done_when

- The fourteen items from the three calls exist as rows with the right owners and show in
  the To do view; Le JAG has one meeting row. They got there by the server fetching the
  recordings itself (nightly run or the Held button), with `WISPR_TOKEN_JSON` on Railway and
  no Claude session involved; each call is marked held with its summary and Wispr link on
  the row.
- Pressing Held on a call whose recording exists shows its notes on the company within the
  same visit; a call with no recording yet stays held with "notes pending" and is picked up
  by the next nightly run.
- Blue Mountain Clinic shows one their-item (sign + survey) and one my-item (size run +
  listing) blocked on it, produced by the backfill without hand entry.
- The two On Me companies appear under On Me with no `on_me_at` written; claiming from a
  conversation creates an item; sending from "Done, write to them" completes it and links
  the message.
- A their-item is closed by the summariser when the matching reply lands (scenario test);
  a my-item is never closed by the summariser (unit test).
- Ticking off works on the phone.
- Full suite green, dashboard handler test green, schema applied before deploy.
