/**
 * aiPricing.js — pricing source of truth for all AI calls.
 *
 * Per-million-token rates in USD, keyed by EXACT model_id so that historical
 * rows always resolve to the rate that applied at the time of the call, even
 * after a newer model version ships (claude-opus-4-8 never overwrites the
 * claude-opus-4-6 rate).
 *
 * Last verified against https://www.anthropic.com/pricing on 2026-05-28.
 *
 * When a new model ships, add an entry here. A monthly drift detector
 * (scripts/check-ai-pricing.js) compares these constants to the live
 * pricing page and surfaces changes in the daily summary.
 */

/**
 * Canonical model IDs for each tier. All call sites should import and use
 * these instead of hardcoding model strings, so a tier upgrade is a one-line
 * change here rather than a grep-and-replace across the codebase.
 */
const MODELS = {
  OPUS:   'claude-opus-4-8',
  SONNET: 'claude-sonnet-4-6',
  HAIKU:  'claude-haiku-4-5-20251001',
};

// Per-million-token rates. `cost_usd` below converts these to per-token.
// Legacy entries kept so historical ai_calls rows still compute correct cost.
const RATES = {
  'claude-opus-4-8':           { input: 15,   output: 75,  cache_read: 1.5,  cache_create: 18.75 },
  'claude-opus-4-7':           { input: 15,   output: 75,  cache_read: 1.5,  cache_create: 18.75 }, // legacy
  'claude-opus-4-6':           { input: 15,   output: 75,  cache_read: 1.5,  cache_create: 18.75 }, // legacy
  'claude-sonnet-4-6':         { input: 3,    output: 15,  cache_read: 0.3,  cache_create: 3.75 },
  'claude-sonnet-4-20250514':  { input: 3,    output: 15,  cache_read: 0.3,  cache_create: 3.75 }, // legacy alias
  'claude-haiku-4-5-20251001': { input: 1,    output: 5,   cache_read: 0.1,  cache_create: 1.25 },
  'claude-haiku-4-5':          { input: 1,    output: 5,   cache_read: 0.1,  cache_create: 1.25 }, // legacy alias
  'voyage-3-lite':             { input: 0.02, output: 0 },
  'voyage-3':                  { input: 0.06, output: 0 },
};

const PER_MILLION = 1_000_000;

/**
 * Compute the USD cost of a single call.
 *
 * @param {string} modelId   exact model id as sent to the provider
 * @param {object} usage     { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }
 * @returns {number}         cost in USD (0 if the model is unknown — never throws)
 */
function computeCost(modelId, usage = {}) {
  const rate = RATES[modelId];
  if (!rate) return 0; // unknown model — don't throw in a tracking path

  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_tokens || 0;
  const cacheCreate = usage.cache_creation_tokens || 0;

  const cost =
    (input * (rate.input || 0)) / PER_MILLION +
    (output * (rate.output || 0)) / PER_MILLION +
    (cacheRead * (rate.cache_read || 0)) / PER_MILLION +
    (cacheCreate * (rate.cache_create || 0)) / PER_MILLION;

  // Round to 6 decimal places to match the NUMERIC(10,6) column.
  return Math.round(cost * 1e6) / 1e6;
}

module.exports = { MODELS, RATES, computeCost };
