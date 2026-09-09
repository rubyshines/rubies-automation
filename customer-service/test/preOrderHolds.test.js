/**
 * A warehouse hold outranks the pre-order silo and a resolved note.
 *
 * Until 2026-09-09 a pre-order never reached classifyOrder: the report labelled
 * it "Customer informed at purchase" and stopped. An address hold on a pre-order
 * was therefore invisible for the whole stock wait and the auto-resolver never
 * saw it (#33205, 19 days). A resolved note from unrelated finished work hid a
 * live hold the same way (#33220). These tests pin the composition that fixes
 * both and the predicates every reader of the report now shares.
 *
 * Run: node --test customer-service/test/preOrderHolds.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyOrder,
  classifyWithPreOrder,
  HOLD_REASONS,
  isHoldReason,
  inPreOrderSilo,
  isActionable,
  isResolvedRow,
} = require('../../reports/lib/unfulfilled');

const ORDER = { created_at: '2026-08-20T04:58:19Z', order_line_items: [] };

const SILO = { reason: 'pre_order', severity: 'info', detail: 'Customer informed at purchase' };
const HELD = { reason: 'address_hold', severity: 'urgent', detail: 'Address flagged by warehouse' };
const STOCK = { reason: 'awaiting_stock', severity: 'urgent', detail: 'x' };

function row(classification, note = null) {
  return { classification, note, isPreOrder: classification.reason === 'pre_order' };
}

describe('classifyWithPreOrder', () => {
  it('leaves a non-pre-order classification untouched', () => {
    assert.equal(classifyWithPreOrder(false, HELD), HELD);
    assert.equal(classifyWithPreOrder(false, STOCK), STOCK);
  });

  it('a pre-order with no hold keeps the silent silo classification', () => {
    assert.deepEqual(classifyWithPreOrder(true, STOCK), SILO);
    assert.deepEqual(classifyWithPreOrder(true, { reason: 'at_warehouse', severity: 'normal', detail: 'x' }), SILO);
  });

  it('a pre-order the warehouse is holding takes the hold classification, pre-order kept in the detail', () => {
    const out = classifyWithPreOrder(true, HELD);
    assert.equal(out.reason, 'address_hold');
    assert.equal(out.severity, 'urgent');
    assert.equal(out.detail, 'Pre-order · Address flagged by warehouse');
  });

  it('end to end: a 12-business-day pre-order on address hold classifies as an urgent address hold', () => {
    const whOrder = { has_hold: true, address_hold: true, fulfillment_status: 'unfulfilled' };
    const out = classifyWithPreOrder(true, classifyOrder(ORDER, whOrder, null, 12));
    assert.equal(out.reason, 'address_hold');
    assert.equal(out.severity, 'urgent');
  });
});

describe('HOLD_REASONS covers every hold classifyOrder can emit', () => {
  for (const flag of ['address_hold', 'fraud_hold', 'payment_hold', 'warehouse_hold', 'allocation_hold', 'store_hold']) {
    it(`${flag} is a hold reason`, () => {
      const whOrder = { has_hold: true, [flag]: true, fulfillment_status: 'unfulfilled' };
      const out = classifyOrder(ORDER, whOrder, null, 5);
      assert.equal(out.reason, flag);
      assert.ok(isHoldReason(out.reason), `${out.reason} must be in HOLD_REASONS`);
    });
  }

  it('non-hold reasons are not hold reasons', () => {
    for (const reason of ['pre_order', 'awaiting_stock', 'at_warehouse', 'in_progress', 'recently_placed', 'auto_resolved', 'unknown']) {
      assert.equal(isHoldReason(reason), false, reason);
      assert.equal(HOLD_REASONS.has(reason), false, reason);
    }
  });
});

describe('inPreOrderSilo', () => {
  it('a pre-order with no note is in the silo', () => {
    assert.equal(inPreOrderSilo(row(SILO)), true);
  });

  it('an unresolved operator note pulls it out', () => {
    assert.equal(inPreOrderSilo(row(SILO, { note: 'Outreach sent', resolved: false, author: 'operator' })), false);
  });

  it('a shipping-update note does not pull it out', () => {
    const shippingNote = { note: 'Shipping updated to US Expedited Shipping: when in stock', resolved: false, author: 'operator' };
    assert.equal(inPreOrderSilo(row(SILO, shippingNote)), true);
  });

  it('a held pre-order is never in the silo', () => {
    assert.equal(inPreOrderSilo(row(classifyWithPreOrder(true, HELD))), false);
  });
});

describe('isActionable / isResolvedRow', () => {
  it('a hold with a resolved note is still actionable, not resolved', () => {
    const r = row(HELD, { note: 'Conversation closed (ticket #3301) — auto-resolved', resolved: true, author: 'auto' });
    assert.equal(isActionable(r), true);
    assert.equal(isResolvedRow(r), false);
  });

  it('a non-hold with a resolved note is resolved, not actionable', () => {
    const r = row(STOCK, { note: 'Reshipped by hand', resolved: true, author: 'operator' });
    assert.equal(isActionable(r), false);
    assert.equal(isResolvedRow(r), true);
  });

  it('a silo pre-order is neither actionable nor resolved', () => {
    const r = row(SILO);
    assert.equal(isActionable(r), false);
    assert.equal(isResolvedRow(r), false);
  });

  it('a row with no note is actionable', () => {
    assert.equal(isActionable(row(STOCK)), true);
  });
});
