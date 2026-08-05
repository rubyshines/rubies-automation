/**
 * Multi-shipment receiving: transfer-number allocation + hand-entered item normalization.
 *
 * An order routinely ships in more than one consignment (ocean container + a courier
 * parcel, or a held batch following later). Before this, every shipment defaulted to the
 * bare production_code, which collides on the UNIQUE index and overwrites shipment 1.
 */

const test = require('node:test');
const assert = require('node:assert');

const { nextTransferNumber, normalizeShipmentItems } = require('../lib/merchandising/inboundReceiving');

test('nextTransferNumber: the first shipment keeps the bare production code', () => {
  assert.strictEqual(nextTransferNumber('KALI-2601', []), 'KALI-2601');
});

test('nextTransferNumber: a second shipment gets -2 rather than colliding', () => {
  assert.strictEqual(nextTransferNumber('KALI-2601', ['KALI-2601']), 'KALI-2601-2');
});

test('nextTransferNumber: keeps counting past existing suffixes', () => {
  assert.strictEqual(nextTransferNumber('KALI-2601', ['KALI-2601', 'KALI-2601-2']), 'KALI-2601-3');
  assert.strictEqual(nextTransferNumber('KALI-2601', ['KALI-2601', 'KALI-2601-2', 'KALI-2601-3']), 'KALI-2601-4');
});

test('nextTransferNumber: never renames shipment 1, so its live Warehance reference stays valid', () => {
  // Given shipment 1 is already an ASN under the bare code, allocating #2 must not
  // suggest renaming it — the returned value is only ever the NEW shipment's number.
  const existing = ['KALI-2601'];
  const next = nextTransferNumber('KALI-2601', existing);
  assert.notStrictEqual(next, 'KALI-2601');
  assert.deepStrictEqual(existing, ['KALI-2601']);
});

test('nextTransferNumber: matching is case-insensitive', () => {
  assert.strictEqual(nextTransferNumber('KALI-2601', ['kali-2601']), 'KALI-2601-2');
});

test('nextTransferNumber: requires a base code', () => {
  assert.throws(() => nextTransferNumber(null, []), /baseCode is required/);
  assert.throws(() => nextTransferNumber('', []), /baseCode is required/);
});

test('normalizeShipmentItems: trims, upper-cases, and coerces string quantities', () => {
  assert.deepStrictEqual(
    normalizeShipmentItems([{ sku: ' mpad-snd-s ', qty: '100' }]),
    [{ sku: 'MPAD-SND-S', qty: 100 }],
  );
});

test('normalizeShipmentItems: merges duplicate SKUs instead of letting the upsert drop one', () => {
  // Two lines of the same SKU would otherwise collide on (shipment, sku) and the second
  // would silently overwrite the first, losing units.
  assert.deepStrictEqual(
    normalizeShipmentItems([{ sku: 'MPAD-SND-M', qty: 120 }, { sku: 'MPAD-SND-M', qty: 80 }]),
    [{ sku: 'MPAD-SND-M', qty: 200 }],
  );
});

test('normalizeShipmentItems: drops blank SKUs and non-positive or unparseable quantities', () => {
  assert.deepStrictEqual(
    normalizeShipmentItems([
      { sku: 'MPAD-SND-L', qty: 100 },
      { sku: '', qty: 50 },
      { sku: 'MPAD-SND-S', qty: 0 },
      { sku: 'MPAD-SND-M', qty: -10 },
      { sku: 'MPAD-SND-XL', qty: 'abc' },
    ]),
    [{ sku: 'MPAD-SND-L', qty: 100 }],
  );
});

test('normalizeShipmentItems: tolerates missing, empty, and malformed input', () => {
  assert.deepStrictEqual(normalizeShipmentItems(undefined), []);
  assert.deepStrictEqual(normalizeShipmentItems([]), []);
  assert.deepStrictEqual(normalizeShipmentItems([null, {}]), []);
});
