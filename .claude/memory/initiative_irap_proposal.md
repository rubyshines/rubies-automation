---
name: IRAP Proposal
description: NRC-IRAP funding for AI Operations Platform, standard technical project, Jun 2026-Feb 2027
type: project
domains: [finance, cs, b2b_sales, marketing, tech]
last_updated: 2026-09-02
originSessionId: cea77ddb-41cd-438f-8b81-dd16fbb62d78
---
## Goal
Secure NRC-IRAP funding via the **standard technical IRAP** track (reframed from ARP) for the **RUBIES AI Operations Platform** — agentic AI tooling for productivity and revenue growth. May-Dec 2026 timeline. Three objectives spanning customer service, partner channel expansion, and growth opportunity discovery.

## Phases
1. ITA meeting with Lisa Boreanaz — complete (Oct 2025)
2. Reframe from ARP to standard technical IRAP — complete (Apr 2026, Lisa approved)
3. Objectives drafted with measurable targets — complete (Apr 2026)
4. Precursor email to Lisa for feedback on objectives shape — complete
5. Activities and full proposal — complete (final proposal declared May 26, 2026: "Development of an Agentic AI Operations Platform for Autonomous Business Process Execution", $116,250 total / $75,000 requested, Jun 2026-Feb 2027)
6. Submission and approval — submitted; NRC project number 1044596 assigned (Jul 2026). Confirm CA execution status with Lisa.
7. Execution (monthly claims, ITA reporting) — started; CA backdated to Jun 1, 2026, reporting from Jun 2026

## Current Status
Proposal submitted, NRC project number 1044596. Monthly status report generator built (`finance/generate-irap-status-report.js`): builds each report from the month's actual repo history, Opus-synthesized into the NRC template; first report (June 2026, per backdated CA start) includes a "starting point at project commencement" baseline section disclosing pre-existing capabilities. Reports describe in-period work only — pre-project work is disclosed as baseline, never re-reported as new (integrity decision, 2026-07-22). Founder hours are claimable as eligible salary cost (agentic development practice).

- July-August 2026 combined report generated as claim 2 (Sep 2026; the July claim was skipped, so the catch-up spans both months). Generator now supports multi-month claim periods. A report need not cover every objective every period, and metrics are included only when the founder supplies them as notes (Jamie's call, 2026-09-02).

## Project Title
RUBIES AI Operations Platform: Agentic AI Tooling for Productivity and Revenue Growth

## Project Summary (2.2)
Develop an agentic AI operations platform — AI agents that reason over real business context, autonomously invoke internal tools, and execute multi-step workflows previously requiring human judgment. Automates customer service, accelerates partner channel growth, and surfaces decision intelligence to drive incremental revenue. Goal: enable a small Canadian SME to scale revenue and capacity faster than headcount.

## Objectives

1. **Customer service automation** — AI agent autonomously handles CS tickets (sizing, exchanges, refunds, shipping, product questions) end-to-end. *Target: founder CS time 10 → ≤2 hrs/week (80% reduction) by project end, CSAT held at or above baseline.*

2. **Partner channel expansion (wholesale + affiliate)** — AI agent owns discovery, qualification, outreach, onboarding across retailer + affiliate partners (incl. LGBTQ+ orgs, online-only stores). *Target: end of month 12, partner-channel revenue trailing-3-month run-rate ≥10% of total (≥$100K annualized). Partner-channel = Shopify orders tagged `wholesale` OR attributed via affiliate discount code/tag. Baseline (Apr 2026): 3.5% / $25K annualized from 4 retailer accounts (Sock Drawer Heroes, Illusions Lingerie, Transformation Closet, Early2Bed).*

3. **Growth opportunity discovery and validation** — AI synthesizes business data to surface, design, validate growth experiments across pricing, SEO, CRO, product/bundle mix. *Target: ≥$50K cumulative annualized run-rate impact across implemented experiments by project end. AI-surfaced = hypothesis from AI analysis with documented decision trail.*

**Combined target:** ~$200K+ annualized business impact at project end, compounding in years 2-5.

## Decisions Made

- **Reframed ARP → standard technical IRAP** (Apr 2026, Lisa's approval). Founder salary + contractor + R&D + software dev costs eligible. ARP-specific exclusions (no software, no training, no website) no longer apply.
- **Agentic AI architectures as named innovation.** Positions project at leading edge vs. commodity SaaS adoption — fundable territory for IRAP.
- **Decision intelligence is co-equal pillar with productivity.** Not just "AI does work faster" — AI surfaces commercially consequential insights (pricing, margin, SEO, CRO, customer cohorts).
- **Autonomy as secondary metric, not 4th objective.** Tracked per-objective (auto-handle rate, % outreach unedited, % experiments AI-end-to-end). Featured in Section 5.1/6.1 innovation narrative.
- **Framing softens "solo founder" to "small business with lean team."** Avoids tension with IRAP preference for FTE growth; preserves option for downstream hiring as productivity creates capacity.
- **Spillover commitment:** RUBIES will share AI automation techniques with other IRAP clients via NRC-facilitated case studies, peer workshops, direct mentorship. Strengthens Benefits-to-Canada beyond firm-level economic impact.
- **Email excluded from objective 3 scope** — Sadie's Klaviyo workflow is robust; growth discovery focuses on pricing, SEO, CRO, product mix.
- **Strict AI attribution rule for objective 3.** Each initiative requires AI-authored hypothesis (timestamped) + AI-authored experiment design. Initiatives Jamie conceives independently don't count toward $50K.

## Reference Materials
- Proposal template: `9.2 Small Project Proposal Template - ARP Proposal template - document for client FY 2025.pdf` (note: file name says ARP but template is generic small-project format)
- Contractor proposal guidelines: `3.4-Guidelines_for_Contractor_Proposal.pdf`
- Eligible activities email from Lisa (Oct 2025) — ARP-specific, no longer fully applicable post-reframe

## What's Next
- Confirm Contribution Agreement status and claim schedule with Lisa
- Submit the July-August report (claim 2, generated Sep 2026); September's report follows after month end
- Next report after the Fashion Zone move completes needs `--address-changed` (firm-address question on the NRC form)
- Backfill `wholesale` tag on 4 historical retailer accounts (clean objective-2 baseline)
- Choose affiliate app + verify it tags Shopify orders (not just app dashboard)
- Monthly claims, ITA reporting cadence, milestone tracking — Claude to manage ongoing
