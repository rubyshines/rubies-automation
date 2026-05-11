/**
 * Unit tests for consolidateOrders.planShippingRefunds — pure helper that
 * decides whether the consolidated subtotal qualifies for free shipping.
 *
 * Run: node --test customer-service/test/consolidateOrders.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planShippingRefunds } = require('../lib/tools/consolidateOrders');

describe('planShippingRefunds', () => {
  it('refunds shipping when combined subtotal meets threshold', () => {
    const r = planShippingRefunds({ keeperSubtotal: 60, dropSubtotal: 50, threshold: 99, keeperShipping: 9, dropShipping: 9 });
    assert.equal(r.refundShipping, true);
    assert.equal(r.combined, 110);
    assert.match(r.reason, />= free-shipping threshold/);
  });

  it('refunds shipping when combined exactly meets threshold', () => {
    const r = planShippingRefunds({ keeperSubtotal: 49.50, dropSubtotal: 49.50, threshold: 99, keeperShipping: 9, dropShipping: 9 });
    assert.equal(r.refundShipping, true);
  });

  it('does not refund when combined is below threshold', () => {
    const r = planShippingRefunds({ keeperSubtotal: 40, dropSubtotal: 40, threshold: 99, keeperShipping: 9, dropShipping: 9 });
    assert.equal(r.refundShipping, false);
    assert.match(r.reason, /below free-shipping threshold/);
  });

  it('does not refund when threshold is null (no free option for destination)', () => {
    const r = planShippingRefunds({ keeperSubtotal: 1000, dropSubtotal: 1000, threshold: null, keeperShipping: 50, dropShipping: 50 });
    assert.equal(r.refundShipping, false);
    assert.match(r.reason, /no free-shipping threshold/);
  });

  it('does not refund when threshold is 0 (treated as no eligibility — already universally free)', () => {
    // threshold == 0 means the zone gives free shipping at any cart value, so
    // there was no shipping fee to refund anyway. Don't claim "qualifies".
    const r = planShippingRefunds({ keeperSubtotal: 100, dropSubtotal: 100, threshold: 0, keeperShipping: 0, dropShipping: 0 });
    assert.equal(r.refundShipping, false);
    assert.match(r.reason, /no free-shipping threshold/);
  });

  it('flags whether each order actually has shipping to refund when qualifying', () => {
    const r = planShippingRefunds({ keeperSubtotal: 99, dropSubtotal: 1, threshold: 99, keeperShipping: 0, dropShipping: 9 });
    assert.equal(r.refundShipping, true);
    assert.equal(r.keeperHasShipping, false);
    assert.equal(r.dropHasShipping, true);
  });

  it('handles string-numeric inputs (Shopify amounts come as strings)', () => {
    const r = planShippingRefunds({ keeperSubtotal: '60.00', dropSubtotal: '50.00', threshold: '99.00', keeperShipping: '9.00', dropShipping: '9.00' });
    assert.equal(r.refundShipping, true);
  });
});
