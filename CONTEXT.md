# RUBIES Automations — Root Context

This repo contains all automations for RUBIES (rubyshines.com), a Shopify-based e-commerce brand selling gender-affirming underwear and swimwear.

## Purpose
Automate data collection, analysis, and outreach processes to increase revenue and reduce manual work.

## Active Projects
- `/seo-tracking` — daily data pipeline from GA, Search Console, Shopify → Supabase → Google Sheets summary
- `/wholesale-expansion` — lead discovery, outreach, and relationship tracking for wholesale partners

## Shared Utilities
All reusable clients and helpers live in `/shared`. Always use these before building new ones.

## Stack Summary
Node.js / CommonJS / Supabase / Google Sheets / Shopify / GitHub Actions / Claude API

## Notes
- Jobs run via GitHub Actions
- One-off scripts (e.g. backfills) run locally with Node
- `.env` for local, GitHub Secrets for actions
