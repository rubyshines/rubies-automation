const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { buildOrderWorkbook, prependTitle } = require('../lib/merchandising/productionOrderLoop');

test('prependTitle: adds title + blank and shifts formula row refs by 2', () => {
  const out = prependTitle([
    ['GAF-BLK-XS', 230],
    ['GAF-BLK-S', 620],
    ['', '=SUM(B1:B2)'],
    ['TOTAL', '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")'],
  ], 'Production Order: Kali (KALI-2606)');
  assert.deepStrictEqual(out[0], ['Production Order: Kali (KALI-2606)']);
  assert.deepStrictEqual(out[1], []);
  assert.deepStrictEqual(out[4], ['', '=SUM(B3:B4)']);          // shifted +2
  assert.strictEqual(out[5][1], '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")'); // whole-col untouched
});

// Rows as a FORMULA-rendered order tab would return them: header, data, formula subtotal, grand.
const ROWS = [
  ['Naomi Gaff Extra Strength Shaping Underwear - BLK'],
  ['GAF-BLK-XS', 230],
  ['GAF-BLK-S', 620],
  ['', '=SUM(B2:B3)'],
  [],
  ['TOTAL', '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")'],
];

test('buildOrderWorkbook: bold headers/subtotals/grand + live formulas, mirrored rows', async () => {
  const wb = await buildOrderWorkbook(ROWS, null);
  const buf = await wb.xlsx.writeBuffer();

  // round-trip read
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  const ws = wb2.getWorksheet('Order');

  // header row bold
  assert.strictEqual(ws.getCell('A1').value, 'Naomi Gaff Extra Strength Shaping Underwear - BLK');
  assert.strictEqual(ws.getCell('A1').font.bold, true);
  // data row plain number, not bold
  assert.strictEqual(ws.getCell('B2').value, 230);
  assert.notStrictEqual(ws.getRow(2).font && ws.getRow(2).font.bold, true);
  // subtotal is a live formula and bold
  assert.strictEqual(ws.getCell('B4').value.formula, 'SUM(B2:B3)');
  assert.strictEqual(ws.getCell('B4').font.bold, true);
  // grand total formula + bold
  assert.strictEqual(ws.getCell('A6').value, 'TOTAL');
  assert.strictEqual(ws.getCell('B6').value.formula, 'SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")');
  assert.strictEqual(ws.getCell('A6').font.bold, true);
});
