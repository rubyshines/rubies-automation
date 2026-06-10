# RUBIES AI Operations Plan — June 2026 Review

Source: deep codebase review (Fable 5, 2026-06-09) + discussion with Jamie. Each item below
is a locked decision unless marked OPEN. This is a planning record — no work has started.

## Sequencing

1. #1 Cost reconciliation (blocks several decisions; cheap)
2. #6 Training-signal plumbing (must land before the judge baselines)
3. #3 Closeness-to-final judge (the yardstick everything else uses)
4. #2 Adaptive thinking + structured outputs experiment (judged by #3)
5. #4 Auto-send (shadow week → live, gated by #3 data)
6. #5 Marketing weekly loop + Supervisor brief (parallel track, independent of CS work)

---

## #1 — Cost tracking reconciliation

**Problem.** Two conflicting signals: `shared/aiPricing.js` prices Opus at $15/$75 per MTok
(current documented price is $5/$25 — the $15/$75 rate is Opus 4.1-era, carried forward),
so `ai_calls` is likely ~3× overstated (~$107/mo tracked → ~$36/mo at correct rates).
BUT Jamie's actual bill is ~$400 CAD ≈ $290 USD/month, all runtime (coding is on the Max
subscription, never API). So the ledger disagrees with the bill in the OTHER direction too:
potentially ~$200+/month of untracked production usage.

**Decisions:**
- Token-count × rate-table is an estimate; the bill is ground truth. Reconcile before fixing anything.
- Reconciliation: one full calendar month, Anthropic Console Usage & Cost (per-model breakdown)
  vs `ai_calls` for the same month, per model. Diagnostic: token counts match but dollars don't
  → rate table; bill shows more tokens than ledger → untracked calls; likely a mix.
- Untracked-usage suspects, in order: (a) fail-soft `ai_calls` writes silently dropping rows,
  (b) call sites bypassing `shared/aiClient.js` (two known: `extractToneSamples.js`,
  `categorizer.js` — both rare imports; reconciliation may surface more), (c) higher real call
  volume than the mental model (regens, operator agent, duplicate detection), (d) the $400 CAD
  figure itself being misremembered — eliminate this first, it's cheapest.
- After reconciliation: correct `aiPricing.js` rates; add `claude-fable-5` ($10/$50) so future
  tests compute cost instead of silently logging $0.
- Rebuild the monthly drift detector around the Anthropic Admin usage/cost API (the actual
  bill, queryable) instead of scraping the JS-heavy pricing page. It must ALARM when it cannot
  verify, never report "could not verify" quietly. (Verify exact Admin API endpoint before building.)
- **Frozen until reconciliation lands:** all cost-justified projects — the Sonnet
  `advisor_20260301` experiment (real ceiling ~$25/mo at corrected rates, against a pattern
  shadow-eval already showed quality-negative; expected outcome: kill) and tone-sample trimming
  as a cost measure (~$2/mo real; do later for prompt-attention quality only).

---

## #2 — Adaptive thinking + structured outputs (experiment)

**Background.** The advisor runs with thinking off (no `thinking` param). Jamie previously
evaluated thinking and correctly rejected it — but that was the old fixed-`budget_tokens` mode
(pays a thinking tax on every call). That mode is deprecated. What's changed: (a) adaptive
thinking thinks only when the ticket warrants it, (b) cost basis was 3× inflated, (c) on
Opus 4.8 (current prod model since the 2026-05-28 bump) thinking-off has a documented side
effect — reasoning leaks into visible output, which is what `stripInternalThinking()`
(aiAdvisor.js:1239, 45 lines of regex) and several prompt rules exist to fight. The status
quo is no longer free.

**Decisions:**
- Re-test via the existing shadow-eval harness, judged by the #3 closeness-to-final judge.
- **Time-boxed:** 7 days or N tickets, whichever first. While active: loud daily-digest line
  ("⚠️ shadow eval running, day N of 7"). **Auto-disables** at window end — never relies on
  someone remembering (shadow evals have silently run for weeks twice before).
- Decision criteria: draft-quality delta vs latency hit (thinking delays first visible token;
  Jamie feels this daily — only he weighs it). Cost is no longer a factor.
- **Structured outputs ship regardless** (no token cost, no latency cost): replace the
  `<structured>` block-in-text + hand-parsing with `output_config.format` JSON schema
  (guaranteed-valid JSON; schema includes the customer draft as one field plus all structured
  fields). On success, delete `stripInternalThinking()` and the parsing half of
  `validateResponse()` — deleting the band-aids is the proof it worked.
- Validate with scenario suite + judge before shipping.

---

## #3 — Closeness-to-final judge (the master yardstick)

**Background.** The May baseline study already did the right thing once: an AI judge compared
each draft to what Jamie actually sent and classified the difference (identical / cosmetic /
substantive / factual correction). It ran once, manually. The daily 38.8% "edit rate" is the
crude version (whitespace-normalized any-change check) — a comma tweak and a wrong refund
count the same. The "95% accuracy" claim is a fragile snapshot (incomplete action tracking,
frozen May window, model swapped underneath it).

**Decisions (Jamie delegated the call; made):** build it, as a well-run experiment tied to goals.
- Promote the May-style AI comparison from one-off study to continuous: judge every sent ticket.
- Judge classifies divergence — May categories PLUS "draft and send disagree on substance and
  the draft might be right." Those cases are NOT penalized into an average; they surface as
  their own short list (some are AI errors → prompt fixes; some are Jamie errors caught after
  the fact — the most interesting data in the system). Ground truth assumption: Jamie is right
  often enough to calibrate against, not infallible.
- Headline digest metric switches from raw edit-rate to **substantive-divergence rate**.
- **Opus as judge** (don't cheap out on the yardstick); run inside the daily sync via the
  Batch API (nothing waits on it). Cost ~\$5/mo at current volume — noise. Downgrade to Haiku
  only if a spot-check shows agreement.
- Baseline: trailing 90 days of sent tickets. Deliverable: a per-ticket-category quality table
  trusted enough to nominate the first auto-send category.
- Digest line for visibility, same as every background AI process.
- Known flaw, accepted: it's a floor not a ceiling (rushed human replies can score good drafts
  as "divergent"); the "draft may be right" category is the mitigation.

---

## #4 — Auto-send

**Goal link:** this is the item that directly buys back Jamie's daily CS hour (priority #2).

**Decisions:**
- A ticket category qualifies for auto-send when the judge shows **<~3% substantive divergence
  over 30+ sends**.
- **Never-list (hardcoded, permanent):** anything that moves money or creates orders — refunds,
  exchanges, free orders, discount codes — always human.
- **Explicit, visible allowlist:** the set of auto-sendable categories lives in a small dashboard
  panel Jamie can see and edit. Categories are promoted by Jamie, one at a time, never by the
  system promoting itself. "What auto-sends?" must always have a one-glance answer.
- **Visibility (Jamie's monitoring concern):**
  - Auto-sent tickets land in the **Closed tab with an "auto" badge + one-click filter**
    (decided: filter, not a separate tab — auto-sent tickets are closed tickets).
  - Daily digest line: "Auto-sent yesterday: N (breakdown). Judge flagged: M."
  - Judge reviews every auto-sent ticket retroactively; any flag goes loudly to the normal queue.
- Any factual-error edit in a category **demotes it** back to human review.
- **Shadow week first:** system marks what it WOULD have auto-sent without sending; Jamie's
  first look at the filter is a dry run with zero customer exposure. Monitoring ships before
  automation.
- Likely first candidates: thank-you-adjacent / simple-inquiry categories (confirm from judge data).

---

## #5 — Advisors are domains, not services

**Decision:** the eight advisors are domains of responsibility (memory file + tools), not eight
deployed programs. A domain earns a deployed service only when work arrives on its own schedule,
at volume, needing response while Jamie isn't looking (the CS test).

| Advisor | Status |
|---|---|
| CS | Deployed ✔ (the one clear case) |
| **Supervisor** | The only NEW deployment endorsed: a scheduled daily triage agent — reads queues, digest, edit trends, parked items → morning brief: "what needs you today + what I'd do." **Proposes, never executes.** Seed of the eventual orchestrator. |
| **Outreach** (Sales + Community **merged** — Jamie's call, endorsed) | One engine, two tracks. Bench: deploys when inbound reply volume justifies. |
| Finance, Merchandising, Creative, Tech | Sessions forever (episodic, judgment-heavy, Jamie in the room). Daily-watch needs (at-risk SKUs) are digest lines, not agents. |
| Marketing | Session-based weekly loop (below) — most underbuilt relative to leverage. |

**Outreach merge details:** same machinery for both tracks — prospect DB, contact finding,
outreach drafting, follow-up cadence (aligns with the existing Unified B2B Outreach design).
Retail track measured in POs/reorders; Community track measured in partnerships/referrals.
**Guardrail:** the community track must never read like sales — orgs are partners, not leads;
community emails are held to the mission bar, not the conversion bar. Shared engine, separate voice.

**Build order:** Marketing loop first (cheap, compounds, mostly packages existing tools),
Outreach second (design further along; loses nothing shipping later).

### Marketing weekly loop (the concrete design)

- Packaged as a slash command (e.g. `/marketing-weekly`) — **runs in Claude Code on the Max
  subscription, zero marginal API cost.** All needed tools already exist as MCP tools
  (seo_keywords, seo_report, seo_meta_draft, blog_topic_ideas, blog_search_emails,
  list_blog_posts, register_blog_post, klaviyo_*).
- Weekly cycle: read Search Console / seo-tracking data + mine real customer language from CS
  tickets/emails (the freshness engine — pre-validated questions in customers' own words) +
  seasonal → 2-3 topic candidates with evidence → full draft of the best one →
  1-2 generated illustrations in house style → approval queue.
- **The creative director is the gate — for content AND imagery.** Not Jamie. (Applies CD
  taste: e.g. the "too long" feedback becomes a per-post-type length spec in the brief, fixed
  once.) Nothing ever auto-publishes. For imagery the gate is **permanent policy**, not a
  training wheel — a slightly-off illustration touching the kids' line is a mistake the brand
  cannot make once.
- **Imagery = house-style illustration, never photoreal people.** The brand's existing
  illustration language (flat vector, duotone figures, cobalt/lime/magenta) exists because
  photography is fraught for these products — and it's the easiest style for image models to
  reproduce. Build a **style-guide asset** (Creative domain owns it): exact palette, figure
  treatment, composition rules (joyful, body-diverse, never sexualized, age-appropriate),
  explicit out-list (no photorealism, no political imagery) + a handful of existing site
  illustrations as reference images. Reused beyond blog: email headers, social, campaign art.
- **SEO framed as an experiment, not a commitment** (Jamie's skepticism is valid for generic
  AI content; RUBIES' position is different — for most target questions the current best answer
  on the internet is Reddit folklore or nothing, and being the authoritative written source is
  also how you become the brand AI assistants cite):
  - 8-10 posts over 2 months; every post answers a real customer question and must pass the
    "best answer on the internet" test; length-calibrated; CD-gated.
  - Step one: read existing Search Console data — if organic genuinely does nothing for RUBIES,
    that's a real answer.
  - Measure rankings / organic sessions / assisted revenue at 60 and 120 days.
  - **Pre-agreed kill criteria:** nothing moves by the 120-day mark → loop dies; we spent a few
    weekends knowing instead of wondering.

---

## #6 — Training-signal capture (plumbing)

**Problem.** The two most informative operator moments vanish from the record:
- **Manual sends** (Jamie abandons the draft and types his own reply) log an empty draft, no
  category, no comparison — the "AI failed completely" signal is invisible, flattering every metric.
- **Operator steers** ("make it warmer" → regen) are stored but never logged to the feedback
  loop — steer-pattern arrows ("every defect ticket needs steering") never surface.

**Decision:** log both into the same feedback table (`cs_ai_feedback_log`) everything else uses.
Pure plumbing, no UI, no behavior change. **Sequenced BEFORE #3 ships** so the judge's baseline
includes the manual-send cases from day one rather than the flattering subset.

---

## Killed / deferred (decided, recorded so they stay decided)

- **Sonnet advisor_20260301 experiment** — frozen pending #1; expected kill (economics gone, quality already shown negative).
- **Tone-sample trimming as cost measure** — real savings ~$2/mo; revisit only as prompt-quality work.
- **Tool catalog refactor** (105 tools, inconsistent I/O, 11 order-creation variants) — hygiene
  opportunistically; revisit via API tool-search if a second deployed advisor ever exists.
- **Daily-sync parallelization** — saves minutes of cron time nobody waits for; skip.
- **AI-ifying the follow-up templates** — they're correct engineering (no customer message to
  reason about); leave deterministic.
- **Docs truth-up** — CLAUDE.md/memory say `claude-opus-4-6`, prod runs `claude-opus-4-8`;
  "95% accuracy / 60+ scenarios" claims overstate what the data supports. Small item; propose
  memory edits for approval when nearby. Related process rule worth adopting: any `MODELS.OPUS`
  change requires a judge run first (the missing regression gate, as one rule, not CI).
- **Stale domains** (seo-tracking 76d, review-tracking 81d, inventory-tracking 64d) — seo-tracking
  gets revived by the Marketing loop; decide intentionally on the other two later.

## Open questions

- #1: is the $400 CAD figure right, and what does the per-model Console breakdown show?
- #2: latency tolerance — only Jamie can weigh thinking's slower first token against fewer leaks.
- #4: first category to promote (judge data decides; Jamie confirms).
- #5/Fable 5: if the judge shows a real quality win for Fable 5 over Opus 4.8 at ~2× token
  cost (~immaterial at volume), is prod willing to move? Test rides on the #3 infrastructure.

---

# SPRINT: 2026-06-10 → 2026-06-17 (everything, one week)

Jamie approved compressing the full plan into one week, including building the Outreach engine.
Two items are clocks, not work (live thinking window, auto-send shadow period) — they START
day 1-2 and finish on their own; auto-send flips live only when its data says so, even if day 9.

## Safety contract (standing rules for every autonomous session)

- **Chute:** repo tagged `pre-sprint-2026-06-10` before any work. Pull the chute =
  revert main to tag + push; Railway redeploys old code in minutes.
- **Worktrees, always:** long-running/autonomous work happens in git worktrees under
  `~/Code/rubies-repo/worktrees/<name>` on `sprint/<name>` branches — never directly on main.
- **Two merge tiers:**
  - *Additive* (judge, feedback backfill, outreach engine, marketing command — new code beside
    the system): merge to main autonomously once tests pass (`node --test customer-service/test/*.test.js`).
  - *Touches live CS path* (structured-outputs change to advisor, anything auto-send): merge
    ONLY in cowork checkpoints with Jamie present.
- **Code vs actions:** autonomous sessions build/test/commit. They never send EXTERNAL emails
  (customers, prospects, partners), touch orders, or move money — those stay behind the
  dashboard + never-list. Internal reports to Jamie (digest, alerts) are fine (clarified 2026-06-10).
- **DB:** additive-only migrations (new tables/columns with SQL files); backfills dry-run first.
- **Every session ends with a written status note** (what changed, decisions made, merged vs parked).
- Memory writes during sprint pre-approved by Jamie (2026-06-10): record worktree workflow and
  any important changes as they happen; report what was written in status notes.

## Sprint log

**Night 1 (2026-06-10):**
- Housekeeping: `.claude/plans` plain dir replaced with the symlink CLAUDE.md documents;
  memory edits committed+pushed to main (d9a8f1d); Edit/Write allowlist for plans+memory
  added to settings.local.json; real plans dir moved INTO the repo at .claude/plans
  (now committed to git), ~/.claude/plans is the symlink pointing at it. Permission saga
  RESOLVED: root cause was the session's UI mode (Ask-before-edits / Plan mode) overriding
  all allow rules. Fix = Auto mode in the VS Code mode selector (shift+tab). Side benefits
  shipped along the way: plans committed to git, wide Edit/Write allow rules at user scope,
  .env flagged as the one un-backed-up asset (Jamie: copy to password manager).
- Chute set: tag `pre-sprint-2026-06-10` pushed. Worktree pattern verified (symlink .env +
  node_modules; 780/780 tests pass inside worktree). Memory rule written to
  feedback_technical_rules.md (pre-approved).
- **#1 partially closed:** ai_calls reconciliation run. May recorded $607 / corrected $274 ≈
  Jamie's ~$400 CAD bill → ledger is complete, rate table is the bug. June run-rate ~$8/day
  (~$240/mo real); 73% of Opus spend is cache writes (later optimization candidate).
  AWAITING: Jamie's Console confirmation, then aiPricing.js fix. Optional: ANTHROPIC_ADMIN_KEY
  in .env → automated bill reconciliation in drift detector.
- **#6 DONE** (sprint/feedback-judge @ 5b035e1): feedbackSignals lib + all three send paths
  logged (sent/edited, bypassed_*, manual_*), steer + regen_count columns added (SQL run by
  Jamie), backfill executed: 11 manual sends recovered, 118 steer annotations. 793/793 tests.
- **#3 BUILT** (8f036ce): closenessJudge lib + baseline runner. 90-day picture: 785 sent
  drafts, 402 (51%) sent verbatim (deterministic identical). 10-draft live sample run —
  caught one real action_divergence/high (draft 1650). Full baseline (~383 AI verdicts,
  ~$11.50) AWAITING rubric approval.
- Queued: full baseline → category table → daily-sync judge step + digest line; WS-B/C
  (cowork), WS-D outreach design (cowork), WS-E marketing loop.

**Night 1, continued (after Jamie's "run longer" + external-email clarification):**
- **#3 COMPLETE:** full 90-day baseline judged — 785 drafts. Overall substantive divergence
  35.3%; most-recent 410 = 29.8% → quality measurably improved over time (May/June prompt
  fixes worked). closing = 97% clean (first auto-send candidate); general_inquiry = 54%
  clean, 19 high-severity (top prompt-fix target). 16 draft_may_be_right for Jamie review.
  Daily judge step + digest line committed (f5d2e44).
- **WS-D Design #7 DONE** (background agent): findings at `.claude/plans/b2b-historical-findings.md`.
  Headlines: email corpus thin (sync only covers Mar-Jun 2026, backfill never ran — only 9 of
  218 companies have threads); DATA TRAP — Gmail auto-save draft checkpoints synced as
  separate sent rows (invalidates naive reply-rate metrics; b2b_messages must store final
  sends only → Design #6 requirement); no cold-intro baseline exists (variant tracking from
  day one is the only path); She Bop arc validates the message catalog; objections resolve
  via flexibility/choice-framing; catalog gaps found (price_change_notice, sample_feedback_
  request, invoice_followup, event_partner_coordination); ~12 live org contacts missing from
  b2b tables (backfill before launch); donation_partners has no email column and 17 active
  (not 14). GATE PASSED with caveats — advisor prompts can be written.
- **WS-D Design #2 phase 1 DONE:** pre-filter committed (951b808) + full 3,537-row flush
  executing (~28% cull rate on sample — conservative by design; analyzer dismisses the rest
  with research). Analyzer audit finding was STALE — already ported to aiClient; dead import
  removed. Full analyzer run over survivors = daytime job (needs website scraping, hours).
- **WS-E shipped:** /marketing-weekly command committed to main (b2af075, config-only).
  Still needs: style-guide asset (Creative), CD introduction, first live run.
- **Cowork agenda additions from findings:** (1) Gmail backfill_pass for B2B contacts before
  outreach launch; (2) contact backfill of ~12 live orgs; (3) Design #6 must dedupe draft
  checkpoints; (4) catalog gap message types to lock; (5) the 16 draft_may_be_right reviews.

**Day 2 (2026-06-10, daytime):**
- **Permission saga resolved** (mode selector was the cause; Auto mode fixed; memory updated).
- **#1 COMPLETELY CLOSED:** Jamie upgraded Console to an organization + minted admin key
  (ANTHROPIC_ADMIN_API_KEY in .env). May bill retrieved programmatically: $260.34 (matches
  Console to the cent). Rate table fixed + pushed (bill-verified, Δ5.2% vs ledger). All 7,750
  historical ai_calls rows recomputed ($1,071.66 fictional → $456.32 true all-time);
  ai_costs_daily fully re-rolled. NEW: lib/billReconcile.js — monthly bill-vs-ledger digest
  line via Admin API cost_report, alarms on >12% drift or any failure. Principle locked:
  retrieve the bill, never recompute it.
- **#6 + judge + auto-send shadow MERGED to main** (conflicts with concurrent dashboard
  commits resolved; 836/836). Dashboard restarted with new code. Shadow flags: Jamie ran the
  enable command himself (auto-mode classifier correctly refused to let me self-promote
  categories — the plan's own rule, enforced).
- **#2 advisor engine (sprint/advisor-api):** ADVISOR_OUTPUT_SCHEMA built (customer_reply
  streams first; field guidance in schema descriptions), output_config wired, streaming
  extractor with worst-case tests, parse path replaced (legacy fallback retained),
  stripInternalThinking dead on main path (still used by Sonnet shadow). Scenarios: 7/8 PASS
  live (refund fixed via no-dollar-amounts rule in schema description). OPEN: steerProseLoss
  garbled-draft repro in flight — address-regex theory eliminated by experiment; awaiting
  live artifact. Branch unmerged until resolved + cowork.

## OUTREACH ENGINE BUILD — active build order (started 2026-06-10 evening)

Design is COMPLETE (b2b-outreach-system.md — all locked/drafted; prompts draft + Jamie's
answers in b2b-advisor-prompts-draft.md). Build autonomously on `sprint/outreach` worktree
(~/Code/rubies-repo/worktrees/outreach). On session reopen: continue from the first unchecked
item. Tests green before every commit. NO emails sent by anything built here until a cowork
go-live — the send tool's phase-2 stays behind a `b2b_send_enabled` system flag DEFAULTING
OFF, hard-checked in code.

- [ ] 1. Schemas: extend gmail-management/b2b-schema.sql (or new b2b-outreach-schema.sql):
      b2b_threads, b2b_messages, b2b_drafts (cols per SSOT Design #3+#6 specs), b2b_companies
      additions (entity_type, general_email, snoozed_until, next_action_date,
      last_outbound_at, pending_demand_skus, program_flags, samples_* fields,
      contact_unknown). SQL file for Jamie to run; code fail-soft until then.
- [ ] 2. lib: outreach/cadence.js — pure due-condition evaluators per Trigger-3 table +
      next_action_date writer (unit tests per type).
- [ ] 3. send tool: customer-service/lib/tools/sendB2bEmail.js — two-phase per Design #6
      spec; Gmail API send as jamie@ (reuse gmail-management auth); writes b2b_messages/
      drafts/company fields. PHASE 2 GATED on b2b_send_enabled flag (default off) — preview
      always works. Register in operator console tools + MCP server. Tests (stub Gmail).
- [ ] 4. Reply correlation: extend Gmail Pub/Sub path — sender ∈ b2b_contacts/general_email
      → thread match → inbound b2b_messages (idempotent gmail_message_id) → classifier tag
      (incl. inbound-order shape) → b2b_drafts regeneration hook. Concurrency-safe per
      technical rules.
- [ ] 5. Queue: lib/outreach/queue.js — 6-tier computation per locked decision #6; daily 6am
      sweep job (new Railway-ready script, NOT wired into daily-sync — outreach has its own
      clock); operator console MCP tool b2b_queue ("show me today's followups").
- [ ] 6. Advisors: wire b2b_sales_advisor + b2b_community_advisor from the prompts draft
      (+ Jamie's answers addendum) — aiClient components b2b_sales_advisor /
      b2b_community_advisor, draft+steer pattern, output schema mirroring CS advisor's
      enforced-schema approach. Drafts land in b2b_drafts, NEVER auto-sent.
- [ ] 7. Phase-1 seed run (drafts only, send flag off): generate intro/checkin drafts for
      the warm list (17 partners + backfilled orgs + active retailers due a touch) for
      Jamie's first review session.
- [ ] 8. Variant tracking: variant_id on drafts/messages (locked #15) — plumbing only, A/B
      analysis later.
Deferred to cowork: dashboard queue panel (Design #4 stays MCP-console-first per locked #4),
go-live flag flip, Design #9 rename.

## Workstreams

| WS | Branch | Content | Tier |
|---|---|---|---|
| A | sprint/feedback-judge | #6 capture+backfill → #3 judge + 90-day baseline + category table | Additive |
| B | sprint/advisor-api | #2 structured outputs + adaptive-thinking shadow window | Live-path (cowork merge) |
| C | sprint/autosend | #4 allowlist panel, Closed-tab filter/badge, digest line, shadow mode | Live-path (cowork merge) |
| D | sprint/outreach | Outreach engine — design doc first (cowork decisions), then build | Additive |
| E | sprint/marketing-loop | /marketing-weekly command + style-guide scaffold + SEO data readout | Additive |

#1 reconciliation is not a workstream — it's a query (done, see status notes) + Jamie's
Console numbers + then the rate-table fix.

## Operating model (agreed 2026-06-10)

- **Cowork sessions** (Jamie nearby): design/decision work — Outreach design, live-path merges.
  I batch questions; Jamie answers in seconds, I keep going.
- **Autonomous sessions** (Jamie absent): build work with the plan as contract, tests as
  guardrail. Unspecified details: make the reasonable call and note it, don't block.
- **Sequencing discipline:** one live experiment holds Jamie's attention at a time; everything
  else queues here. "What should I work on?" must always be answerable from this file.

## Budget rule (agreed)

Measure everything, optimize nothing. Co-working rides the Max subscription. API
experimentation: $150/month line, tracked as its own component in the digest — below the line
spend freely, above it decide deliberately. Rationale: token prices falling, intelligence
rising, IRAP grant ($75K, 80% of salary) funds exactly this R&D; Jamie's hours are the
expensive input. The `ai_calls` ledger + this plan + experiment writeups double as IRAP
documentation trail.

## Outreach engine — WS-D

**SSOT: `.claude/plans/b2b-outreach-system.md`** (15 locked decisions, message catalog,
discovery pipeline design — far ahead of the initiative files). This section only tracks
sprint execution against it. Use the `/b2b-design` skill to orient any outreach session.

Where the design left off (the cowork agenda): Trigger 3+4 detail (cadence SQL + signal
routing), Design #6 Gmail send flow, Design #8 migration-order decision. Design #4 (queue UX)
stays deferred.

Autonomous sprint work (no decisions needed, explicitly sanctioned by the design):
- Design #7 historical Gmail analysis — "run BEFORE writing advisor prompts", local Claude
  Code pass. → launched as background agent night 1.
- Design #2 phase 1 — Haiku pre-filter flush of the 3,537 unprocessed discovery rows
  (~60-70% junk cull expected, then full analyzer on survivors → ~50-60 prospects for review).
- Reconciliation notes for cowork: (a) earlier conversation said "one Outreach advisor" —
  design locks TWO prompts (Sales + Community) on one spine; design wins. (b) locked #15
  A/B variants will be underpowered at launch volume — complement with pre-flight judge
  panels, don't re-litigate. (c) conversation's new prospecting plays not yet in the design:
  mine customer base for org-domain/bulk buyers; geographic gap analysis as retailer opener.
  Bring both to the cowork session.

### Original session-scope notes (superseded by the above where they differ)

Context from initiative files: B2B Expansion is PAUSED with Tier 1&2 prospect discovery done
but no outreach tracking and no active outreach; LGBTQ Partnerships has 14 live partners +
form-driven intake + phase 3 (org purchasing via inclusion funding) barely started. Two stocked
prospect pools, zero outbound motion — the bottleneck is the outreach grind, not leads.

Prospecting plays to design in (priority order):
1. **Donation funnel first:** the 14 partners + every past form submitter are the warmest list
   in the company — the inclusion-funding purchase pitch goes to them before any cold retailer.
2. **Mine the customer base for hidden B2B:** org-domain emails, repeat bulk buyers, same
   address/multiple buyers → clinics, counselors, support groups already buying retail.
3. **Geographic gap analysis as retailer opener:** DTC customer density by metro with no local
   stockist → data-backed pitch.
4. **Measurement at low volume:** NO classic A/B (underpowered). Instead (a) tag every outreach
   email with structured features (angle/length/CTA/personalization), analyze feature↔reply
   correlation after ~100 cumulative sends; (b) pre-flight AI judge panels role-playing
   recipients to kill weak drafts before spending real prospects.
Guardrail (re-stated): community track held to the mission bar, never reads like sales.
