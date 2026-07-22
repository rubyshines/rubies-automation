/**
 * Unit tests for lib/holdReconcile.js — classifyHoldResult, the pure decision
 * that drives the warehouse-hold backstop sweep.
 *
 * Run: node --test customer-service/test/holdReconcile.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyHoldResult, hasHoldActivity, holdTargetOrderNumber } = require('../lib/holdReconcile');

// Mirror the real shapes returned by handleWarehouseHold (orderNotes.js).
const ok = (text) => ({ content: [{ type: 'text', text }] });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

describe('classifyHoldResult', () => {
  it("treats a freshly placed hold as 'placed'", () => {
    assert.equal(classifyHoldResult(ok('**Warehouse hold placed** on order #31552')), 'placed');
  });

  it("treats an already-held order as 'placed' (idempotent success, no isError)", () => {
    assert.equal(classifyHoldResult(ok('Order #31552 already has a **warehouse hold**.')), 'placed');
  });

  it("treats 'not found in Warehance' as 'pending' (order not ingested yet)", () => {
    assert.equal(classifyHoldResult(err('Order #31552 not found in Warehance.')), 'pending');
  });

  it("treats a failed Warehance lookup as 'pending' (transient — retry)", () => {
    assert.equal(classifyHoldResult(err('Failed to look up order in Warehance: 503')), 'pending');
  });

  it("treats an in-progress order as 'impossible' (being picked/packed)", () => {
    assert.equal(
      classifyHoldResult(err('Cannot place warehouse hold — order #31552 is already in progress')),
      'impossible',
    );
  });

  it("treats shipped/fulfilled as 'impossible'", () => {
    assert.equal(classifyHoldResult(err('order already shipped')), 'impossible');
    assert.equal(classifyHoldResult(err('order is fulfilled')), 'impossible');
  });

  it("treats cancelled as 'impossible'", () => {
    assert.equal(classifyHoldResult(err('order was cancelled')), 'impossible');
  });

  it("defaults an unknown error to 'pending' rather than giving up", () => {
    assert.equal(classifyHoldResult(err('something weird happened')), 'pending');
  });

  it("treats a malformed/empty result as 'placed' only when there is no error flag", () => {
    // No isError → success path; matches handleWarehouseHold's contract.
    assert.equal(classifyHoldResult({ content: [] }), 'placed');
    // Error with no text → unknown → pending (safe retry).
    assert.equal(classifyHoldResult({ isError: true, content: [] }), 'pending');
  });
});

// hasHoldActivity is the sweep's done-marker for cancellation drafts (where
// action_executed_at tracks the cancel, not the hold) and its respect-the-
// operator guard (a released hold means a human decided — never re-place).
describe('hasHoldActivity', () => {
  it('is false for an empty or missing timeline', () => {
    assert.equal(hasHoldActivity([]), false);
    assert.equal(hasHoldActivity(null), false);
    assert.equal(hasHoldActivity(undefined), false);
  });

  it('sees a placed hold', () => {
    assert.equal(hasHoldActivity([{ action_type: 'warehouse_hold', summary: 'hold placed' }]), true);
  });

  it('sees an operator release (must not re-place after a deliberate release)', () => {
    assert.equal(
      hasHoldActivity([
        { action_type: 'warehouse_hold', summary: 'hold placed' },
        { action_type: 'release_warehouse_hold', summary: 'released' },
      ]),
      true,
    );
  });

  it('ignores unrelated actions', () => {
    assert.equal(hasHoldActivity([{ action_type: 'refund', summary: 'refunded' }, {}]), false);
  });
});

// holdTargetOrderNumber picks which order a proposed hold lands on. Shared by
// the backstop sweep (draft rows) and the intake auto-hold (live structured
// output, passed as { structured_output, order_number }). The draft's
// order_number echoes the LOADED order context, which is wrong when an
// operator steer redirected the action — ticket 2700 held the loaded #31533
// (already shipped) instead of the steered #31485.
describe('holdTargetOrderNumber', () => {
  it('prefers the advisor-declared action target over the linked order', () => {
    assert.equal(
      holdTargetOrderNumber({
        order_number: '#31533',
        structured_output: { action_order_number: '31485' },
      }),
      31485,
    );
  });

  it('falls back to the linked order when no action target was declared', () => {
    assert.equal(holdTargetOrderNumber({ order_number: '#31533', structured_output: {} }), 31533);
    assert.equal(holdTargetOrderNumber({ order_number: '31533' }), 31533);
    assert.equal(holdTargetOrderNumber({ order_number: '#31533', structured_output: { action_order_number: null } }), 31533);
  });

  it('strips a leading # from the action target', () => {
    assert.equal(
      holdTargetOrderNumber({ order_number: '#31533', structured_output: { action_order_number: '#31485' } }),
      31485,
    );
  });

  it('returns null when nothing resolves to a number', () => {
    assert.equal(holdTargetOrderNumber({}), null);
    assert.equal(holdTargetOrderNumber({ order_number: null, structured_output: {} }), null);
    assert.equal(holdTargetOrderNumber({ order_number: 'D6720' }), null);
    assert.equal(holdTargetOrderNumber(null), null);
  });
});
