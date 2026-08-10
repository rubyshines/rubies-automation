# B2B Lead Supply & Vetting

Make the outreach panel permanently non-empty with real, vetted work — and fix the
reason it has been empty since go-live.

- **Domain:** b2b_sales (community adjacent)
- **Initiative:** B2B Expansion (Phase 3, active outreach)
- **Drafted:** 2026-07-29
- **Status:** design locked pending Jamie's scope call

---

## Diagnosis

The panel is blank because the queue genuinely returns zero rows. Verified against
production: `fetchOutreachQueue(sb, {})` → `queue size: 0`, with 238 companies in
`b2b_companies`.

Three layers of cause, discovered in order:

### 1. Tier 4 is wired but never populated

`queue.js` `TIER_BY_TYPE` maps `intro_pitch` / `intro_outreach` / `affiliate_intro`
to tier 4, and `assembleQueue` sorts them. **Nothing in `cadence.evaluateDue` ever
returns those message types.** There is no first-touch rule. The entire discovery
backlog is invisible by construction.

### 2. Seven more cadence branches are dead — `buildContexts` doesn't supply their inputs

`evaluateDue` reads context fields that `queueContext.buildContexts` never sets:

| Field read by `evaluateDue` | Set by `buildContexts`? | Branch affected |
|---|---|---|
| `firstOrderDeliveredAt` | no | `first_order_checkin` |
| `postSamplesReplyAt` | no | `sample_feedback_request` |
| `purchaseSignalAt`, `lastPurchaseAt` | no | `purchase_pitch` (both forms) |
| `activeSince` | no | `affiliate_invite` |
| `newCollectionSinceDormant` | no | `reactivation` |
| `daysSinceLastAttribution` | no | `affiliate_reactivation` |

`buildContexts` supplies only `hasPendingDraft`, `sentTypes`, `lastInboundAt`,
`lastInboundThreadId`, `lastOutboundAt`, `lastOrderAt`, `orderCount`,
`lastTypeSentAt`.

So the *live* cadence surface is: Tier 1 replies, `post_samples_checkin`,
`reorder_nudge`, `community_checkin`, and the Tier 5 generic overdue. Everything
else is unreachable code. This is the classic 80%-shipped shape — the cadence table
was written to the design, the context assembly was written to what the first
tier needed, and nothing failed loudly in between.

### 3. `$0` sample-kit orders are counted as purchases

`syncB2bCompanyState.computeCompanyState` counts every non-cancelled order. On
2025-11-04 fourteen retailers were sent sample kits as **$0 Shopify orders tagged
`sample kit reach out`** (plus She Bop, 2026-03-18, tagged `wholesale-samples`).

Consequences:
- Those 14 were promoted `in_contact → active` and read as customers.
  `wholesale/active` = 21, of which ~14 never bought anything.
- `total_sales` = `$0` and `order_count` = 1 across the cohort — the tell.
- `reorder_nudge` requires `orderCount > 1`, so they surface nowhere.
- Meanwhile `samples_shipped_at` / `samples_delivered_at` were **never populated**,
  so the fully-built samples cadence has never fired once — even though the data to
  populate it sits in the orders mirror under those tags.

### 4. The 41 "cold retailers" are not cold

40 of 41 carry a full relationship history in `ai_summary` (samples sent, calls
scheduled, follow-ups) plus legacy CRM fields: `status`, `temperature`, and metadata
`{campaign, initial_reach_out, last_reach_out, no_response_count}`.

- `status`: 32 `lead`, 8 `qualified_lead`, 1 `customer`
- `temperature`: 30 cold, 5 warm, 5 neutral
- `campaign`: 19 intro, 14 sample, 8 none
- `no_response_count`: **28 at 2**, 3 at 3, 4 at 1, 6 at 0
- `last_reach_out`: 37 in 2026-02, rest scattered

They are unreachable by the engine only because `last_outbound_at` is null and no
`b2b_threads` rows exist — the history lived in the old Gmail-scanning system.

### 5. The sheet import is column-shifted

For the 41 retailers: 13 have a street address in `website`, 15 have no website,
and `country` contains phone numbers and the literal string `"lead"` (14 rows).
`metadata` on sheet-imported rows is a JSON **string** stored as a char-indexed
jsonb object (`{"0":"{","1":"\"",...}`) — recoverable via
`Object.values(metadata).join('')`, and `computeCompanyState` already parses the
string form. This is the parked *Audit sheet-imported B2B contact associations*
item.

### 6. The 156 orgs are three different populations

| Source | n | What we have |
|---|---|---|
| `klaviyo_centerlink` | 93 | name slug + email, nothing else |
| `centerlink_sheet` | 28 | same |
| `donation_form` | 23 | size ranges, contact person + title, program URL, product suggestions |
| `klaviyo_donation_program` | 4 | list membership |
| `email` | 8 | varies |

140 of 156 have **no website**. But **121 of the 126 CenterLink rows have a
derivable org domain from the contact's email address** — the `name` is literally
the domain slug (`Pacificcenter` → `pacificcenter.org`, `The519` → `the519.org`).
Only 2 are free-mail, 3 have no contact.

---

## Design decisions

**D1 — `relationship_state` gains `prospect`.** Column is bare `TEXT` (no CHECK),
so this is a data change, not a migration. Definitions:

| State | Meaning |
|---|---|
| `prospect` | no outbound ever, no samples, no real order — never approached |
| `in_contact` | a conversation happened, or samples were sent |
| `active` | placed a real (non-$0) order, or org enrolled in a program |
| `dormant` | derived at queue time from recency (never written) |
| `lost` | operator-owned, never auto-assigned |

**D2 — Vetting is a triage decision, not a research task.** Jamie's review is only
applied where the machine cannot decide. Everything mechanical (is the site alive,
does the domain resolve, is this even an org) happens before a row reaches him.

**D3 — Three lanes, not one 197-row pass.**

| Lane | Cohort | n | Human vetting |
|---|---|---|---|
| 1 | donation-form orgs | 23 | none — inbound, self-identified |
| 2 | sheet retailers | 41 | keep/drop/snooze, ~30 min total |
| 3 | CenterLink orgs | 121 | only survivors of enrichment |

**D4 — Retailer and org reviews are batched separately, never interleaved.** The
review question differs (commercial claims vs program fit), and the channel filter
already exists in the panel (`OUTREACH_FILTERS`, app.js:5193) — no UI work needed
for this, just an operating habit.

**D5 — Samples cadence gets a staleness bound.** Backfilling `samples_shipped_at`
from Nov 2025 orders would instantly make 14 retailers due for "how did the samples
go?" nine months late. `post_samples_checkin` only fires within 60 days of the
samples event; older sample recipients route to Lane 2 re-approach instead.

**D6 — The 41 retailers get `re_approach`, not `intro_pitch`.** They know us, they
have been asked twice, and 5 months have passed. The message must open a genuinely
new door (new season, new product, changed terms), not read as a third follow-up.
A distinct message type keeps that instruction in one place rather than relying on
the advisor to infer it from history.

**D7 — Send-rate limiting is deterministic, in the tool.** A daily cap belongs in
`sendB2bEmail`, not in an advisor prompt. Prompts don't count.

---

## Phases

### Phase 0 — Data repair (no sends, no UI)

**0.1 — Stop counting $0 sample orders as purchases.**
`syncB2bCompanyState.computeCompanyState`: exclude orders where `total_price == 0`
from the purchase set. Derive `samples_shipped_at` from the earliest excluded
sample-tagged order instead. Requires adding `tags` to the orders select in `run()`.
Sample tags observed: `sample kit reach out`, `wholesale-samples`.

**0.2 — One-off correction script** `scripts/repairB2bSampleStates.js --execute`.
The daily sync never downgrades `active`, so the 14 mis-promoted retailers need an
explicit reset to `in_contact` with `samples_shipped_at` set from their order date.
Print-only by default (CLI flag, not env var).

**0.3 — Repair the sheet-import column shift** `scripts/repairB2bSheetImport.js --execute`.
Street address in `website` → `address`. Phone number or `"lead"` in `country` →
`phone` / null. Derive `website` from the contact email domain where missing and
non-free-mail. Normalize the char-indexed `metadata` back to real jsonb.

**0.4 — Backfill `website` on the 121 CenterLink orgs** from contact email domain.
Same script family, own flag.

**Tests (required — deterministic logic):** `computeCompanyState` with $0 orders,
mixed $0 + real, sample-tag derivation; the column-shift classifier (address vs URL
vs phone).

**done_when:** `wholesale/active` reflects only retailers with real revenue;
`samples_shipped_at` populated for all sample recipients; no row has an address in
`website` or a phone number in `country`; 121 CenterLink orgs have a website.

---

### Phase 1 — Queue supply

**1.1 — Assign `prospect`** to every company with no outbound, no threads, no real
orders, no samples. One-off script, then maintained by the sync.

**1.2 — Add the Tier-4 first-touch branch** to `evaluateDue`:
`state === 'prospect'` && has an active contact → `intro_pitch` (retailer) /
`intro_outreach` (org). Order by lead score so the panel always shows the best
available row.

**1.3 — Add the no-reply follow-up ladder.** Today an unanswered intro falls into
Tier 5 with `message_type: null` after 7 days — a generic "overdue" row the advisor
improvises from. Replace with real types: `followup_1` at 7d after outbound with no
inbound since, `followup_2` at 14d after that, then auto-snooze 180d.
`buildContexts` already supplies `lastOutboundAt` / `lastInboundAt` / `lastTypeSentAt`
— no new context plumbing needed.

**1.4 — Add `re_approach`** for Lane 2 (per D6), gated on `vetted_at` being set so
it only fires after Jamie's triage pass.

**1.5 — Add the missing context fields to `buildContexts`** for the branches that
are currently dead code (`firstOrderDeliveredAt`, `postSamplesReplyAt`, `activeSince`,
the affiliate ones). Alternatively delete the branches. **Recommendation: wire
`firstOrderDeliveredAt` and `postSamplesReplyAt` now** (both are cheap — orders
mirror and message history), and delete the affiliate + `purchase_pitch` branches
until there is an affiliate program to drive them. Dead code that reads like a
feature is worse than no code.

**1.6 — Message types must be added to the advisor prompts** (`salesAdvisorPrompt.js`,
`communityAdvisorPrompt.js`) — the catalog lives there, and a type the prompt doesn't
know produces a generic draft.

**Tests:** cadence unit tests per new branch (prospect first-touch, followup ladder
timing, re_approach gating, samples staleness bound).

**done_when:** `fetchOutreachQueue` returns a non-empty, correctly-tiered queue; no
branch in `evaluateDue` reads a context field `buildContexts` doesn't set.

---

### Phase 2 — Vetting controls

**2.1 — `b2b_triage` MCP tool** (tools are the source of truth; the HTTP endpoint is
a thin wrapper). Actions: `keep` (sets `vetted_at`), `drop` (sets
`relationship_state = 'lost'` + reason), `snooze` (sets `snoozed_until`). No draft
generated. Agent-agnostic.

**2.2 — Migration:** `ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS vetted_at TIMESTAMPTZ`
plus a `triage_reason TEXT`. Schema file committed, runnable in the SQL editor.

**2.3 — Endpoint** `POST /api/b2b/companies/:id/triage` → wraps the tool.

**2.4 — Panel vetting mode.** Lists prospects with their `ai_summary` history,
legacy CRM fields (`temperature`, `no_response_count`, `last_reach_out`), and three
buttons. Keyboard-driven — this is a 41-row pass, it should take seconds per row.

**done_when:** Jamie can clear a cohort end to end without a draft being generated,
and dropped rows never reappear in the queue.

---

### Phase 3 — Lane 1 live (23 donation-form orgs)

**3.1 —** Set them to `prospect` → Tier 4 → `intro_outreach`.

**3.2 —** Their survey metadata (`size_ranges`, `contact_person_title`,
`program_url`, `product_suggestions`) must reach the community advisor.
`buildContexts` currently passes no company metadata into the draft context —
verify and wire.

**done_when:** the panel shows 23 org rows with drafts that reference what each org
actually told us in their survey.

---

### Phase 4 — Lane 3 enrichment (121 CenterLink orgs)

The discovery pipeline works on `retailer_prospects`, not `b2b_companies`. Reuse
`b2b-discovery/lib/researcher.js` (`researchProspect`) directly against company rows
now that they have websites. Auto-drop dead sites and non-orgs; survivors become
`prospect`. Jamie never sees the failures.

Pairs with the parked *discovery pipeline fixes* remainder (Haiku pre-filter, org
routing fix, scheduled cron).

**done_when:** every CenterLink row is either `prospect` with a researched profile
or `lost` with a reason.

---

### Phase 5 — Rate limiting & reputation (before any volume)

**5.1 — Daily send cap** enforced in `sendB2bEmail` (D7). Start 5–10/day.

**5.2 — Pre-send email verification.** Scraped and list-imported contacts bounce;
bounce rate above ~2% is what actually burns sender reputation. At minimum an MX
check; ideally a verification service for the cold cohorts.

**5.3 — Sending-domain decision (Jamie's call).** Cold B2B currently goes out on
rubyshines.com, the same domain Klaviyo uses for customers. Complaints there would
damage customer deliverability — an asymmetric risk. Either keep cold volume genuinely
small (5–10/day, heavily personalized, primary domain is fine) or stand up a separate
sending domain with its own warm-up. Required before 50+/day.

**Note:** the 121 CenterLink orgs and 23 donation-form orgs are list members or
inbound contacts, not cold prospects — they can move faster than the 41 scraped
retailers.

---

## Sequencing recommendation

Phase 0 → 1 → 2 → 3 gets the panel non-blank with the cohort needing zero judgment,
and buys time before Jamie spends attention on the retailers. Phase 4 runs in the
background. Phase 5 gates any move from operator-paced to volume.

**Suggested first slice:** Phase 0 + Phase 1 + Phase 3 (skip Phase 2 initially — Lane 1
needs no vetting UI). That makes the panel useful this week and defers the UI work
until the 41-retailer pass is actually next.

---

## Open questions for Jamie

1. **Scope of the first build** — full plan, or the Phase 0/1/3 slice?
2. **Phase 1.5** — wire the dead cadence branches or delete the affiliate ones?
   (Recommendation: delete until there's an affiliate program.)
3. **Sending domain** (Phase 5.3) — not blocking now, but decide before volume.

---

## Not in scope

- Auto-send / approval-by-exception (the autonomy ladder). Earned later on measured
  `operator_edited` rate per message type, once there is send volume to measure.
- Scheduling the daily cadence sweep on Railway — still a deliberate pull-mode
  decision (initiative_b2b_expansion.md).
- Competitor stockist-page mining and the CS→outreach transfer tool — new lead
  supply, only needed once these 197 are worked.
