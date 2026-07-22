/**
 * apologyFlag (aiAdvisor) — deterministic apology guardrail.
 *
 * 2026-07 verbosity regression: prompt-level "sorry is reserved for
 * RUBIES-caused problems" rules drift in production even while pinned
 * scenarios stay green (drafts 2727 fit-apology, 2653 third-party-apology).
 * The guardrail flags ANY apology-containing draft into prescription.flags
 * (the dashboard ⚠️ banner) so the operator checks fault before sending.
 * Flag only — never strips.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { apologyFlag } = require('../lib/aiAdvisor');

test('flags "sorry" anywhere in the draft', () => {
  const flag = apologyFlag('Hi,\n\nSorry for the wait! Your order ships tomorrow.');
  assert.ok(flag, 'expected a flag');
  assert.match(flag, /apologizes/i);
});

test('flags apologize/apologies variants', () => {
  assert.ok(apologyFlag('We apologize for the mix-up.'));
  assert.ok(apologyFlag('My apologies, the size 14 is out of stock.'));
  assert.ok(apologyFlag('I am so sorry, it looks like I never created your order.'));
});

test('is case-insensitive', () => {
  assert.ok(apologyFlag('SORRY about that.'));
  assert.ok(apologyFlag('Apologies for the confusion.'));
});

test('does not flag apology-free drafts', () => {
  assert.strictEqual(apologyFlag('Hi,\n\nNo problem, we can exchange those for a medium. It\'ll ship tomorrow.'), null);
  assert.strictEqual(apologyFlag('Thanks for letting us know, let\'s get you into a size that works.'), null);
});

test('word boundary: does not flag words merely containing "sorry" letters', () => {
  // \bsorry\b should not match inside other words; "sorry" as substring of a
  // larger word is not an apology (contrived, but pins the boundary).
  assert.strictEqual(apologyFlag('The accessorying options are limited.'), null);
});

test('handles null/undefined/empty input', () => {
  assert.strictEqual(apologyFlag(null), null);
  assert.strictEqual(apologyFlag(undefined), null);
  assert.strictEqual(apologyFlag(''), null);
});
