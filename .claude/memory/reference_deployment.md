---
name: Deployment & Operations
description: Railway services, cron schedules, env var flow, local dev servers — operational reference for all deployment questions
type: reference
originSessionId: 8901eb7f-f2a7-48cf-9d8d-58c3078f9a28
---
## Railway Project: RUBIES Operations

All services share one codebase (rubies-automations). Each service has its own `railway/*.toml` config defining start command and schedule.

### Always-On Service

| Service | Entry Point | Notes |
|---------|------------|-------|
| **Webhook server** (main) | `node webhooks/server.js` | Express server on Railway-assigned port. Receives Shopify, Gorgias, Gmail push webhooks. Config in root `railway.toml`. Auto-deploys on push to main. |

### Cron Services

All cron times are UTC.

| Service | Schedule (UTC) | Entry Point |
|---------|---------------|-------------|
| daily-sync-all | `30 12 * * *` (12:30pm / 8:30am ET) | `daily-sync-all.js` — 16 sub-pipelines |
| daily-sales-report | `1 4 * * *` (4:01am / 12:01am ET) | `analytics/daily-sales-report.js` |
| daily-order-alerts | `40 9 * * *` (9:40am / 5:40am ET) | `reports/dailyOrderAlerts.js` |
| daily-seo-tracking | `15 10 * * *` (10:15am / 6:15am ET) | `seo-tracking/daily-seo-tracking.js` |
| passport-tracking-sync | `37 * * * *` (hourly at :37) | `customer-service/sync/syncPassportDelivery.js --limit 50` |
| weekly-seo-digest | `45 10 * * 1` (Mon 10:45am / 6:45am ET) | `seo-tracking/weekly-seo-digest.js` |
| monthly-competitor-pricing | `0 14 1 * *` (1st of month 2pm / 10am ET) | `competitor-pricing/monthly-competitor-pricing.js` |

Some cron start commands run `scripts/write-service-account-key.js` first (writes Google service account JSON from env var to disk at runtime).

### Local-Only Services

| Service | Port | Entry Point |
|---------|------|-------------|
| MCP server | stdio | `customer-service/server.js` — Claude Code connects via stdio transport |
| Dashboard | 3847 | `customer-service/dashboard/server.js` — ops UI at localhost:3847. Kill and restart after code changes. |

**Local Mobile Testing (ngrok):** A second ngrok account (separate from personal) has its config at `.ngrok/ngrok.yml` (gitignored). Free tier = dynamic URLs each session. Start with: `ngrok http 3847 --config .ngrok/ngrok.yml`. Note: `.ngrok/` is gitignored, so ripgrep won't find files inside it — check the directory directly.

## Env Var Management

- **Source of truth:** Railway webhook server (main service).
- **Propagation:** `node scripts/copy-railway-vars.js` reads all vars from main service via Railway GraphQL API, copies to all 7 cron services. Skips Railway-injected vars (`RAILWAY_*`, `NIXPACKS*`, etc.).
- **When to run:** After adding or changing any env var on the main service.
- **Local `.env`:** Separate from Railway. Not synced automatically. Must be updated manually if a new var is needed for local dev.
- **Service IDs** are hardcoded in `scripts/copy-railway-vars.js` — update the `CRON_SERVICES` array when adding/removing Railway services.

## Deploy Flow

- **Push to main** → Railway auto-deploys the webhook server. Cron services pick up the new code on their next scheduled run.
- **Env var change** → Set on main service (Railway dashboard or GraphQL API) → run `copy-railway-vars.js` → webhook server auto-redeploys (env var change triggers redeploy).
- **New cron service** → Create in Railway dashboard → add `railway/<name>.toml` with build/deploy/schedule config → add service ID to `scripts/copy-railway-vars.js` CRON_SERVICES array → run copy script.
- **Local dashboard** → After code changes, restart: `lsof -ti:3847 | xargs kill -9` then relaunch.

## Build Configuration

- **Nixpacks builder** for all services. Nixpacks auto-detects `puppeteer` in `package.json` and installs Chromium + snapd + X11 libs via apt (~109MB, slow, flaky mirrors).
- **Services that DON'T need Puppeteer** use `nixpacks-no-chromium.toml` (via `nixpacksConfigPath` in their railway toml). This skips all apt packages and sets `PUPPETEER_SKIP_DOWNLOAD=true`.
- **Services that DO need Puppeteer:** `monthly-competitor-pricing`, `passport-tracking-sync` — these use the default Nixpacks detection (no custom config).
- When adding a new service: if it doesn't use Puppeteer, add `nixpacksConfigPath = "nixpacks-no-chromium.toml"` to its `[build]` section.

## Key Files

- `nixpacks-no-chromium.toml` — Nixpacks config that skips Chromium/Puppeteer apt packages
- `railway.toml` — webhook server deploy config
- `railway/*.toml` — per-cron-service deploy configs
- `scripts/copy-railway-vars.js` — env var propagation script
- `scripts/write-service-account-key.js` — writes Google service account JSON from env var to disk (used by crons needing Google APIs)
