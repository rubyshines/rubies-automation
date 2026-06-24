---
name: Deployment & Operations
description: Railway services, cron schedules, env var flow, local dev servers — operational reference for all deployment questions
type: reference
originSessionId: 8901eb7f-f2a7-48cf-9d8d-58c3078f9a28
---
## Railway Project: RUBIES Operations

All services share one codebase (rubies-automations). Each service has its own `railway/*.toml` config defining start command and schedule.

### Always-On Services

| Service | Entry Point | Config | Notes |
|---------|------------|--------|-------|
| **rubies-automation** (webhook server, main) | `node webhooks/server.js` | root `railway.toml` | Express server on Railway-assigned port. Receives Shopify, Gorgias, Gmail push webhooks. Also runs the warehouse-hold backstop sweep (`reconcilePendingHolds`, every 3 min). Env-var source of truth. Auto-deploys on push to main. |
| **cs-dashboard** | `node customer-service/dashboard/server.js` | `railway/cs-dashboard.toml` | Ops dashboard at **ops.rubyshines.com**. The Railway-deployed twin of the local 3847 dev server. Auto-deploys on push to main. |

### Cron Services

All cron times are UTC. Each has a `railway/<name>.toml` with its `cronSchedule` + `startCommand`.

| Service | Schedule (UTC) | Entry Point |
|---------|---------------|-------------|
| daily-sales-report | `1 4 * * *` (12:01am ET) | `analytics/daily-sales-report.js` |
| daily-order-alerts | `40 9 * * *` (5:40am ET) | `reports/dailyOrderAlerts.js` |
| daily-seo-tracking | `15 10 * * *` (6:15am ET) | `seo-tracking/daily-seo-tracking.js` |
| daily-cs-comparison | `30 11 * * *` (7:30am ET) | `analytics/daily-cs-comparison.js` |
| daily-cs-stats | `0 12 * * *` (8:00am ET) | `analytics/daily-cs-stats.js` |
| daily-sync-all | `30 12 * * *` (8:30am ET) | `daily-sync-all.js` — 16 sub-pipelines |
| weekly-seo-digest | `45 10 * * 1` (Mon 6:45am ET) | `seo-tracking/weekly-seo-digest.js` |
| monthly-competitor-pricing | `0 14 1 * *` (1st, 10am ET) | `competitor-pricing/monthly-competitor-pricing.js` |
| passport-tracking-sync | `37 * * * *` (hourly at :37) | `customer-service/sync/syncPassportDelivery.js --limit 50` |
| cs-drift-check | `0 * * * *` (hourly) | `customer-service/sync/hourlyDriftCheck.js` — read-only Gorgias↔Advisor drift detector, emails only on drift (distinct from the never-schedule `gorgiasAdvisorResync.js` fixer) |
| free-swimwear | `0 13 * * *` (9:00am ET) | `syncFreeSwimwearRequests.js --live` then `freeSwimwearLifecycle.js --live` — import new free-swimwear applications, then reconcile register/order/expire/resend |

Some cron start commands run `scripts/write-service-account-key.js` first (writes Google service account JSON from env var to disk at runtime): daily-seo-tracking, daily-sync-all, weekly-seo-digest, monthly-competitor-pricing, free-swimwear.

> **`cs-drift-check` — config-path note (2026-06-14).** This service was misconfigured for a long time: with no `railway/cs-drift-check.toml` it fell back to the root `railway.toml` and ran a duplicate `node webhooks/server.js` (its hourly drift email never ran). Fixed by adding `railway/cs-drift-check.toml` + the entry in `copy-railway-vars.js`. **One-time manual step required:** in the Railway dashboard, set this service's config-as-code path to `railway/cs-drift-check.toml` (Settings → Config-as-code) — Railway won't pick up the new file until that pointer is changed off the root `railway.toml`.

### Local-Only Services

| Service | Port | Entry Point |
|---------|------|-------------|
| MCP server | stdio | `customer-service/server.js` — Claude Code connects via stdio transport |
| Dashboard (dev) | 3847 | `customer-service/dashboard/server.js` — local dev twin of the deployed cs-dashboard. Static assets (CSS/JS/sw) serve fresh from disk per request; restart only after **server-side** changes. |

**Local Mobile Testing (ngrok):** A second ngrok account (separate from personal) has its config at `.ngrok/ngrok.yml` (gitignored — if missing, the master copy survives in the iCloud repo copy under `~/Library/Mobile Documents/com~apple~CloudDocs/Documents/RUBIES creative content/code/rubies-repo/rubies-automations/.ngrok/`). That account has the reserved static domain `tahr-large-trivially.ngrok-free.app`, which is registered as an Authorized JavaScript origin on the dashboard's Google OAuth client (project RUBIES Operations) — Google sign-in only works on registered origins, so random free-tier URLs can never log in. Start with: `ngrok http <port> --config .ngrok/ngrok.yml --url tahr-large-trivially.ngrok-free.app`. When serving from a worktree, run the dashboard on a non-default port (`PORT=3848 node customer-service/dashboard/server.js`) so it can't collide with the main checkout's 3847 server, and point ngrok at that port. Note: `.ngrok/` is gitignored, so ripgrep won't find files inside it — check the directory directly.

**Preview / ship slash commands (preferred, 2026-06-17):** `/preview` and `/ship` (`.claude/commands/`) make preview+deploy one step. `/preview` runs the current worktree's dashboard on a stable URL from the `ra-1`…`ra-5.ngrok.app` reserved-domain pool on the **default (paid jamie@rubyshines.com) ngrok account** (machine-wide authtoken, so **no `--config`** — distinct from the `.ngrok/ngrok.yml` `tahr-large` account above); it claims the lowest free domain (race-free, one tunnel per domain), picks a dynamic local port, and `/preview stop` is cwd-scoped. `/ship` does push → squash-merge PR → Railway auto-deploy → stop preview → remove worktree (default `gh` auth sees the repo). Prefer this over the single-domain `tahr-large` flow, especially for concurrent multi-session previews. **One-time prerequisite for sign-in:** each `https://ra-N.ngrok.app` must be added as an Authorized JavaScript origin on the RUBIES Operations OAuth client — until then a slot's tunnel + `/health` work but Google login throws `origin_mismatch`.

## Env Var Management

- **Source of truth:** Railway webhook server (main service).
- **Propagation:** `node scripts/copy-railway-vars.js` reads all vars from the main service via Railway GraphQL API and copies them to the services in its `CRON_SERVICES` array — currently 11 (the 10 crons above + cs-dashboard). Skips Railway-injected vars (`RAILWAY_*`, `NIXPACKS*`, etc.).
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
