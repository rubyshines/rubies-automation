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
| **rubies-automation** (webhook server, main) | `node webhooks/server.js` | root `railway.toml` | Express server on Railway-assigned port. Receives Shopify, Gorgias, Gmail push webhooks. Also runs three sweeps: the warehouse-hold backstop (`reconcilePendingHolds`, every 3 min), unnotified pre-order outreach (`sweepUnnotifiedPreOrders`, every 10 min, seeds customer drafts), and the Gorgias spam-gate fast path (`runSpamGate`, every 15 min over tickets updated since the last tick — Gorgias sends no webhook for spam-flagged customer messages). Env-var source of truth. Auto-deploys on push to main. |
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
| daily-sync-all | `30 12 * * *` (8:30am ET) | `daily-sync-all.js` (authoritative list of sub-pipelines is in the file) |
| weekly-seo-digest | `45 10 * * 1` (Mon 6:45am ET) | `seo-tracking/weekly-seo-digest.js` |
| monthly-competitor-pricing | `0 14 1 * *` (1st, 10am ET) | `competitor-pricing/monthly-competitor-pricing.js` |
| passport-tracking-sync | `37 * * * *` (hourly at :37) | `customer-service/sync/syncPassportDelivery.js --limit 50` |

KB Refresh runs as a `daily-sync-all` step self-gated to Mondays UTC (re-harvest kb_sources, propagate kb_candidates into cs_knowledge_base with embeddings, flag drifted sources needing re-extraction) — see `customer-service/sync/refreshKb.js`. Free swimwear (import new applications, then reconcile register/order/expire/resend) runs as two sub-pipelines of `daily-sync-all` (`Free Swimwear Apps` + `Free Swimwear Lifecycle`), not a separate cron service.

Some cron start commands run `scripts/write-service-account-key.js` first (writes Google service account JSON from env var to disk at runtime): daily-seo-tracking, daily-sync-all, weekly-seo-digest, monthly-competitor-pricing.

> **No hourly drift-check service.** The daily sync's Ticket Reconciliation (in the "RUBIES Daily Sync" digest) is the drift safety net; `customer-service/sync/hourlyDriftCheck.js` remains for manual runs. Gotcha: every Gorgias HTTP integration URL must carry `?secret=<GORGIAS_WEBHOOK_SECRET>`; the webhook server 401s without it BEFORE any logging, so a misconfigured integration fails silently.

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
- **Local dashboard** → After server-side code changes, restart with `scripts/restart-dashboard.sh` (kills by command match, verifies exactly one process; never kill by port).

## Build Configuration

- **Nixpacks builder** for all services. The root `nixpacks.toml` (auto-detected, applies to every service) replaces the Chromium/snapd/X11 apt install that Nixpacks would otherwise add on detecting `puppeteer` in package.json (~420MB, flaky mirrors) with just the ~30 shared libraries the npm-bundled Chromium dynamically links (libglib2.0-0, libnss3, libgbm1, …). The bundled binary is NOT self-contained: with `aptPkgs = []` (April–September 2026) every Puppeteer launch on Railway failed with `libgobject-2.0.so.0: cannot open shared object file`, which surfaced only when the deployed dashboard first rendered a partner-agreement PDF at send (2026-09-08). Anything that launches Chromium on Railway (agreement PDFs, shipping lookup, passport tracking, competitor pricing) depends on this list; if Ubuntu renames a package again (`libasound2` → `libasound2t64` on Noble), the build fails visibly rather than the launch failing at runtime.
- **Never set `nixpacksConfigPath` in a service's railway toml.** A path that doesn't exist in the repo makes every build FAIL silently-in-the-dashboard (`couldn't locate the nixpacks config`). This killed daily-cs-stats and daily-cs-comparison from their creation (2026-04-16) until 2026-07-20 — their tomls pointed at `nixpacks-no-chromium.toml`, which had been deleted (replaced by the root `nixpacks.toml`) hours before the tomls were written.

## Key Files

- `nixpacks.toml` — root Nixpacks config (all services): installs the Chromium runtime shared libraries Puppeteer's bundled browser needs, nothing more
- `railway.toml` — webhook server deploy config
- `railway/*.toml` — per-cron-service deploy configs
- `scripts/copy-railway-vars.js` — env var propagation script
- `scripts/write-service-account-key.js` — writes Google service account JSON from env var to disk (used by crons needing Google APIs)
