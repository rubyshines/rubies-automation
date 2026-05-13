const test = require('node:test');
const assert = require('node:assert');

const { partitionClaimsByDelivery } = require('../lib/shippingDelays');

test('flips claim when matching fulfillment has deliveredAt', () => {
  const claims = [{ order_number: 1, tracking_number: 'TRACK1' }];
  const orders = {
    1: { order_number: 1, fulfillments: [{ trackingNumber: 'TRACK1', deliveredAt: '2026-04-15T12:00:00Z' }] },
  };
  const { delivered, stillOpen } = partitionClaimsByDelivery(claims, orders);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].claim.order_number, 1);
  assert.equal(delivered[0].deliveredAt, '2026-04-15T12:00:00Z');
  assert.equal(stillOpen.length, 0);
});

test('keeps claim open when no fulfillment matches the tracking number', () => {
  const claims = [{ order_number: 2, tracking_number: 'TRACK_MISSING' }];
  const orders = {
    2: { order_number: 2, fulfillments: [{ trackingNumber: 'TRACK_OTHER', deliveredAt: '2026-04-15T12:00:00Z' }] },
  };
  const { delivered, stillOpen } = partitionClaimsByDelivery(claims, orders);
  assert.equal(delivered.length, 0);
  assert.equal(stillOpen.length, 1);
  assert.equal(stillOpen[0].order_number, 2);
});

test('keeps claim open when matching fulfillment has no deliveredAt', () => {
  const claims = [{ order_number: 3, tracking_number: 'TRACK3' }];
  const orders = {
    3: { order_number: 3, fulfillments: [{ trackingNumber: 'TRACK3' }] },
  };
  const { delivered, stillOpen } = partitionClaimsByDelivery(claims, orders);
  assert.equal(delivered.length, 0);
  assert.equal(stillOpen.length, 1);
});

test('keeps claim open when order is missing from map', () => {
  const claims = [{ order_number: 4, tracking_number: 'TRACK4' }];
  const { delivered, stillOpen } = partitionClaimsByDelivery(claims, {});
  assert.equal(delivered.length, 0);
  assert.equal(stillOpen.length, 1);
});

test('partitions a mixed set correctly', () => {
  const claims = [
    { order_number: 1, tracking_number: 'A' },
    { order_number: 2, tracking_number: 'B' },
    { order_number: 3, tracking_number: 'C' },
  ];
  const orders = {
    1: { order_number: 1, fulfillments: [{ trackingNumber: 'A', deliveredAt: '2026-04-09T00:00:00Z' }] },
    2: { order_number: 2, fulfillments: [{ trackingNumber: 'B' }] },
    3: { order_number: 3, fulfillments: [{ trackingNumber: 'C', deliveredAt: '2026-04-14T00:00:00Z' }] },
  };
  const { delivered, stillOpen } = partitionClaimsByDelivery(claims, orders);
  assert.deepEqual(delivered.map(d => d.claim.order_number).sort(), [1, 3]);
  assert.deepEqual(stillOpen.map(c => c.order_number), [2]);
});

test('does not match a delivered fulfillment with a different tracking number (split shipment guard)', () => {
  const claims = [{ order_number: 5, tracking_number: 'NEW_TRACK' }];
  const orders = {
    5: {
      order_number: 5,
      fulfillments: [
        { trackingNumber: 'OLD_TRACK', deliveredAt: '2026-04-01T00:00:00Z' },
        { trackingNumber: 'NEW_TRACK' },
      ],
    },
  };
  const { delivered, stillOpen } = partitionClaimsByDelivery(claims, orders);
  assert.equal(delivered.length, 0);
  assert.equal(stillOpen.length, 1);
});
