const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeFulfillments } = require('../lib/tracking/refreshDelivery');

// Raw Shopify GraphQL fulfillment shape (trackingInfo is an array; events nested
// under edges/node) — what getOrderByNumber / fetchOrdersForSync return.
const shopFul = (over = {}) => ({
  status: 'SUCCESS',
  displayStatus: 'IN_TRANSIT',
  createdAt: '2026-06-08T16:27:00Z',
  deliveredAt: null,
  inTransitAt: null,
  estimatedDeliveryAt: null,
  trackingInfo: [{ number: 'TN1', url: 'https://track/TN1', company: 'USPS' }],
  location: { legacyResourceId: 'L1' },
  events: { edges: [] },
  ...over,
});
const ev = (status, happenedAt, message = '') => ({ node: { status, happenedAt, message } });

test('normalizeFulfillments: live DELIVERED replaces stale stored events and sets deliveredAt (the #31296 bug)', () => {
  const existing = [{
    trackingNumber: 'TN1', deliveredAt: null,
    events: [{ status: 'IN_TRANSIT', happenedAt: '2026-06-10T16:00:00Z', message: 'In Transit to Next Facility' }],
  }];
  const shopify = [shopFul({
    deliveredAt: '2026-06-12T18:13:00Z', displayStatus: 'DELIVERED',
    events: { edges: [
      ev('DELIVERED', '2026-06-12T18:13:00Z', 'Delivered, In/At Mailbox'),
      ev('IN_TRANSIT', '2026-06-10T16:00:00Z', 'In Transit to Next Facility'),
    ] },
  })];
  const [f] = normalizeFulfillments(shopify, existing);
  assert.equal(f.deliveredAt, '2026-06-12T18:13:00Z');
  assert.ok(f.events.some(e => e.status === 'DELIVERED'));
  assert.equal(f.trackingNumber, 'TN1');
  assert.equal(f.trackingCompany, 'USPS');
});

test('normalizeFulfillments: preserves stored scraper-only events Shopify never saw', () => {
  const existing = [{
    trackingNumber: 'TN1',
    events: [{ status: 'IN_TRANSIT', happenedAt: '2026-06-11T00:00:00Z', message: 'Local courier scan' }],
  }];
  const shopify = [shopFul({ events: { edges: [ev('IN_TRANSIT', '2026-06-10T16:00:00Z', 'Departed')] } })];
  const [f] = normalizeFulfillments(shopify, existing);
  const ts = f.events.map(e => e.happenedAt);
  assert.ok(ts.includes('2026-06-10T16:00:00Z'), 'keeps Shopify base event');
  assert.ok(ts.includes('2026-06-11T00:00:00Z'), 'preserves scraper extra');
});

test('normalizeFulfillments: preserves Passport extras and keeps stored events when Shopify has none', () => {
  const existing = [{
    trackingNumber: 'TN1', deliveredAt: '2026-06-09T00:00:00Z',
    lastLocation: 'Los Angeles', localCarrier: 'Passport', customsCleared: true,
    events: [{ status: 'IN_TRANSIT', happenedAt: '2026-06-08T00:00:00Z', message: 'x' }],
  }];
  const shopify = [shopFul({ deliveredAt: null, events: { edges: [] } })];
  const [f] = normalizeFulfillments(shopify, existing);
  assert.equal(f.deliveredAt, '2026-06-09T00:00:00Z', 'falls back to stored deliveredAt');
  assert.equal(f.lastLocation, 'Los Angeles');
  assert.equal(f.localCarrier, 'Passport');
  assert.equal(f.customsCleared, true);
  assert.equal(f.events.length, 1, 'keeps stored events when Shopify returns none');
});

test('normalizeFulfillments: preserves stored locationId when the live fetch omits location', () => {
  const existing = [{ trackingNumber: 'TN1', locationId: 'L9', events: [{ status: 'IN_TRANSIT', happenedAt: '2026-06-10T00:00:00Z' }] }];
  const shopify = [shopFul({ location: undefined, events: { edges: [ev('IN_TRANSIT', '2026-06-10T00:00:00Z')] } })];
  const [f] = normalizeFulfillments(shopify, existing);
  assert.equal(f.locationId, 'L9');
});

test('normalizeFulfillments: empty/missing input → empty array', () => {
  assert.deepEqual(normalizeFulfillments(null, []), []);
  assert.deepEqual(normalizeFulfillments([], []), []);
  assert.deepEqual(normalizeFulfillments(undefined), []);
});
