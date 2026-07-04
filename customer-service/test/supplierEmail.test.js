const { test } = require('node:test');
const assert = require('node:assert');

const { buildOrderEmailContent } = require('../lib/merchandising/supplierEmail');

const ORDER = { id: 39, production_code: 'KALI-2606' };
const SUPPLIER = { name: 'Kali', email: 'kali.lin@qq.com' };

test('buildOrderEmailContent: updated order replaces the previous one', () => {
  const { subject, bodyText } = buildOrderEmailContent({
    order: ORDER, supplier: SUPPLIER, skuCount: 144, totalUnits: 13540,
    note: 'The March quantity changes caused some confusion, so we adjusted the totals.',
    updated: true,
  });
  assert.equal(subject, 'Updated order KALI-2606');
  assert.match(bodyText, /^Hi Kali,/);
  assert.match(bodyText, /March quantity changes/);
  assert.match(bodyText, /replaces the KALI-2606 order sent previously: 144 SKUs, 13,540 units/);
  assert.match(bodyText, /Jamie$/);
});

test('buildOrderEmailContent: new order, no note', () => {
  const { subject, bodyText } = buildOrderEmailContent({
    order: ORDER, supplier: SUPPLIER, skuCount: 144, totalUnits: 13540, updated: false,
  });
  assert.equal(subject, 'Production order KALI-2606');
  assert.match(bodyText, /Please find attached our production order KALI-2606/);
  assert.ok(!bodyText.includes('undefined'));
});
