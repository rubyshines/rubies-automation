Run the current branch's **CS ops dashboard** on a **stable, shareable ngrok URL** from a reserved-domain
pool — safe to run in several sessions at once. This is the test step of the dev loop: plan → build →
`/preview` → fix → `/ship`.

**Trigger phrases**: `/preview`, "give me a link to test," "let me try it," "preview this."
**Stop**: `/preview stop`.

## What it is
Runs the real dashboard (`customer-service/dashboard/server.js`) from THIS worktree/branch on a free local
port, exposed on a fixed `ra-N.ngrok.app` URL you can open anywhere incl. your phone. Uses the normal `.env`
(real Supabase/Shopify data), same as `npm run dashboard`. The URL is stable for the whole session (and
across server restarts during fixes).

## Reserved-domain pool (rubies-automations)
The **paid jamie@rubyshines.com** ngrok account (authtoken already set machine-wide — the default
`~/Library/Application Support/ngrok/ngrok.yml`, so **no `--config` flag**) owns these reserved domains:
```
ra-1.ngrok.app  ra-2.ngrok.app  ra-3.ngrok.app  ra-4.ngrok.app  ra-5.ngrok.app
```
ngrok only lets one tunnel bind a domain at a time, so **allocation is race-free**: always walk the pool in
**ascending order and claim the lowest-numbered domain ngrok accepts** (`ra-1` first, then `ra-2`, …). Previews
fill from the bottom and the URL is predictable. (Pool can grow — reserve more `ra-N`, register it in Google
OAuth, append here.)

> ⚠️ **Sign-in only works on registered origins.** Each `ra-N.ngrok.app` must be an **Authorized JavaScript
> origin** on the dashboard's Google OAuth client (Google Cloud project **RUBIES Operations**, the same client
> `GOOGLE_CLIENT_ID` points at). This is a one-time manual step per domain — Google rejects sign-in from any
> origin not on the list (same rule that gates the old `tahr-large-trivially` domain). If a slot was never
> registered, the tunnel + `/health` still come up, but Google sign-in throws `origin_mismatch`. Add
> `https://ra-1.ngrok.app` … `https://ra-5.ngrok.app` once and every slot works forever.

## Procedure
1. **Branch check**: on a feature branch (not `main`), ideally this session's own worktree under
   `~/Code/rubies-repo/worktrees/<name>`. A worktree is missing the gitignored runtime files, so share them in
   from the main checkout (`~/Code/rubies-repo/rubies-automations`) **once per worktree**:
   - `ln -sfn <main>/node_modules <worktree>/node_modules`
   - `ln -sf <main>/.env <worktree>/.env`  ← all secrets (incl. `GOOGLE_CLIENT_ID`) live in `.env`; **this repo
     has no `creds/` dir**, so the symlinked `.env` is all sign-in needs. The dashboard reads `<root>/.env` via
     `__dirname/../../.env`, so it picks up the worktree's symlink automatically.
   - If this worktree was cut before these commands existed, also copy them in:
     `cp <main>/.claude/commands/preview.md <main>/.claude/commands/ship.md <worktree>/.claude/commands/`
2. **Free local port** (never hardcode — the main checkout already holds 3847):
   `node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})"`
   → `APP_PORT`. (The dashboard needs only ONE port — Google sign-in is client-side GIS, no server callback.)
3. **Claim a domain** — for each `D` in `ra-1 ra-2 ra-3 ra-4 ra-5`:
   - `ngrok http $APP_PORT --domain=$D --log=stdout > /tmp/preview-$APP_PORT.ngrok.log 2>&1 &` (background; **no
     `--config`** — default account owns the pool)
   - Poll the log a few seconds: success looks like `started tunnel` / `url=https://$D`; failure (domain taken)
     looks like `ERR_NGROK` / `already online` / `failed to bind` → `kill` that ngrok and try the next `D`.
   - First `D` that establishes is yours. If the whole pool is busy, tell Jamie all 5 slots are in use.
4. **Serve** the dashboard behind the tunnel (background) on the claimed port:
   `PORT=$APP_PORT node customer-service/dashboard/server.js > /tmp/preview-$APP_PORT.server.log 2>&1 &`
   (no `PUBLIC_URL` needed — the session cookie is derived from the request host, so it works on any ngrok host)
   - Record domain + both PIDs in `/tmp/preview-$APP_PORT.pids`, in this exact format (so `/ship` can stop it):
     ```
     domain=$D
     server_pid=<dashboard pid>
     ngrok_pid=<ngrok pid>
     app_port=$APP_PORT
     ```
   - **On each fix**: server-side change → restart just this dashboard (URL unchanged); static asset (CSS/JS/sw)
     → no restart, the server serves it fresh from disk per request.
5. **Wait** for `http://localhost:$APP_PORT/health` → 200 (`{"status":"ok",...}`), then report.

## Report
```
✅ Preview live on https://$D  (open on your phone too; stable for this session)
   port $APP_PORT · dashboard from <worktree> · stop with /preview stop
```
If the slot's origin isn't registered in Google OAuth yet, add: `⚠️ sign-in needs https://$D added as an
Authorized JS origin (RUBIES Operations OAuth client) — one-time.`

## `/preview stop`
Kill only THIS preview: read `/tmp/preview-$APP_PORT.pids`, kill those PIDs (dashboard + ngrok), remove the
temp files (`/tmp/preview-$APP_PORT.*`). **Never** `pkill ngrok` / `pkill node` broadly — that kills other
sessions' previews and the main checkout's 3847 server.

## Notes
- **Real prod data** (shared Supabase/Shopify) — fine for clicking around; careful with destructive tests
  (sending drafts, executing exchanges/refunds, edits) — they hit live systems.
- ngrok authtoken is machine-wide on the paid jamie@rubyshines.com plan, which allows the concurrent tunnels.
- This is **distinct** from the old single-domain `tahr-large-trivially.ngrok-free.app` flow (second free
  account at `.ngrok/ngrok.yml`). `/preview` uses the default account + the `ra-N` pool — don't pass `--config`.
