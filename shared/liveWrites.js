'use strict';
/**
 * Is this process the real Railway deployment, or someone's laptop?
 *
 * The code is identical in both, and local development holds production
 * credentials on purpose (`.env` is symlinked into every worktree so a worktree
 * can be tested at all). So possessing credentials is not permission: a service
 * path that reaches outside — minting a Shopify discount code, putting an
 * organisation on the public donation map — has to know which one it is.
 *
 * The check is deliberately shaped as "prove you are production", not "prove
 * you are development". The inverse fails open: a laptop with no marker would
 * write to production, which is exactly how four test discount codes ended up
 * live in the store (revoked 2026-09-21). With this shape an unknown
 * environment refuses, and the cost of being wrong is a skipped write rather
 * than a real one.
 *
 * `RAILWAY_DEPLOYMENT_ID` is injected by Railway into every deployment and is
 * already trusted for exactly this purpose by the webhook server's and the
 * dashboard's /health. `scripts/copy-railway-vars.js` skips the `RAILWAY_`
 * prefix when copying variables between services, so it cannot leak into a
 * local `.env` by accident.
 *
 * NOT for operator tools. The MCP tools (`donation_partner_create`,
 * `donation_partner_publish`, …) are run by hand from Claude Code on a laptop
 * and must keep working there — that is a deliberate person doing their job,
 * not a test fixture leaking. Guard the automatic call path, never the tool.
 *
 * The failure this introduces is silence: if Railway ever stops setting the
 * variable, guarded writes stop forever and everything still looks healthy. So
 * callers must log when they skip, and every service consulting this reports
 * its mode on startup and at /health — see `liveWriteMode()`.
 */

const LIVE_SIGNAL = 'RAILWAY_DEPLOYMENT_ID';

/** True only on a real Railway deployment. */
function isLiveDeployment() {
  return !!process.env[LIVE_SIGNAL];
}

/**
 * Ask whether an outward-facing write may proceed, and say so in the log when
 * it may not. `what` is a short phrase naming the write, e.g.
 * "mint a Shopify discount code".
 */
function allowLiveWrite(what) {
  if (isLiveDeployment()) return true;
  console.warn(`[live-write] SKIPPED: ${what} — not the live deployment (no ${LIVE_SIGNAL}). Nothing was written outside this machine.`);
  return false;
}

/** For startup banners and /health, so "live" is observable rather than assumed. */
function liveWriteMode() {
  return { live: isLiveDeployment(), signal: LIVE_SIGNAL };
}

module.exports = { LIVE_SIGNAL, isLiveDeployment, allowLiveWrite, liveWriteMode };
