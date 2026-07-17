/**
 * Unit tests for lib/holdReconcile.js — classifyHoldResult, the pure decision
 * that drives the warehouse-hold backstop sweep.
 *
 * Run: node --test customer-service/test/holdReconcile.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyHoldResult, hasHoldActivity } = require('../lib/holdReconcile');

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
