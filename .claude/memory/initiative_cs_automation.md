---
name: CS Automation
description: AI advisor reducing Jamie's CS time, currently human-in-the-loop, moving toward autonomy
type: project
domains: [cs]
last_updated: 2026-09-09
originSessionId: 5fa69c00-27d5-40ef-9c88-8f188fbf3c12
---
## Goal
Reduce Jamie's ~1hr/day CS time using the AI advisor.

## Phases
- AI advisor built and handling all ticket types — complete
- Human-in-the-loop via dashboard (Jamie reviews/approves drafts) — active
- Increasing autonomy as quality improves — future (shadow measurements running)

## Current Status
Active. AI drafts responses, Jamie reviews and approves via the ops dashboard. Roughly $0.60/ticket. SSE streaming keeps perceived latency at a second or two. Continuous closeness-to-final judging is the quality metric; operator touch time is the time KPI.

- **Autonomy is measured, not switched on.** Auto-send (closing category) and Steer & Send both run as shadows: every eligible draft gets a would-send verdict and nothing sends. The July graduation review said not yet (too few closing drafts, and a third of them would have erred on added content). Re-review on post-verbosity-fix data.
- **Model choice is settled until a trigger.** Sonnet 5 (plain and with thinking) was not viable for the advisor or the operator agent; Opus 5 was rejected on the accuracy/latency/cost trade-off. Opus 4.8 stays. Revisit on a retirement notice or a new model (parked entry).
- **Voice and length are governed by "one move per message"** plus explanation gating, after edit analysis showed founder edits were mostly deletions. Corpus-harvest rebuilt the KB from six years of replies and mined founder voice rules into the prompt.
- **Operator tooling keeps absorbing the per-ticket dance:** one-click Execute & Send, On Me tab, Ad Hoc Operator console, touch-time KPI, `revoke_discount_code` and the other operator write tools.
- **Accuracy work is eval-first.** The May and August sweeps showed the advisor more accurate than raw numbers implied (measurement artifacts dominated), established the change-driven sweep cadence, and left the untouched categories (shipping, general inquiry, sizing) as the highest edit rates. See project_advisor_accuracy_rebuild.md.

## Next Steps
1. **Auto-send graduation re-review** on post-2026-07-20 shadow drafts only; reconsider whether a higher-volume low-stakes category beats closing as the first graduation target.
2. **Change-driven accuracy sweep** when the trigger fires (see domain_cs.md cadence), including the recurring operator-action accuracy baseline (ground truth = what the sent prose says was done).
3. **Forgot-discount-code refund half** (parked).

## Decisions Made
- Agentic loops, not decision trees
- Human-in-the-loop for the foreseeable future until quality is proven; autonomy is earned per category from shadow data, never from a confidence field (advisor confidence has no correlation with whether Jamie edits)
