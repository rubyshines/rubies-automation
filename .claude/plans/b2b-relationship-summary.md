# B2B Outreach — rolling relationship summary + next step


## Context

The old Google-Sheet sales system showed, per company, a running summary of the conversation and a suggested next step. Jamie relied on it. Since the migration to the outreach engine it is absent from the panel, and the request is to bring it back working the way it did: summarise, then keep it updated as new messages arrive.

**The feature was never removed — the join broke.** `gmail-management/lib/threadBuilder.js` still does exactly this, including incremental updates (existing summary + only new messages → refreshed recap + re-derived next action), and still runs daily as the "Gmail Management" step of `daily-sync-all` ([daily-sync-all.js:114](daily-sync-all.js#L114)). But it writes to `email_threads`, keyed on `gmail_thread_id`, while the outreach engine reads `b2b_threads` / `b2b_messages` — a separate store with a separate ingest path. Measured overlap:

| | |
|---|---|
| `b2b_threads` | 252 |
| …matching an `email_threads` row | 23 |
| …carrying a summary | 19 |
| distinct companies covered (of 242) | **11** |
| of those 19, stale vs the newest message the engine knows | 7 |

`b2b_companies.ai_summary` (54 rows) and `next_action` (53) are a frozen snapshot of that same machinery taken at sheet-migration time. `ai_summary` is fed to the advisor ([outreachAdvisor.js:214](b2b-outreach/lib/outreachAdvisor.js#L214)) and gates prospect classification; `next_action` / `next_action_due` are read by nothing.

**Outcome:** a company-level summary derived from `b2b_messages`, kept current incrementally, surfaced in a restructured detail pane and given to the advisor — with the sheet-era text preserved as clearly-dated pre-migration prologue.

## Locked decisions

1. **Company-level, not thread-level.** The sheet was one row per company; the panel is company-centric; orgs like BAGLY carry several threads. This is why the old per-thread code never aggregated up.
2. **The next step is advisory.** It renders in the panel and enters advisor context. It does **not** write `next_action_date` and does not change tiers. `cadence.js` stays the single authority on what is due — per the standing "the queue stays due-only" decision. Two systems deciding what's due would disagree.
3. **Sonnet** (`MODELS.SONNET`), matching what `threadBuilder.js` already uses. Incremental summarisation is narrow extraction over text we hold, operator-reviewed in the panel before anything sends. Note the reason in a code comment, per CLAUDE.md.
4. **Leave `email_threads` alone.** Its summariser has one consumer, `gmail-management/dailyInboxDigest.js` (manual, whole-inbox, not just B2B). Out of scope; not a duplicate store to collapse in this change.

## Implementation

### 1. Schema — `gmail-management/b2b-outreach-schema.sql`

New columns on `b2b_companies`:

| Column | Purpose |
|---|---|
| `relationship_summary TEXT` | the rolling recap |
| `relationship_next_step TEXT` | advisory next step, null when concluded |
| `relationship_next_step_owner TEXT` | `us` \| `them` |
| `relationship_summary_at TIMESTAMPTZ` | when generated |
| `relationship_summary_through TIMESTAMPTZ` | `sent_at` of the newest message included — the incremental watermark |
| `relationship_summary_msg_count INT` | message count at generation |
| `relationship_summary_claimed_at TIMESTAMPTZ` | concurrency claim |

`ai_summary` / `next_action` / `next_action_due` / `next_action_owner` are **never written again** — they become explicit pre-migration prologue. Preserving them matters: for companies where the engine imported no history, that text is the only relationship knowledge we hold.

**Why a watermark and a count, not just a timestamp.** The old code selects new messages with `date > summary_updated_at` — wall-clock at generation, not the data boundary. In this system history arrives *backwards*: `discoverCompanyThreads` imports old threads long after the fact (see the parked "Queue reasons from empty history" item, where a hand-run discovery pulled 12 messages back to Jun 2025). Those would sit permanently below the timestamp and never be noticed. Staleness test is therefore: `newest sent_at > through` **OR** `count != msg_count`.

**Mode selection follows from the same fact:** if any unincluded message has `sent_at <= relationship_summary_through`, the narrative it belongs inside has already been written, so do a **full rebuild**. Only strictly-newer messages qualify for an incremental pass.

### 2. Summariser — new `b2b-outreach/lib/relationshipSummary.js`

- `summaryMode(company, messages)` — pure; returns `{ mode: 'full' | 'incremental' | 'current', newMessages }`. Directly unit-testable, which is where the watermark logic earns its tests.
- `renderSummaryPrompt({ company, messages, mode, now })` — pure; `now` injected, never `new Date()` inline (same rule that governs `renderContext`).
- `refreshCompanySummary(sb, companyId, { force })` — claim → load → call → write → release.
- `sweepStaleSummaries(sb, { limit })` — every company failing the staleness test.

Reuse `callClaude` from [shared/aiClient.js](shared/aiClient.js) with `component: 'b2b_relationship_summary'` so spend is attributable. Reuse the incremental prompt shape from [threadBuilder.js:163-199](gmail-management/lib/threadBuilder.js#L163-L199).

**The one prompt change that matters.** `threadBuilder` injects today's date on input but lets the model *write* relative time, so 52 of the 54 stored summaries say "about 10 months ago" / "currently traveling" / "scheduled a call for today" — anchored to a date the reader cannot see, and fed to the advisor verbatim today. The new prompt keeps the date injection and adds a positive instruction with a verbatim template ("Write every date absolutely: 'in March 2026', never 'about 10 months ago'"), per the "positive rules stick, negative ones drift" rule.

**The claim must precede the AI call, not the write.** The dashboard and the `daily-sync-all` cron are separate processes, so the in-memory cooldowns used by `manualSendReconcile` cannot prevent duplicate spend across them. Claim atomically:

```
UPDATE b2b_companies SET relationship_summary_claimed_at = NOW()
WHERE id = $1 AND (relationship_summary_claimed_at IS NULL
                   OR relationship_summary_claimed_at < NOW() - INTERVAL '10 minutes')
```

Only one caller wins; the staleness takeover covers a redeploy mid-call. Release in a `try/finally` on every exit including throws — a leaked claim silently freezes the summary.

### 3. Refresh triggers

- **Nightly:** `sweepStaleSummaries` as a `daily-sync-all` sub-pipeline placed **after** the existing Gmail Management and `syncB2bCompanyState` steps, so it summarises after that day's messages have landed.
- **On demand:** a `POST /api/b2b/companies/:id/summary/refresh` endpoint behind the ↻ control in the panel.
- **Not on panel open.** [fetchCompanyThreads](b2b-outreach/lib/queueService.js#L723) fires `startCompanyGmailSync` in the background; summarising in the same request would race it and recap a record whose history is still arriving. The pane returns the stored summary immediately with its `as of` date, and stays fast.

### 4. Advisor context — `b2b-outreach/lib/outreachAdvisor.js`

Replace the single `Relationship summary:` line at :214 with the live summary plus its date, and render `ai_summary` separately and explicitly as prologue — it has no reliable timestamp, so label it honestly ("pre-migration notes, written before June 2026, may be out of date") rather than presenting it as current. This is the same class of fix as the date line already at :199.

### 5. Panel IA restructure — `customer-service/dashboard/public/app.js` + `styles.css`

**Today** the pane is: header → facts-to-verify → AI Draft composer → Conversation accordion, with company identity, programs, contacts and orders in the right sidebar. So "what is this relationship and what should I do" is answered nowhere above the fold — you land on a composer, and to learn the relationship you scroll past a full draft into raw email transcripts. The two halves of "who is this" are also split across columns: commercial/identity facts in the sidebar, conversational state in the main pane.

**Restructured**, main pane splits into two labelled zones:

```
┌──────────────────────────────────────────┐
│ BAGLY                    [T3]  [org]     │  header: tier only when due,
│                                          │  else relationship-stage chip
├──────────────────────────────────────────┤
│ WHERE THIS STANDS          as of Aug 11 ↻│  ← new
│ 35 messages · last reply 6d ago          │  stat strip: conversation +
│ 13 packages routed · 2 orders            │  commerce signal, pulled in
│                                          │  from the sidebar
│ Recap in 2-4 sentences, absolute dates.  │
│                                          │
│ ▸ Next: confirm autumn quantities        │  advisory — writes nothing
│ Due per cadence: back_to_school window   │  the queue reason moves here,
├──────────────────────────────────────────┤  beside the state it explains
│ WHAT I'M SENDING                         │
│ Facts to verify                          │
│ AI Draft  [steer] [subject] [body]       │  unchanged
│ To: … [Send] [Test] [Dismiss]            │
├──────────────────────────────────────────┤
│ ▸ Conversation · 35 messages             │  collapsed by default now;
│   audit trail for the summary above      │  the summary is the primary read
└──────────────────────────────────────────┘
```

Sidebar narrows to **reference data**: logo, name, website, address, phone, contacts, order rows. The *narrative* (summary, next step, cadence reason, message counts) moves into the main pane so relationship state reads as one block instead of two columns.

Compose stays above the conversation — the common case is a Tier-1 reply where the words are already known, and pushing the transcript above the composer would tax it. Detail changes: the header shows a relationship-stage chip when `tier` is null (directory-reached companies currently render a bare header), and the conversation accordion defaults collapsed with its count in the summary line.

Work within the existing tokens in `styles.css` (`--surface-inset`, `--teal` for the recommendation accent, `--text-tertiary` for the `as of` stamp, `--radius`). No new fonts, palette or component language — this is an internal ops tool with a settled design system.

### 6. Tests — `customer-service/test/relationshipSummary.test.js`

Required by the deterministic-code rule; the pure functions are where the real risk is.

- `summaryMode`: no messages → `current`; strictly-newer only → `incremental`; a backfilled older message → **`full`**; count changed with no new `sent_at` → `full`.
- Staleness sweep selects on watermark **and** count.
- `renderSummaryPrompt` renders the injected `now` and carries the absolute-date instruction; incremental mode includes the prior summary and excludes already-covered messages.
- Claim: round-trip against the real table (a stubbed client cannot catch a `NOT NULL` violation in the claim row — the rule exists because a claim that always fails means nothing ever summarises), and assert N concurrent claims yield exactly one winner.

Check [b2bTriageAndContext.test.js:52](customer-service/test/b2bTriageAndContext.test.js#L52) still passes — `isUntouchedProspect` treats `ai_summary` as evidence of a prior relationship, and that column keeps its current values, so it should be unaffected. Leave that logic alone.

## Known dependency, not fixed here

The parked **"Queue reasons from empty history"** bug (high) means thread discovery never runs on queue build, so a company nobody has opened has zero `b2b_messages`. A summary built for those companies will be honestly empty rather than wrong — but coverage stays partial until that item is fixed. The summariser should render "no conversation on record" rather than inventing continuity, and the panel should say so plainly.

## Verification / done_when

1. `node --test customer-service/test/*.test.js` — all green.
2. Migration applied in Supabase; `select` confirms the seven new columns.
3. `refreshCompanySummary` run against a company with real history (e.g. one of the 18 active donation partners) produces a recap using absolute dates and a next step; `relationship_summary_through` matches its newest message.
4. Re-run immediately → no AI call (mode `current`). Insert a newer message → incremental refresh. Insert an *older* message → full rebuild. This is the behaviour Jamie asked for and the one test that proves it.
5. Two concurrent `refreshCompanySummary` calls for one company → exactly one AI call.
6. Dashboard restarted via `scripts/restart-dashboard.sh`; the restructured pane renders the block for a company with a summary, degrades cleanly for one without, and the ↻ refreshes in place.
7. `sweepStaleSummaries` runs clean inside `daily-sync-all` and reports counts.
8. Advisor draft generated for a summarised company; its context carries the live summary and labels the pre-migration prologue.
9. Memory delta prepared and committed with the code (below).

## Memory delta (same commit, per protocol)

- `domain_b2b_sales.md` — one Key Decision: the relationship summary is company-level and derived from `b2b_messages`, the sheet-era `ai_summary` is retained as dated prologue rather than overwritten, and the suggested next step is advisory because `cadence.js` owns what is due.
- `initiative_b2b_expansion.md` — progress bullet + `last_updated`.
- No parked entry unless scope is cut during execution.

Work happens in a worktree (`wt/b2b-relationship-summary`) off `origin/main`, per the worktree rule.
