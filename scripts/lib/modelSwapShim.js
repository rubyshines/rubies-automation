/**
 * Preload shim for modelSwapEval — injected into each scenario child process
 * via NODE_OPTIONS=--require.
 *
 * Overrides MODELS.OPUS for that process only, by mutating the object
 * shared/aiPricing exports (it is exported by reference, and this preload runs
 * before the scenario requires aiAdvisor, so every downstream MODELS.OPUS read
 * sees the override).
 *
 * WHY A SHIM AND NOT AN ENV VAR READ INSIDE aiPricing.js:
 * this repo has been bitten twice by env-var model/eval toggles leaking into
 * production (the shadow eval ran for weeks unnoticed on the webhook + cron
 * services because the disable var never propagated — see
 * project_cs_efficiency.md). Keeping the override in an eval-only preload means
 * a stray env var in a production runtime cannot change which model serves
 * customers: nothing in the production code path reads MODEL_SWAP_EVAL_MODEL.
 */
const path = require('path');

const override = process.env.MODEL_SWAP_EVAL_MODEL;
if (override) {
  const pricing = require(path.resolve(__dirname, '../../shared/aiPricing'));
  pricing.MODELS.OPUS = override;
}
