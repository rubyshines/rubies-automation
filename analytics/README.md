# RUBIES Analytics Automation

Automatically tracks SEO performance daily by pulling data from Google Analytics 4, Google Search Console, and Shopify, then writing to a Google Sheet.

## What It Does

- **Daily data collection** (7-day trailing window)
- Tracks organic traffic sessions, users, and conversion rate
- Monitors keyword rankings (top 10 by impressions)
- Prevents duplicate runs on the same day
- Runs automatically via GitHub Actions at 9 AM UTC daily

## Prerequisites

- Node.js 18+
- Google Cloud project with APIs enabled:
  - Google Analytics Data API
  - Google Search Console API
  - Google Sheets API
- Service account with access to:
  - Google Analytics (Viewer role)
  - Search Console (Full permission)
  - Target Google Sheet (Editor access)
- Shopify store with Admin API access (at least `read_orders`)

**Shopify authentication** (use one of these):

- **Token-only (Custom App):** set `SHOPIFY_STORE_URL` and `SHOPIFY_ACCESS_TOKEN`.
- **API key + password (same as rubies-utilities / legacy Private App):** set `SHOPIFY_STORE_URL`, `SHOPIFY_API_KEY`, and `SHOPIFY_PASSWORD`. You can use the same values as in `rubies-utilities/creds/creds-from-shopify.json` (`shopifyApiKey` → `SHOPIFY_API_KEY`, `shopifyPassword` → `SHOPIFY_PASSWORD`).

## Local Setup

1. **Install dependencies:**
   ```bash
   cd analytics
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

3. **Add service account key:**
   - Place `service-account-key.json` in the `analytics/` directory
   - This file is gitignored — never commit it!

4. **Set up your Google Sheet:**
   - Create a new Google Sheet named `RUBIES SEO Tracker`
   - The script will automatically create two tabs on first run:
     - `RUBIES SEO Tracker - Daily Metrics`
     - `RUBIES SEO Tracker - Keyword Rankings`
   - Share the sheet with your service account email (Editor access)

5. **Run manually:**
   ```bash
   npm run fetch-metrics
   ```

## GitHub Actions Setup

The script runs automatically via GitHub Actions. Credentials are stored as GitHub Secrets (never in the repo).

**Required secrets** (add in: Repo → Settings → Secrets and variables → Actions):

| Secret Name | Value |
|---|---|
| `GA4_PROPERTY_ID` | `363593585` |
| `GOOGLE_SHEET_ID` | Your sheet ID from the URL |
| `SERVICE_ACCOUNT_KEY` | Full contents of `service-account-key.json` |
| `SHOPIFY_STORE_URL` | Your store (e.g. `rubies-active-wear.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` *or* `SHOPIFY_API_KEY` + `SHOPIFY_PASSWORD` | Shopify Admin API credentials (see Shopify authentication above) |

See the main repo README for step-by-step GitHub setup instructions.

## Troubleshooting

**"Already ran today" message**
- The script only runs once per day by design
- Wait until tomorrow, or delete the last row from "Daily Metrics" to reset

**Authentication errors**
- Verify the service account has been granted access to GA4, Search Console, and the Sheet
- Check that all three APIs are enabled in Google Cloud Console
- Verify `SERVICE_ACCOUNT_KEY_PATH` in `.env` points to the correct file

**"No data returned" from GA4**
- Confirm GA4 tracking is active on rubyshines.com
- The filter requires traffic tagged as `Organic Search` channel group

**"No data returned" from Search Console**
- Verify the `SEARCH_CONSOLE_SITE_URL` matches exactly what's verified in GSC
- GSC data can lag 2–3 days; recent days may show low numbers

**Shopify: lots of "Unknown" in channel breakdown**
- The script uses the Orders API and classifies each order by `source_name`, `referring_site`, and `landing_site`. Many orders have no or generic values (e.g. `source_name: "web"`), so they are mapped to **direct**; anything that doesn’t match search/social/email rules becomes **unknown**.
- **Validate:** From the `analytics` folder run:
  ```bash
  npm run debug-shopify
  ```
  Or for a specific date: `node scripts/debug-shopify-sources.js 2026-02-18`
  This prints each order’s raw `source_name`, `referring_site`, `landing_site` and the classified channel so you can see why something is unknown.
- **Double-check in Shopify:** In Shopify Admin go to **Analytics → Reports** and use “Sales by traffic source” or “Sessions by referrer source” for the same date. The API does not expose the exact same session attribution as the Shopify UI; our breakdown is order-based and best-effort.

**Sheet not found / tab errors**
- Make sure `GOOGLE_SHEET_NAME` in `.env` exactly matches your sheet's document title
- Make sure the sheet has been shared with the service account email

## Data Output

**Tab: "Daily Metrics"** — GA4 only (original analytics; not mixed with Shopify).

| Date | Organic Sessions | Organic Users | Conversion Rate (%) | Notes |
|---|---|---|---|---|
| 2026-02-18 | 1234 | 1150 | 2.5 | Baseline (first run) |
| 2026-02-19 | 1289 | 1201 | 2.7 | |

**Tab: "Keyword Rankings"** — GSC only.

| Keyword | 2026-02-18 Rank | 2026-02-18 Clicks | 2026-02-18 Impressions | 2026-02-19 Rank | ... |
|---|---|---|---|---|---|
| trans swimwear | 12.3 | 45 | 1250 | 11.8 | ... |

New date columns are added automatically each day. Historical data is never overwritten.

**Tab: "Shopify Channel Breakdown"** — Shopify only (per-channel orders/revenue). Separate from Daily Metrics.

## Support

For issues, check the GitHub Actions logs in the repo's Actions tab, or review the error messages printed to the console when running locally.
