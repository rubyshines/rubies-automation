/**
 * Refresh every artifact derived from a production order after its lines
 * change: the order tab in the 2026 Production Numbers sheet, the incoming-
 * inventory tab (pre-order sheet), and the supplier .xlsx in ~/Downloads.
 * All three use the canonical order format: PRODUCT NAME - COLOR groups,
 * size-sorted SKUs, live subtotals per colorway, grand total.
 *
 * Usage:
 *   node scripts/refreshOrderArtifacts.js KALI-2606 \
 *     --order-tab "2026-06-29 - Kali Swim, Underwear, Bras and Accessories" \
 *     --incoming-tab us-2026-10-15 [--updated]
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { getSheetsClient } = require('../shared/googleSheetsClient');
const { buildSheetRows, buildOrderWorkbook, prependTitle, writeOrderTab, resolveOrderItems } = require('../customer-service/lib/merchandising/productionOrderLoop');
const { resolveOrder } = require('../customer-service/lib/merchandising/inboundReceiving');

const PRE_ORDER_SHEET = process.env.PRE_ORDER_SHEET_ID || '1m2efAIbrV_fSYhJEfyAghROwJb7_3Fm5PuwR6GYjLwo';
const PROD_SHEET = process.env.PRODUCTION_SHEET_ID || '1kMZ-thv7pmBEvudlT_Ujw1z1wb-2zwjV5vT_TuNm87w';

const shift1 = (f) => String(f).replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (_, c, n) => `${c}${parseInt(n, 10) + 1}`);

async function writeIncomingTab(sheets, tabName, items) {
  const { rows, boldRows } = buildSheetRows(items, { formulas: true });
  const shifted = rows.map((r) => r.map((cell) => (typeof cell === 'string' && cell.startsWith('=') ? `=${shift1(cell.slice(1))}` : cell)));
  const values = [['sku', 'incoming'], ...shifted];
  const meta = await sheets.spreadsheets.get({ spreadsheetId: PRE_ORDER_SHEET, fields: 'sheets.properties(sheetId,title)' });
  const ex = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (!ex) throw new Error(`incoming tab "${tabName}" not found`);
  await sheets.spreadsheets.values.clear({ spreadsheetId: PRE_ORDER_SHEET, range: `'${tabName}'` });
  await sheets.spreadsheets.values.update({ spreadsheetId: PRE_ORDER_SHEET, range: `'${tabName}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values } });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: PRE_ORDER_SHEET,
    requestBody: { requests: [0, ...boldRows.map((r) => r + 1)].map((ri) => ({
      repeatCell: { range: { sheetId: ex.properties.sheetId, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 0, endColumnIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } })) },
  });
  return values.length;
}

(async () => {
  const args = process.argv.slice(2);
  const orderRef = args.find((a) => !a.startsWith('--'));
  if (!orderRef) throw new Error('usage: node scripts/refreshOrderArtifacts.js <production_code> [--order-tab NAME] [--incoming-tab NAME] [--updated]');
  const opt = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  const orderTab = opt('--order-tab');
  const incomingTab = opt('--incoming-tab');
  const updated = args.includes('--updated');

  const sb = getSupabaseClient();
  const sheets = await getSheetsClient();
  const order = await resolveOrder(orderRef);
  if (!order) throw new Error(`order "${orderRef}" not found`);
  const { data: rows } = await sb.from('production_order_items').select('sku, qty_ordered').eq('production_order_id', order.id);
  const items = await resolveOrderItems(rows.filter((i) => (i.qty_ordered || 0) > 0).map((i) => ({ sku: i.sku, qty: i.qty_ordered })));
  const total = items.reduce((s, i) => s + i.qty, 0);
  const code = order.production_code || `order-${order.id}`;
  console.log(`${code}: ${items.length} SKUs / ${total.toLocaleString()} units`);

  if (orderTab) {
    await writeOrderTab({ sheets, spreadsheetId: PROD_SHEET, tabName: orderTab, items });
    console.log('order tab rewritten:', orderTab);
  }
  if (incomingTab) {
    const n = await writeIncomingTab(sheets, incomingTab, items);
    console.log('incoming tab rewritten:', incomingTab, `(${n} rows)`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const { rows: sheetRows } = buildSheetRows(items, { formulas: true });
  const titled = prependTitle(sheetRows, `Production Order: ${code}${updated ? ` — UPDATED ${date}` : ` ${date}`}`);
  const wb = await buildOrderWorkbook(titled, null);
  const xlsxPath = path.join(os.homedir(), 'Downloads', `production-order-${code.toLowerCase()}${updated ? `-updated-${date}` : ''}.xlsx`);
  await wb.xlsx.writeFile(xlsxPath);
  console.log('supplier xlsx:', xlsxPath);
})().catch((e) => { console.error(e.message); process.exit(1); });
