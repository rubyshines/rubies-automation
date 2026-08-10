# Evey invisible to CS advisor — config-status auto-sync + ship

## Context

The advisor drafted "I'm not sure I recognize 'Evey'" on ticket #110051613 despite the Evey Shaping Sports Bra being live. Root cause found: the advisor resolves product names through `product_cs_config` (nicknames/keywords via the `get_cs_product_config` RPC, which filters `WHERE status = 'active'` — [cs-config-schema.sql:39](../Code/rubies-repo/rubies-automations/customer-service/cs-config-schema.sql)). `create_product` seeded the Evey's row on 2026-07-01 with `status: 'draft'` (correct at the time — the Shopify product was DRAFT), but **nothing in the launch flow flips the row when the product goes ACTIVE**. The Shopify product and Supabase mirror are both ACTIVE with all 9 `SPB-BLK-*` variants; only the config row lags. Second layer: advisor config maps load only at server startup (`initCsConfig()`), and `reload_products` doesn't refresh them.

Fix approved by Jamie ("fix this and ship it"): make the config status *derive* from the product status so this never recurs, refresh in-process maps where possible, activate the Evey now, and deploy.

## Design

`product_cs_config.status` mirrors the Shopify product status: product ACTIVE → config `active`; product DRAFT or missing from the mirror → config `draft`. Symmetric on purpose — archiving/unpublishing a product should also remove it from the advisor's vocabulary. Reconcile runs from three places:

1. **Daily product sync** (`syncProducts.run()`, step 8) — the batch safety net.
2. **Products webhook** (`webhooks/handlers/shopifyProducts.js`) — fires the moment a product is flipped ACTIVE in Shopify admin; also re-runs `initCsConfig()` in-process so the webhook server's advisor (intake drafts) picks it up immediately.
3. **`reload_products` tool** — already calls `loadProducts()` → `syncProducts.run()` (so the reconcile runs); additionally re-runs `initCsConfig()` so a running server refreshes its nickname/keyword maps without restart.

## Changes (already staged in worktree `~/Code/rubies-repo/worktrees/evey-cs-config`, branch `wt/evey-cs-config`)

- **NEW `customer-service/lib/csConfigStatus.js`** — `computeCsConfigStatusChanges(products, configRows)` (pure diff, testable) + `syncCsConfigStatus(supabase)` (paginated reads via `fetchAllPaginated`, per-row update, returns the change list).
- **`customer-service/sync/syncProducts.js`** — step 8 calls `syncCsConfigStatus`, logs changes, fail-soft (try/catch — a config sync failure never breaks the product sync).
- **`webhooks/handlers/shopifyProducts.js`** — after product/variant upserts: reconcile + `initCsConfig()` refresh when anything changed, fail-soft.
- **`customer-service/lib/tools/reloadProducts.js`** — handler re-runs `initCsConfig()` after `loadProducts()`.

## Remaining steps

1. **Test** — new `customer-service/test/csConfigStatus.test.js` for the pure diff (activate on ACTIVE, stay draft on DRAFT, deactivate on missing/non-ACTIVE product, no-op when in sync). Run full suite: `node --test customer-service/test/*.test.js`.
2. **Activate the Evey now** — run the reconcile once from the worktree (`node -e` or small script calling `syncCsConfigStatus`); verify `get_cs_product_config` RPC now returns the Evey. (This replaces the manual row edit the permission classifier blocked earlier.)
3. **Restart local dashboard** — kill port 3847, relaunch from the main checkout in background; confirm startup log shows the config count including Evey (25 active products).
4. **Ship** — commit in worktree with memory delta bundled (one-line Key Decision in `domain_inventory_catalog.md`: config status auto-tracks Shopify product status; supersedes manual flips), rebase on `origin/main`, re-run tests, `git push origin HEAD:main`, remove worktree. Railway auto-deploys webhook server from main — verify redeploy.
5. **Close the loop on the ticket** — Jamie regens the draft on ticket #110051613; advisor should now resolve "Evey" and stage the Mia L → Evey M exchange (Evey is pre-order, mid-August — the draft should reflect that).

## Verification

- Unit: new test file + full suite green.
- Live: RPC returns Evey row; dashboard startup log count; regen the ticket draft and see "Evey" resolved with pre-order context.
- Deploy: `origin/main` updated; Railway webhook service redeployed (check /health or deploy dashboard).
