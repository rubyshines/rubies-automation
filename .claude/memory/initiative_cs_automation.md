---
name: CS Automation
description: AI advisor reducing Jamie's CS time, currently human-in-the-loop, moving toward autonomy
type: project
domains: [cs]
last_updated: 2026-07-23
originSessionId: 5fa69c00-27d5-40ef-9c88-8f188fbf3c12
---
## Goal
Reduce Jamie's ~1hr/day CS time using AI advisor.

## Phases
- AI advisor built and handling all ticket types — complete
- Human-in-the-loop via dashboard (Jamie reviews/approves drafts) — active
- Increasing autonomy as quality improves — future

## Current Status
Active. AI drafts responses, Jamie reviews and approves via ops dashboard. ~$0.39/draft, ~$0.60/ticket. 95% action accuracy on 198 held-out conversations. SSE streaming deployed (perceived latency ~1-2s). Efficiency project running — prompt caching deployed but minimal impact at current volume.

- 2026-07-23 (later): **Steer & Send shadow shipped** (Jamie's proposal this session: one-click steer that also executes+sends, judge-gated). Data said not yet for live mode (32% of steered sends still meaningfully edited, ~14% factual/action), so the shadow phase IS the product for now: every steered regen gets a would_send verdict (deterministic never-list/action checks + Opus correctness verifier, `steer_send_shadow` table, `steersend_shadow` flag, digest dry-run line vs judge). Go/no-go evidence accumulates alongside the auto-send shadow; read both at the ~Sept re-review. Cost ~1.5 verifier calls/day.
- 2026-07-23: Two eval verdicts. **Sonnet 5 shadow eval concluded: not viable** (advisor primary mean 2.33 on 58 unique tickets with a verified-healthy harness; operator 2.62 — both in the pre-registered not-viable band; staying on Opus, `cs_diagnostics` off, details in project_cs_efficiency.md). **Auto-send graduation review ran: closing does NOT graduate** — only 9 shadow-marked drafts in 6 weeks (thank-you closer absorbs pure thanks upstream), and 3 of 8 judged would-have-erred (sizing factual error, over-explained fit, unverified policy claim) — all three the "draft added content Jamie removed" verbosity pattern; 2 of 3 predate the 07-20 verbosity fix. Shadow stays on (costs ~nothing); re-review ~Sept on post-07-20 data only.
- 2026-07-20: Verbosity regression fixed (plan approved 07-18). Post-voice-rules edit assessment showed 27/30 founder edits were deletions (avg −30 words) — the model stacked voice rules per draft. Shipped: "one move per message" governing register rule + explanation gating (shaping template only for shaping-doesn't-work; plain fit complaints get a size/measurement move), numeric word-count targets removed, exchange-template tracking clause dropped, generic "the item(s)" in return/donation asks. New pinned scenario shapingExplanationGating.js. (A deterministic apology-flag banner also shipped, then was removed 07-22 as noise — Jamie watches for misplaced sorries manually.) Re-check edit shape ~07-27; the ~07-25 accuracy sweep reads this too.
- 2026-07-18: Corpus-harvest project completed end-to-end (PRs #79-#99): 6 years of replies mined, founder-reviewed via the new Google Sheet review loop, 292-article source-linked KB rebuilt with weekly refresh, advisor search_knowledge tool live behind `advisor_kb_search` kill switch, 17 mined voice rules + fault-scoped apologies in the prompt. Also: cs_messages sender hygiene fixed (auto-acks/AI-bot/flow containers now sender_type='system'; 1,886 rows backfilled).
- 2026-06-09: Archived 4 completed projects (Execute & Send, Reduce CS Time Per Ticket, Structured Output Consistency, Ad Hoc Operator Console). Touch-time KPI live — per-ticket cumulative "Total close time" + "Time on CS today/week" on stats page and daily email. Ad Hoc Operator tab live on dashboard (all CS tools, Opus, ephemeral).
- 2026-06-02: Dashboard — On Me tab (`pending_operator` status) for tickets where Jamie owes a response; auto-follow-up suppressed, customer reply returns ticket to open. Send & On Me button. Pre-order auto-drafter tightened: timing gate (next business day 5pm PT) + per-order Warehance `ready_to_ship` check eliminated false-positive drafts. Order alert "Waiting on Response" now surfaces post-shipment operator notes (Passport tracking, pending decisions). Bulk-resolved 31 stale fulfillment-phase notes. Passport mishandled shipment outreach sent to 5 customers.
- 2026-05-27: Accuracy push (branch `cs-accuracy`, not yet deployed). Used the ~2.5-week China window (stable prompt) as a clean draft↔sent baseline. Built the operator-action eval that never existed (we only graded prose before). Headline: the advisor is materially MORE accurate than raw numbers showed — most "errors" were measurement artifacts (incomplete `actions[]` logging; live-regen order-state drift; donation-routing variance; voice variance). Killed a proposed fix that would have broken correct behavior. Shipped grounded fixes validated by scenario tests: fixed a dead `delivery_estimate` tool reference, added a `shipping_info` tool over shipping_zones, a fact-precedence rule (DB hard facts > KB/memory), plus packaging/program-link/colors/Tall/partner-geography grounding. Established a change-driven accuracy-sweep cadence (see domain_cs.md). **Merged to main + deployed 2026-05-27.** Deferred: refund-vs-choice nuance + auto-hold (#877).
- 2026-05-26: Shipped one-click background "Execute & Send" (run operator action + auto-confirm phase 2 when nothing diverges + send draft, in the background). Human stays the gate. Cuts the per-action operator dance toward the ~111s/ticket-avg time-reduction goal. Also removed the most common operator divergence (advisor-stated refund amounts). Deviance analysis this session: advisor `confidence` field has no correlation with whether Jamie edits a draft, so it can't gate autonomy; ~62% of high-confidence drafts go out byte-identical; the dangerous edits are factual corrections (~20%), pointing future autonomy work at a correctness verifier rather than a confidence threshold.

## Next Steps (2026-07-23)

1. **Auto-send graduation re-review ~Sept** — ran 07-23: not ready (3/8 would-have-erred; see status bullet). Re-run on post-07-20 (verbosity-fix) shadow drafts only; also reconsider whether a higher-volume low-stakes category beats closing as the first graduation target.
2. **KB watch week → accuracy sweep ~07-25** — advisor changed heavily this month (apologies fault-scoped, 17 voice rules, KB search tool w/ `advisor_kb_search` kill switch); let drafts accumulate under the stable config, watch daily factual_correction rate vs ~6% baseline, then run the change-driven sweep (also reads KB-tool impact). Context going in: 7d judge divergence is 40% vs 36% 30d (6 high-severity last week) — the sweep decides whether that's real drift from the July changes or noise. **Expanded scope (Jamie 2026-07-23): include an operator-action accuracy baseline** — rerun the May one-off operator-action eval method (ground truth = what the sent prose says was done; `actions[]` is incomplete) over the ~297 executed actions since 05-27 (104 exchange, 62 refund, 37 hold, 35 order-mod, rest long tail) and report an absolute operator accuracy number alongside draft quality. This becomes the recurring operator baseline, refreshed each sweep.
3. **Forgot-discount-code operator tool** (parked entry) — refund equivalent + burn code + surface why a code failed.
4. ~~Sonnet 5 shadow eval~~ — concluded 07-23, not viable, eval off (see status bullet).

## Decisions Made
- Agentic loops, not decision trees
- Human-in-the-loop for foreseeable future until quality proven
