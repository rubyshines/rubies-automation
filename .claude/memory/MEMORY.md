# RUBIES Automations — Memory Index

## Domain Map
- tickets, Gorgias, advisor, exchanges, sizing, drafts, knowledge base, follow-ups, incident outreach, customer notification, batch email, follow-up campaign, feedback request, mistaken pre-order → Customer Service (domain_cs.md) [CS Advisor]
- QBO, margins, cash flow, tax, budget, CCPC, corporate, accounting → Finance (domain_finance.md) [Finance Advisor]
- retailers, lead scoring, scraping, wholesale orders, B2B, outreach → B2B Sales (domain_b2b_sales.md) [Sales Advisor]
- SEO, Klaviyo, email campaigns, blog, competitor pricing, reviews, JudgeMe, Sadie → Marketing (domain_marketing.md) [Marketing Advisor]
- grading, measurements, fabric deltas, size charts, design, Natta → Product Design (domain_product_design.md) [Merchandising Advisor]
- products, variants, inventory, catalog, fuzzy search, pre-orders → Inventory (domain_inventory_catalog.md) [Merchandising Advisor]
- shipping, tracking, Warehance, 3PL, delivery estimates, fulfillment → Logistics (domain_logistics.md) [Merchandising Advisor]
- donations, LGBTQ+ partners, free swimwear → Community (domain_community.md) [Community Advisor]
- webhooks, Railway, Supabase, sync pipelines, Gmail, deployment → Tech (domain_tech.md) [Tech Advisor]
- deploy, cron, env vars, Railway services, scheduled jobs → Deployment (reference_deployment.md)
- If no domain matches, scan initiative list below for keyword match.

## Always Read (every session)
- [How we collaborate](feedback_collaboration.md) — process, communication, output format
- [Technical rules](feedback_technical_rules.md) — architecture patterns, Opus-only, prompt-not-code, pagination
- [Parked items](parked.md) — single journal for deferred bugs, ideas, half-formed plans (use /park and /parked)

## References
- [Deployment & Operations](reference_deployment.md) — Railway services, cron schedules, env var flow, local dev servers

## Domains
- [Customer Service](domain_cs.md) — AI advisor, dashboard, exchanges, intake, knowledge base, follow-ups
- [Finance](domain_finance.md) — QBO integration, sync, reporting, corporate structure, IRAP
- [B2B Sales](domain_b2b_sales.md) — retailer discovery, scraping, lead scoring, wholesale orders
- [Marketing & Growth](domain_marketing.md) — SEO, Klaviyo, competitor pricing, blog, pricing strategy
- [Product Design & R&D](domain_product_design.md) — sizing systems, grading specs, measurements
- [Inventory & Catalog](domain_inventory_catalog.md) — product sync, fuzzy search, inventory snapshots
- [Logistics & Fulfillment](domain_logistics.md) — 3PL, multi-carrier tracking, delivery estimates
- [Community & Partnerships](domain_community.md) — donation routing, LGBTQ+ partners
- [Tech & Website](domain_tech.md) — webhooks, Railway, sync pipelines, shared clients, Gmail

## Active Projects
- [CS Advisor Efficiency](project_cs_efficiency.md) — cost/latency optimization, Sonnet+thinking shadow eval pulled 2026-04-30 (not viable)
- [Structured Output Consistency](project_structured_output_consistency.md) — catch advisor drafts where prose claims action but structured fields don't (Phase 1 prompt + Phase 2 holdout visibility done, Phase 3 steer-aware scenario assertions next)
- [Ad Hoc Operator Console](project_adhoc_operator.md) — ad-hoc Opus operator console with all RUBIES tools, dashboard top-nav (desktop) + bottom-nav (mobile)
- [Wholesale pre-increase pricing flag](project_wholesale_pre_increase_pricing.md) — `pre_increase_pricing: true` on `create_wholesale_order` to invoice transitional retailers at pre-Apr-16 retail × wholesale discount
- [Reduce CS Time Per Ticket](project_reduce_cs_time_per_ticket.md) — close measurement gaps on operator touch time, surface cumulative per-ticket close time + headline "Time on CS today" KPI, foundation for follow-on optimizations under CS Automation
- [Execute & Send](project_execute_and_send.md) — one-click background button that runs the operator action (auto-confirming phase 2 when nothing diverges) and sends the draft; Phase 0 removes the manufactured refund-amount divergence

## Initiatives
- [AI Infrastructure](initiative_ai_infrastructure.md) — MCP tools, sync pipelines, webhooks, dashboard, memory system
- [CS Automation](initiative_cs_automation.md) — AI advisor reducing Jamie's CS time
- [Pricing Strategy 2026](initiative_pricing_strategy.md) — price increases, fixed bundle pricing, DDP optimization
- [Naomi Gaff Launch](initiative_naomi_launch.md) — bring Naomi gaff to market as full production product
- [IRAP Proposal](initiative_irap_proposal.md) — NRC-IRAP funding for AI ops automation
- [B2B Expansion](initiative_b2b_expansion.md) — grow retailer partnerships and wholesale channel
- [SEO & Content](initiative_seo_content.md) — drive organic traffic and revenue
- [Email Campaigns](initiative_email_campaigns.md) — Sadie MacDonald using RUBIES tooling for Klaviyo
- [Website Theme](initiative_website_theme.md) — build out Shopify theme launched Nov 2025, Natta
- [LGBTQ+ Partnerships](initiative_lgbtq_partnerships.md) — expand org partnerships, donation closet programs
- [Production Pipeline](initiative_production_pipeline.md) — unify inventory projections, production orders, pre-orders, QC, Warehance receiving
