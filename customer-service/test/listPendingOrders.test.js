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
const { _bucketPendingOrders: bucket, _buildOrphanRows: buildOrphanRows } = require('../lib/tools/orderNotes');

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

describe('buildOrphanRows — fulfilled orders with unresolved operator notes', () => {
  function note(orderNumber, opts = {}) {
    return {
      order_number: orderNumber,
      note: opts.note || 'Waiting on customer',
      author: opts.author || 'operator',
      resolved: opts.resolved ?? false,
      created_at: opts.created_at || '2026-06-02T10:00:00Z',
    };
  }

  it('includes a fulfilled order with an unresolved operator note', () => {
    const rows = buildOrphanRows([note(29270)], new Set());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].order.order_number, 29270);
    assert.equal(rows[0].note.note, 'Waiting on customer');
  });

  it('excludes orders already in the unfulfilled set', () => {
    const rows = buildOrphanRows([note(29270)], new Set([29270]));
    assert.equal(rows.length, 0);
  });

  it('excludes auto-authored notes', () => {
    const rows = buildOrphanRows([note(29270, { author: 'auto' })], new Set());
    assert.equal(rows.length, 0);
  });

  it('excludes resolved notes', () => {
    const rows = buildOrphanRows([note(29270, { resolved: true })], new Set());
    assert.equal(rows.length, 0);
  });

  it('deduplicates to the first (latest) note per order when multiple notes exist', () => {
    const notes = [
      note(29270, { note: 'Latest note', created_at: '2026-06-02T12:00:00Z' }),
      note(29270, { note: 'Earlier note', created_at: '2026-06-01T09:00:00Z' }),
    ];
    const rows = buildOrphanRows(notes, new Set());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note.note, 'Latest note');
  });

  it('returns multiple rows for distinct orders', () => {
    const rows = buildOrphanRows([note(29270), note(30872)], new Set());
    assert.equal(rows.length, 2);
  });

  it('excludes an order whose latest note is resolved, even if an older note is unresolved', () => {
    const notes = [
      note(30883, { note: 'Conversation closed — auto-resolved', author: 'auto', resolved: true, created_at: '2026-06-10T14:00:00Z' }),
      note(30883, { note: 'Passport shipment mishandled — outreach drafted', created_at: '2026-06-02T10:00:00Z' }),
    ];
    const rows = buildOrphanRows(notes, new Set());
    assert.equal(rows.length, 0);
  });

  it('excludes an order whose latest note is auto-authored, even if an older operator note is unresolved', () => {
    const notes = [
      note(29270, { note: '[auto-draft] outreach pending', author: 'auto', created_at: '2026-06-10T14:00:00Z' }),
      note(29270, { note: 'Waiting on customer', created_at: '2026-06-02T10:00:00Z' }),
    ];
    const rows = buildOrphanRows(notes, new Set());
    assert.equal(rows.length, 0);
  });

  it('synthetic row has the expected shape for unfulfilledRow rendering', () => {
    const rows = buildOrphanRows([note(29270)], new Set());
    const r = rows[0];
    assert.ok(r.order);
    assert.equal(r.order.order_number, 29270);
    assert.deepEqual(r.order.order_line_items, []);
    assert.equal(r.isPreOrder, false);
    assert.equal(r.classification.reason, 'waiting');
  });
});
