/**
 * Matching Warehance ASN lines back to our SKUs when polling receiving progress.
 *
 * Warehance returns line identifiers nested under `product` ({ product: { id, sku } }).
 * The poller read a flat `ri.sku` / `ri.product_id`, so every line failed to match and
 * per-SKU qty_received never landed — the header total was right while the 3-way
 * reconcile's received column stayed permanently empty (caught on WUMES-2602, which the
 * warehouse had received in full: "425 units across 0/3 matched lines").
 */

const test = require('node:test');
const assert = require('node:assert');

const { matchReceivedLines, isoDate } = require('../lib/merchandising/inboundReceiving');

// The real shape of a Warehance GET /inbound-shipments line.
const warehanceLine = (sku, id, ordered, received) => ({
  id: 231185196348, product: { id, name: `SOMETHING - ${sku}`, sku }, ordered, received, rejected: 0, sell_ahead: 0,
});

test('matches on the nested product.sku Warehance actually returns', () => {
  const { totalReceived, updates } = matchReceivedLines([
    warehanceLine('MPAD-SND-S', 231187626849, 100, 110),
    warehanceLine('MPAD-SND-M', 231187626842, 200, 205),
    warehanceLine('MPAD-SND-L', 231187626852, 100, 110),
  ]);
  assert.strictEqual(totalReceived, 425);
  assert.deepStrictEqual(updates, [
    { sku: 'MPAD-SND-S', received: 110 },
    { sku: 'MPAD-SND-M', received: 205 },
    { sku: 'MPAD-SND-L', received: 110 },
  ]);
});

test('falls back to the catalog product-id map when the line carries no sku', () => {
  const byId = new Map([['231187626849', 'MPAD-SND-S']]);
  const line = warehanceLine('MPAD-SND-S', 231187626849, 100, 110);
  delete line.product.sku;
  const { updates } = matchReceivedLines([line], byId);
  assert.deepStrictEqual(updates, [{ sku: 'MPAD-SND-S', received: 110 }]);
});

test('still reads a flat sku / product_id, in case the API shape changes back', () => {
  const byId = new Map([['777', 'AJ-BLK-M']]);
  assert.deepStrictEqual(matchReceivedLines([{ sku: 'AJ-SND-S', received: 12 }]).updates, [{ sku: 'AJ-SND-S', received: 12 }]);
  assert.deepStrictEqual(matchReceivedLines([{ product_id: 777, received: 5 }], byId).updates, [{ sku: 'AJ-BLK-M', received: 5 }]);
});

test('an unmatchable line counts toward the total but is never guessed onto a SKU', () => {
  const { totalReceived, updates } = matchReceivedLines([
    warehanceLine('MPAD-SND-S', 231187626849, 100, 110),
    { id: 9, product: { id: 999, name: 'not ours' }, ordered: 10, received: 10 },
  ]);
  assert.strictEqual(totalReceived, 120);
  assert.deepStrictEqual(updates, [{ sku: 'MPAD-SND-S', received: 110 }]);
});

test('an untouched ASN reports zero received rather than throwing', () => {
  const { totalReceived, updates } = matchReceivedLines([
    warehanceLine('AJ-SND-12', 231187626594, 56, 0),
    warehanceLine('AJ-SND-M', 231187626804, 166, 0),
  ]);
  assert.strictEqual(totalReceived, 0);
  assert.deepStrictEqual(updates, [{ sku: 'AJ-SND-12', received: 0 }, { sku: 'AJ-SND-M', received: 0 }]);
});

test('handles a missing or empty item list', () => {
  assert.deepStrictEqual(matchReceivedLines(undefined), { totalReceived: 0, updates: [] });
  assert.deepStrictEqual(matchReceivedLines([]), { totalReceived: 0, updates: [] });
});

test('isoDate takes the date off a Warehance timestamp', () => {
  assert.strictEqual(isoDate('2026-08-14T21:46:48.407997Z'), '2026-08-14');
});

test('isoDate rejects the 0001-01-01 Warehance writes for "unset"', () => {
  // Left as a real date it would read as an arrival in the year 1 in both systems.
  assert.strictEqual(isoDate('0001-01-01T00:00:00Z'), null);
  assert.strictEqual(isoDate(null), null);
  assert.strictEqual(isoDate(''), null);
});
