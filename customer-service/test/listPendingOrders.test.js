/**
 * Unit tests for the bucket+filter logic behind list_pending_orders.
 *
 * Exercises the pure _bucketPendingOrders helper against synthetic
 * unfulfilled-result shapes. No Supabase required.
 *
 * Run: node --test customer-service/test/listPendingOrders.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _bucketPendingOrders: bucket } = require('../lib/tools/orderNotes');

// Synthetic builder — minimal shape that mirrors what checkUnfulfilledOrders returns
function row({
  orderNumber,
  isPreOrder = false,
  note = null,           // { note, resolved, author } or null
  severity = 'normal',
  detail = null,
  businessDays = 1,
} = {}) {
  return {
    order: { order_number: orderNumber, customer_email: 'x@x.com', created_at: '2026-04-01T00:00:00Z' },
    isPreOrder,
    note,
    classification: { severity, detail },
    businessDays,
  };
}

describe('bucketPendingOrders — basic bucketing', () => {
  it('routes a plain pre-order with no note to pre_orders', () => {
    const r = row({ orderNumber: 1, isPreOrder: true });
    const out = bucket({ results: [r] });
    assert.equal(out.pre_orders.length, 1);
    assert.equal(out.urgent.length, 0);
    assert.equal(out.waiting_on_response.length, 0);
  });

  it('routes urgent classification to urgent', () => {
    const r = row({ orderNumber: 2, severity: 'urgent' });
    const out = bucket({ results: [r] });
    assert.equal(out.urgent.length, 1);
    assert.equal(out.attention.length, 0);
  });

  it('routes attention classification to attention', () => {
    const r = row({ orderNumber: 3, severity: 'attention' });
    const out = bucket({ results: [r] });
    assert.equal(out.attention.length, 1);
  });

  it('routes normal classification to normal', () => {
    const r = row({ orderNumber: 4, severity: 'normal' });
    const out = bucket({ results: [r] });
    assert.equal(out.normal.length, 1);
  });

  it('routes auto_resolved severity to auto_resolved', () => {
    const r = row({ orderNumber: 5, severity: 'auto_resolved' });
    const out = bucket({ results: [r] });
    assert.equal(out.auto_resolved.length, 1);
    assert.equal(out.normal.length, 0);
  });
});

describe('bucketPendingOrders — note + isPreOrder precedence (mirrors daily report)', () => {
  it('an unresolved operator note pulls a pre-order out of pre_orders into waiting_on_response', () => {
    const r = row({
      orderNumber: 100,
      isPreOrder: true,
      note: { note: 'Naomi outreach sent', resolved: false, author: 'jamie' },
      severity: 'normal',
    });
    const out = bucket({ results: [r] });
    assert.equal(out.pre_orders.length, 0, 'should not be in pre_orders');
    assert.equal(out.waiting_on_response.length, 1, 'should be in waiting_on_response');
  });

  it('an auto-authored note does NOT make a pre-order surface as waiting_on_response', () => {
    const r = row({
      orderNumber: 101,
      isPreOrder: true,
      note: { note: 'Auto resolved', resolved: false, author: 'auto' },
      severity: 'normal',
    });
    const out = bucket({ results: [r] });
    // Note is unresolved + auto-authored → falls into ufNoNote bucketing → severity=normal
    assert.equal(out.waiting_on_response.length, 0);
    assert.equal(out.normal.length, 1);
  });

  it('a resolved note on a pre-order does not appear in any actionable bucket', () => {
    const r = row({
      orderNumber: 102,
      isPreOrder: true,
      note: { note: 'Done', resolved: true, author: 'jamie' },
      severity: 'normal',
    });
    const out = bucket({ results: [r] });
    assert.equal(out.pre_orders.length, 0);
    assert.equal(out.waiting_on_response.length, 0);
    assert.equal(out.urgent.length, 0);
  });
});

describe('bucketPendingOrders — bucket arg filter', () => {
  const data = {
    results: [
      row({ orderNumber: 1, severity: 'urgent' }),
      row({ orderNumber: 2, severity: 'attention' }),
      row({ orderNumber: 3, isPreOrder: true }),
      row({ orderNumber: 4, note: { note: 'wait', resolved: false, author: 'jamie' }, severity: 'normal' }),
    ],
  };

  it('returns only the requested bucket when arg supplied', () => {
    const out = bucket(data, { bucket: 'urgent' });
    assert.deepEqual(Object.keys(out), ['urgent']);
    assert.equal(out.urgent.length, 1);
  });

  it('throws on unknown bucket name', () => {
    assert.throws(() => bucket(data, { bucket: 'nonsense' }), /Unknown bucket/);
  });
});

describe('bucketPendingOrders — minBusinessDays filter', () => {
  const data = {
    results: [
      row({ orderNumber: 1, severity: 'urgent', businessDays: 1 }),
      row({ orderNumber: 2, severity: 'urgent', businessDays: 7 }),
      row({ orderNumber: 3, severity: 'attention', businessDays: 3 }),
    ],
  };

  it('filters out orders below the minimum business-day threshold', () => {
    const out = bucket(data, { minBusinessDays: 5 });
    assert.equal(out.urgent.length, 1);
    assert.equal(out.urgent[0].order.order_number, 2);
    assert.equal(out.attention.length, 0);
  });

  it('combines bucket and minBusinessDays filters', () => {
    const out = bucket(data, { bucket: 'urgent', minBusinessDays: 5 });
    assert.deepEqual(Object.keys(out), ['urgent']);
    assert.equal(out.urgent.length, 1);
  });
});

describe('bucketPendingOrders — empty + edge cases', () => {
  it('returns all empty buckets when input is empty', () => {
    const out = bucket({ results: [] });
    for (const b of Object.keys(out)) assert.equal(out[b].length, 0);
  });

  it('handles missing unfulfilledResult gracefully', () => {
    const out = bucket(undefined);
    for (const b of Object.keys(out)) assert.equal(out[b].length, 0);
  });
});
