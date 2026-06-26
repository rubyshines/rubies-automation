const { test } = require('node:test');
const assert = require('node:assert');
const { supplierToken, yymm, nextProductionCode } = require('../lib/merchandising/productionCode');

test('supplierToken takes the first word, uppercased and alphanumeric', () => {
  assert.strictEqual(supplierToken('Kali'), 'KALI');
  assert.strictEqual(supplierToken('JustMax'), 'JUSTMAX');
  assert.strictEqual(supplierToken('Pigeons and Thread'), 'PIGEONS');
});

test('yymm formats a date as YYMM', () => {
  assert.strictEqual(yymm(new Date('2026-06-15')), '2606');
  assert.strictEqual(yymm(new Date('2026-01-02')), '2601');
  assert.strictEqual(yymm(new Date('2026-12-31')), '2612');
});

test('first order in a month gets the bare {SUPPLIER}-{YYMM} code', () => {
  assert.strictEqual(nextProductionCode('Kali', new Date('2026-06-15'), []), 'KALI-2606');
});

test('a same-month collision appends -02, then -03', () => {
  assert.strictEqual(nextProductionCode('Kali', new Date('2026-06-15'), ['KALI-2606']), 'KALI-2606-02');
  assert.strictEqual(
    nextProductionCode('Kali', new Date('2026-06-15'), ['KALI-2606', 'KALI-2606-02']),
    'KALI-2606-03'
  );
});

test('collision check is case-insensitive and other months/suppliers do not collide', () => {
  assert.strictEqual(nextProductionCode('Kali', new Date('2026-06-15'), ['kali-2606']), 'KALI-2606-02');
  assert.strictEqual(nextProductionCode('Kali', new Date('2026-07-01'), ['KALI-2606']), 'KALI-2607');
  assert.strictEqual(nextProductionCode('JustMax', new Date('2026-06-01'), ['KALI-2606']), 'JUSTMAX-2606');
});
