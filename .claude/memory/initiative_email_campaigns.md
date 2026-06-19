---
name: Email Campaigns
description: Help Sadie MacDonald use RUBIES tooling for Klaviyo email campaigns
type: project
domains: [marketing]
last_updated: 2026-06-19
---

## Goal
Enable Sadie MacDonald (email contractor) to produce email analytics reports and build campaigns fast using RUBIES AI tooling, replacing the manual report-building she does by hand.

## Phases
1. Tooling & reporting — BUILT + shipped 2026-06-19 (PR #8)
2. Onboard Sadie — next (a 2-hour working session was the original trigger for this build)

## Current Status
Built and shipped the full system (see domain_marketing.md for detail):
- Supabase-backed email report generator (`reports/email-report.js`): Overview / Lists / Campaigns / Flows / Strategy, audience growth, revenue-over-time, comparisons, funnel, flows, campaign heatmap, creative gallery, holistic AI takeaways, plus a plain-language `how-it-works.html` explainer.
- Seven marketing-studio MCP tools (ideas, subject lab, draft, calendar, report, review quotes, playbook refresh), grounded in real performance + brand voice + the campaign-objectives model.
- Recency-weighted Marketing Playbook + daily feeds for flows / audience / sessions.

## Decisions Made
- Last-touch attribution, no double-counting; attributed ≠ incremental (a holdout test is the only real measure of email lift).
- Report reads 100% from Supabase feeds; campaign tools grounded in real performance data, brand voice, and the objectives model (judge each send by its real goal, not revenue alone).

## Next
- Onboard Sadie to the studio tools; capture her edits to AI drafts as training signal.
- Single-file shareable report; holdout test for true incremental lift.
