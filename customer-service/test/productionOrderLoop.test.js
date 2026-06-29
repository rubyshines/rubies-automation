const { test } = require('node:test');
const assert = require('node:assert');
const { buildSheetRows } = require('../lib/merchandising/productionOrderLoop');
const { parseProductionSheet } = require('../lib/merchandising/productionSheetParser');

const PROJ = [
  { sku: 'AJ-BLK-M', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK', size: 'M', qty_to_order: 670 },
  { sku: 'AJ-BLK-8', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'BLK', size: '8', qty_to_order: 200 },
  { sku: 'AJ-SND-S', product_name: 'THE AJ NO-TUCK SHAPING UNDERWEAR', color: 'SND', size: 'S', qty_to_order: 300 },
];

test('buildSheetRows: mixed-case names, bold rows, live subtotals, resilient grand total', () => {
  const { rows, grand, boldRows } = buildSheetRows(PROJ);
  assert.strictEqual(grand, 1170); // numeric grand still returned for display
  // Product names are title-cased; BLK group before SND; size 8 before M within BLK
  const blkHeader = rows.findIndex(r => r[0] === 'The AJ No-Tuck Shaping Underwear - BLK');
  assert.ok(blkHeader >= 0);
  assert.deepStrictEqual(rows[blkHeader + 1], ['AJ-BLK-8', 200]);
  assert.deepStrictEqual(rows[blkHeader + 2], ['AJ-BLK-M', 670]);
  assert.deepStrictEqual(rows[blkHeader + 3], ['', '=SUM(B2:B3)']); // subtotal — live formula
  // Grand total survives row add/remove (no hardcoded cell list, no self-reference)
  assert.deepStrictEqual(rows[rows.length - 1], ['TOTAL', '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")']);
  // Bold: every product header, every subtotal, and the grand total
  assert.ok(boldRows.includes(blkHeader));        // header
  assert.ok(boldRows.includes(blkHeader + 3));    // subtotal
  assert.ok(boldRows.includes(rows.length - 1));  // grand total
});

test('buildSheetRows output parses back to the same items + total (GO round-trip)', () => {
  const { rows, grand } = buildSheetRows(PROJ);
  const parsed = parseProductionSheet(rows);
  assert.strictEqual(parsed.items.length, 3);
  assert.strictEqual(parsed.grand_total, grand);
  assert.strictEqual(parsed.warnings.length, 0);
  const byNumber = Object.fromEntries(parsed.items.map(i => [i.sku, i.qty]));
  assert.strictEqual(byNumber['AJ-BLK-M'], 670);
  assert.strictEqual(byNumber['AJ-SND-S'], 300);
});
