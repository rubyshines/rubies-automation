const { test } = require('node:test');
const assert = require('node:assert');
const { matchSupplier } = require('../lib/merchandising/supplierRegistry');

// Mirror of the real `suppliers` rows that matter for prefix routing.
const SUPPLIERS = [
  { name: 'Kali', sku_prefixes: ['AJ', 'BB', 'GAF', 'SHS'] }, // catch-all
  { name: 'Queenas', sku_prefixes: ['SB'] },
  { name: 'JustMax', sku_prefixes: ['SWS'] },
  { name: 'Wumes', sku_prefixes: ['MPAD'] },
  { name: 'Pigeons and Thread', sku_prefixes: ['RHW'] },
  { name: 'Joyce', sku_prefixes: [] }, // qc_inspector — never matches
];

test('matchSupplier routes Stella (RHW) to Pigeons and Thread, not Kali', () => {
  assert.strictEqual(matchSupplier(SUPPLIERS, 'RHW-BLK-M').name, 'Pigeons and Thread');
});

test('matchSupplier routes the other specific suppliers by prefix', () => {
  assert.strictEqual(matchSupplier(SUPPLIERS, 'SB-NUD-L').name, 'Queenas');
  assert.strictEqual(matchSupplier(SUPPLIERS, 'SWS-BLK-S').name, 'JustMax');
  assert.strictEqual(matchSupplier(SUPPLIERS, 'MPAD-XS').name, 'Wumes');
});

test('matchSupplier falls through to the Kali catch-all for unclaimed prefixes', () => {
  assert.strictEqual(matchSupplier(SUPPLIERS, 'NEWTHING-BLK-M').name, 'Kali');
  assert.strictEqual(matchSupplier(SUPPLIERS, 'AJ-BLK-M').name, 'Kali'); // AJ is on Kali's own list
});

test('matchSupplier: a specific supplier wins even if the catch-all also lists the prefix', () => {
  const conflict = [
    { name: 'Kali', sku_prefixes: ['RHW'] }, // stale catch-all entry
    { name: 'Pigeons and Thread', sku_prefixes: ['RHW'] },
  ];
  assert.strictEqual(matchSupplier(conflict, 'RHW-BLK-M').name, 'Pigeons and Thread');
});

test('matchSupplier returns null for empty sku', () => {
  assert.strictEqual(matchSupplier(SUPPLIERS, ''), null);
});
