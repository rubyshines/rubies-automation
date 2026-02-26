# RUBIES Automations

Collection of automation scripts for RUBIES operations.

## Projects

### SEO backfill (one-time)

Historical data backfill into Supabase for GSC, Shopify, and GA4. Run locally only (not on GitHub Actions).

- **Script:** `seo-tracking/backfill.js`
- **Run:** From repo root: `npm run backfill` or `node seo-tracking/backfill.js`
- **Config:** `config.json` at project root; copy `.env.example` to `.env` and set `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and same auth as analytics (e.g. `SERVICE_ACCOUNT_KEY_PATH`, `SEARCH_CONSOLE_SITE_URL`, `SHOPIFY_*`, `GA4_PROPERTY_ID`).
- **Schema:** If you don’t set `SUPABASE_DATABASE_URL`, run `seo-tracking/supabase-schema.sql` once in the Supabase SQL Editor to create tables.

### Future Automations
- `wholesale/` — Wholesale lead management *(coming soon)*

## GitHub Actions

Automated workflows live in `.github/workflows/`. Each project has its own workflow file. Workflows are triggered on a daily schedule and can also be run manually from the GitHub UI.

## Repository Secrets

To run automations via GitHub Actions, add the following secrets in:  
**Repository → Settings → Secrets and variables → Actions**

### Analytics secrets

| Secret Name | Description |
|---|---|
| `GA4_PROPERTY_ID` | Google Analytics 4 property ID |
| `GOOGLE_SHEET_ID` | ID from the target Google Sheet URL |
| `SERVICE_ACCOUNT_KEY` | Full JSON content of `service-account-key.json` |

**Never commit credential files to this repository.**
