/**
 * Refresh must never reopen an already-sent OUTBOUND draft.
 *
 * A sent outreach is a record, not a draft. Every regeneration path rewrites
 * draft_response and sets status back to 'pending', which puts an email the
 * customer already has back in the send queue where resending it is one click.
 * Three live rows were reset this way on 2026-08-25.
 *
 * The distinction that makes the guard correct: the INBOUND path deliberately
 * does reset a sent draft to pending, because a customer reply reopens the
 * ticket and there is one draft row per message to reuse. What makes that safe
 * is the reply. An outbound ticket has none.
 *
 * Run: node --test customer-service/test/refreshSentGuard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(
  path.resolve(__dirname, '../dashboard/server.js'),
  'utf8',
);

describe('apiRefreshDraft — sent outbound guard', () => {
  // Static assertion rather than booting the server: apiRefreshDraft reaches
  // Gorgias, Supabase and the advisor, and the branch under test is a few lines
  // of control flow. What must not regress is that the check exists, is inside
  // the no-customer-reply branch, and runs BEFORE any regeneration.
  // Anchor inside apiRefreshDraft specifically. `if (!lastCustomer) {` occurs
  // three times in this file, and slicing from the first one measured
  // buildAdvisorInputFromGorgias instead — a test that passes or fails for
  // reasons unrelated to the guard.
  const fn = SERVER.slice(SERVER.indexOf('async function apiRefreshDraft('));
  const branch = fn.slice(fn.indexOf('if (!lastCustomer) {'));
  const guardIdx = branch.indexOf('draft.sent_at');

  it('refuses to refresh an outbound draft that has already been sent', () => {
    assert.ok(guardIdx > -1, 'no draft.sent_at guard in the no-customer-reply branch');
    assert.match(
      branch.slice(guardIdx, guardIdx + 400),
      /throw new Error\(/,
      'the sent_at check must throw, not fall through',
    );
  });

  it('runs before either regeneration path', () => {
    const templated = branch.indexOf('refreshTemplatedOutreach(');
    const composer = branch.indexOf('recomposeOutboundDraft(');
    assert.ok(templated > -1 && composer > -1, 'expected both regeneration paths in this branch');
    assert.ok(guardIdx < templated, 'guard must precede the templated-outreach path');
    assert.ok(guardIdx < composer, 'guard must precede the outbound composer path');
  });

  it('does not gate the inbound path, where reopening a sent draft is correct', () => {
    // The inbound reset lives after the branch and is deliberate; a guard there
    // would break the customer-replied-after-send flow.
    const afterBranch = SERVER.slice(SERVER.indexOf('// Build context up front'));
    assert.doesNotMatch(
      afterBranch.slice(0, afterBranch.indexOf('async function') > -1 ? afterBranch.indexOf('async function') : 4000),
      /if \(draft\.sent_at\)[\s\S]{0,120}throw/,
      'the inbound path must still be able to reopen a sent draft',
    );
  });
});
