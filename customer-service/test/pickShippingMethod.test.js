/**
 * Unit tests for pickShippingMethod (reports/lib/warehanceClient.js) — the
 * single Warehance zone+speed → method routing rule (was duplicated between
 * orderNotes' hardcoded ID tables and editOrder's name matcher).
 *
 * Run: node --test customer-service/test/pickShippingMethod.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { pickShippingMethod } = require('../../reports/lib/warehanceClient');

// The live method list shape (names as configured in Warehance, 2026-04-30).
const METHODS = [
  { id: 1, name: 'US Standard Shipping' },
  { id: 2, name: 'US Expedited Shipping' },
  { id: 3, name: 'Fedex' },
  { id: 4, name: 'Passport DDP' },
  { id: 5, name: 'Passport DDU' },
];

describe('pickShippingMethod', () => {
  it('US standard / expedited', () => {
    assert.equal(pickShippingMethod(METHODS, 'us', 'standard').id, 1);
    assert.equal(pickShippingMethod(METHODS, 'us', 'expedited').id, 2);
  });

  it('non-US expedited routes through Fedex regardless of zone', () => {
    for (const zone of ['canada', 'ddp', 'ddu']) {
      assert.equal(pickShippingMethod(METHODS, zone, 'expedited').id, 3, zone);
    }
  });

  it('non-US standard: DDP for canada/ddp zones, DDU otherwise', () => {
    assert.equal(pickShippingMethod(METHODS, 'canada', 'standard').id, 4);
    assert.equal(pickShippingMethod(METHODS, 'ddp', 'standard').id, 4);
    assert.equal(pickShippingMethod(METHODS, 'ddu', 'standard').id, 5);
    assert.equal(pickShippingMethod(METHODS, null, 'standard').id, 5); // unknown zone falls back to DDU
  });

  it('does not false-match "us" inside other words (e.g. Australia Post)', () => {
    const methods = [
      { id: 9, name: 'Australia Post Standard' },
      { id: 1, name: 'US Standard Shipping' },
    ];
    assert.equal(pickShippingMethod(methods, 'us', 'standard').id, 1);
  });

  it('returns null when nothing matches', () => {
    assert.equal(pickShippingMethod([], 'us', 'standard'), null);
    assert.equal(pickShippingMethod([{ id: 3, name: 'Fedex' }], 'us', 'standard'), null);
  });
});
