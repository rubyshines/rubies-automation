const { test } = require('node:test');
const assert = require('node:assert');
const { parseProductionSheet, isSku, parseHeader } = require('../lib/merchandising/productionSheetParser');

test('isSku distinguishes SKUs from headers and numbers', () => {
  assert.ok(isSku('AJ-BLK-8'));
  assert.ok(isSku('SKY2-BLK-3XLT'));
  assert.ok(isSku('RUBY-BLK-XS1'));
  assert.ok(isSku('MPAD-SND-S'));
  assert.ok(!isSku('GAFF - BLK'));     // header (spaces)
  assert.ok(!isSku('TOTAL'));
  assert.ok(!isSku('515'));
});

test('parseHeader splits product name and color, strips annotations', () => {
  assert.deepStrictEqual(parseHeader('THE AJ NO-TUCK SHAPING UNDERWEAR - BLK'),
    { product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK' });
  assert.deepStrictEqual(parseHeader('THE BROOKE SHAPING BRA - BLK  *** ASK SUPPLIER ***'),
    { product_name: 'THE BROOKE SHAPING BRA', color: 'BLK' });
  assert.deepStrictEqual(parseHeader('Magic Gel Pads'),
    { product_name: 'Magic Gel Pads', color: '' });
});

test('parses a realistic multi-group block with indented SKUs and ",2980" subtotals', () => {
  const rows = [
    ['THE AJ NO-TUCK SHAPING UNDERWEAR - BLK'],
    ['AJ-BLK-8', '200'],
    ['AJ-BLK-10', '220'],
    ['AJ-BLK-12', '250'],
    ['', '670'],
    [],
    ['THE AJ NO-TUCK SHAPING UNDERWEAR - SND'],
    ['AJ-SND-S', '300'],
    ['AJ-SND-M', '150'],
    ['', '450'],
  ];
  const out = parseProductionSheet(rows);
  assert.strictEqual(out.groups.length, 2);
  assert.strictEqual(out.items.length, 5);
  assert.strictEqual(out.grand_total, 1120);
  assert.strictEqual(out.groups[0].color, 'BLK');
  assert.strictEqual(out.groups[0].subtotal_ok, true);
  assert.strictEqual(out.groups[1].subtotal_computed, 450);
  // items carry their group's product/color
  assert.strictEqual(out.items[0].product_name, 'THE AJ NO-TUCK SHAPING UNDERWEAR');
  assert.strictEqual(out.items[4].color, 'SND');
  assert.strictEqual(out.warnings.length, 0);
});

test('flags a subtotal that does not match the items', () => {
  const rows = [
    ['THE CHEEKY - BLK'],
    ['CKY-BLK-S', '60'],
    ['CKY-BLK-M', '90'],
    ['', '999'], // wrong; should be 150
  ];
  const out = parseProductionSheet(rows);
  assert.strictEqual(out.groups[0].subtotal_ok, false);
  assert.ok(out.warnings.some(w => /Subtotal mismatch/.test(w)));
  assert.strictEqual(out.grand_total, 150); // computed wins
});

test('handles bare-number subtotal and a trailing TOTAL row', () => {
  const rows = [
    ['MIA HALTER BIKINI TOP - BLK'],
    ['MIA-BLK-10', '30'],
    ['MIA-BLK-XL', '30'],
    ['60'],            // bare subtotal
    ['TOTAL', '60'],
  ];
  const out = parseProductionSheet(rows);
  assert.strictEqual(out.groups.length, 1);
  assert.strictEqual(out.grand_total, 60);
  assert.strictEqual(out.declared_grand_total, 60);
  assert.strictEqual(out.groups[0].subtotal_ok, true);
});

test('a non-numeric qty is warned, not silently dropped into the total', () => {
  const rows = [
    ['THE FLO - SND'],
    ['FLO-SND-8', '120'],
    ['FLO-SND-12', 'TBD'],
  ];
  const out = parseProductionSheet(rows);
  assert.strictEqual(out.grand_total, 120);
  assert.ok(out.warnings.some(w => /non-numeric qty/.test(w)));
});

test('zero quantities are preserved (intentional drop of a size)', () => {
  const rows = [
    ['THE RUBY - BLK'],
    ['RUBY-BLK-8', '0'],
    ['RUBY-BLK-M', '290'],
    ['', '290'],
  ];
  const out = parseProductionSheet(rows);
  assert.strictEqual(out.items.length, 2);
  assert.strictEqual(out.items.find(i => i.sku === 'RUBY-BLK-8').qty, 0);
  assert.strictEqual(out.groups[0].subtotal_ok, true);
});
