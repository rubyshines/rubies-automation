/**
 * Preload shim for promptSwapEval — injected into each scenario child process
 * via NODE_OPTIONS=--require.
 *
 * Arms a prompt variant for that process only, before the scenario requires
 * aiAdvisor. Node caches modules, so the transform this sets is the one the
 * scenario's own `require('../../lib/aiAdvisor')` gets.
 *
 * Same reasoning as modelSwapShim: this is an eval-only preload, deliberately
 * NOT an env var read inside aiAdvisor. A stray variable in a production
 * runtime must not be able to change the prompt that serves customers — this
 * repo has twice had eval toggles leak into production, and a silently
 * different prompt is far harder to notice than a silently different model.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const variant = process.env.PROMPT_VARIANT_EVAL;
if (variant && variant !== 'control') {
  const { setPromptTransform } = require(path.resolve(__dirname, '../../customer-service/lib/aiAdvisor'));
  const { apply } = require(path.resolve(__dirname, '../promptVariants'));
  setPromptTransform(apply(variant));
}
