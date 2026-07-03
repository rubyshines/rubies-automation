/**
 * Supplier-facing ordered-vs-produced list for a production order, one section
 * per lot — the artifact Jamie sends the factory to settle quantities:
 *
 *   1. SHIPPED GOODS — standard shipped lots: quantity differences to raise
 *   2. Marked test batches (e.g. pink sticker) — shipped, for reference
 *   3. HELD AT FACTORY — nominal quantities with a fill-in column; the
 *      supplier's answers become the next shipment's expected packing list
 *
 * Significant discrepancies are highlighted (founder rules — simple, readable,
 * same thresholds as the reconcile anomalies): RED under-production = short by
 * >=10 units AND >=10% of ordered (incl. missing). ORANGE over-production =
 * produced >= 2x ordered (incl. shipped-but-not-ordered >=10 units). Ordinary
 * over-runs stay unhighlighted — factories round up for cutting efficiency.
 *
 * Output is .xlsx (suppliers work in Excel, not Google Sheets).
 */

const ExcelJS = require('exceljs');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { resolveOrder } = require('./inboundReceiving');

const UNDER_FILL = 'FFF4CCCC'; // light red
const OVER_FILL = 'FFFCE5CD'; // light orange
const FILL_IN_FILL = 'FFFFF2CC'; // light yellow — cells the supplier fills

// Under: short by >= abs units AND >= pct of ordered. Over: produced >= overMult
// x ordered (the reconcile big-over rule). Not-ordered extras: >= abs units.
function isSignificant(ordered, diff, { abs = 10, pct = 0.1, overMult = 2 } = {}) {
  if (ordered <= 0) return Math.abs(diff) >= abs;
  if (diff < 0) return -diff >= abs && -diff >= ordered * pct;
  return ordered + diff >= ordered * overMult;
}

/**
 * Pure: split an order's items+lots into the three sections with per-row
 * significance. Returns { shipped: [...], marked: [...], held: [...] } where
 * each row is { sku, ordered, produced, diff, note, highlight: 'under'|'over'|null }.
 */
function buildSupplierLotSections({ items, lots }, opts = {}) {
  const ordered = new Map(items.map((i) => [i.sku, i.qty_ordered || 0]));
  const shipStd = new Map();
  const marked = new Map();
  const held = new Map();
  for (const l of lots) {
    const m = l.disposition === 'hold_storage' ? held : (l.marker ? marked : shipStd);
    m.set(l.sku, (m.get(l.sku) || 0) + l.qty);
  }

  const shipped = [];
  for (const [sku, ord] of [...ordered.entries()].sort()) {
    if (held.has(sku) || marked.has(sku)) continue; // their own sections
    const prod = shipStd.get(sku) || 0;
    if (ord === 0 && prod === 0) continue;
    const diff = prod - ord;
    if (diff === 0) continue; // discrepancies only
    const sig = isSignificant(ord, diff, opts);
    shipped.push({
      sku, ordered: ord, produced: prod, diff,
      note: prod === 0 ? 'ordered, not in shipment — please confirm' : diff < 0 ? 'short of ordered qty' : 'over-run',
      highlight: sig ? (diff < 0 ? 'under' : 'over') : null,
    });
  }
  for (const [sku, prod] of [...shipStd.entries()].sort()) {
    if (ordered.get(sku)) continue;
    shipped.push({
      sku, ordered: 0, produced: prod, diff: prod,
      note: 'shipped but not on the order — please confirm',
      highlight: isSignificant(0, prod, opts) ? 'over' : null,
    });
  }
  // under first (the ones that cost sales), then over, big to small
  shipped.sort((a, b) => (a.diff < 0 ? 0 : 1) - (b.diff < 0 ? 0 : 1) || Math.abs(b.diff) - Math.abs(a.diff));

  const markedRows = [...marked.entries()].sort().map(([sku, prod]) => {
    const ord = ordered.get(sku) || 0;
    const diff = prod - ord;
    return { sku, ordered: ord, produced: prod, diff, note: '', highlight: isSignificant(ord, diff, opts) ? (diff < 0 ? 'under' : 'over') : null };
  });

  const heldRows = [...held.entries()].sort().map(([sku, qty]) => ({
    sku, ordered: ordered.get(sku) || qty, produced: null, diff: null, note: '', highlight: null,
  }));

  return { shipped, marked: markedRows, held: heldRows };
}

/**
 * Build and write the .xlsx for an order. Returns section stats + the path.
 */
async function writeSupplierLotList({ orderRef, outPath }) {
  const sb = getSupabaseClient();
  const order = await resolveOrder(orderRef);
  if (!order) throw new Error(`order "${orderRef}" not found`);
  const { data: items } = await sb.from('production_order_items').select('sku, qty_ordered').eq('production_order_id', order.id);
  const { data: lots } = await sb.from('production_lots').select('sku, qty, quality, marker, disposition').eq('production_order_id', order.id);
  if (!lots || !lots.length) throw new Error(`order ${order.production_code} has no production_lots recorded — receive the shipment / record lots first`);

  const sections = buildSupplierLotSections({ items: items || [], lots });
  const code = order.production_code || `order-${order.id}`;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(code);
  ws.columns = [{ width: 22 }, { width: 10 }, { width: 20 }, { width: 10 }, { width: 40 }];
  const bold = (row) => { row.font = { bold: true }; return row; };
  const fillRow = (row, argb) => { for (let c = 1; c <= 5; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };
  const applyHighlight = (row, h) => { if (h === 'under') fillRow(row, UNDER_FILL); else if (h === 'over') fillRow(row, OVER_FILL); };

  bold(ws.addRow([`${code} — Ordered vs Produced, by lot`]));
  ws.addRow([`Generated ${new Date().toISOString().slice(0, 10)} · Red = significant under-production (≥10 units and ≥10%) · Orange = large over-production (2× ordered or more)`]);
  ws.addRow([]);

  bold(ws.addRow(['1. SHIPPED GOODS — quantity differences vs the order']));
  bold(ws.addRow(['SKU', 'Ordered', 'Produced', 'Diff', 'Note']));
  for (const r of sections.shipped) {
    const row = ws.addRow([r.sku, r.ordered, r.produced, r.diff, r.note]);
    applyHighlight(row, r.highlight);
  }
  if (!sections.shipped.length) ws.addRow(['(no discrepancies)']);
  ws.addRow([]);

  if (sections.marked.length) {
    bold(ws.addRow(['2. MARKED TEST BATCH (shipped) — for reference']));
    bold(ws.addRow(['SKU', 'Ordered', 'Produced', 'Diff', '']));
    const first = ws.rowCount + 1;
    for (const r of sections.marked) {
      const row = ws.addRow([r.sku, r.ordered, r.produced, r.diff, '']);
      applyHighlight(row, r.highlight);
    }
    bold(ws.addRow(['Total', { formula: `SUM(B${first}:B${ws.rowCount})` }, { formula: `SUM(C${first}:C${ws.rowCount})` }, '', '']));
    ws.addRow([]);
  }

  if (sections.held.length) {
    bold(ws.addRow(['3. HELD AT FACTORY — ships in the next shipment']));
    ws.addRow(['Our records show the ORDERED quantity. Please fill in the ACTUAL PRODUCED quantity for each SKU.']);
    bold(ws.addRow(['SKU', 'Ordered', 'Produced (please fill)', 'Diff', '']));
    const first = ws.rowCount + 1;
    for (const r of sections.held) {
      const row = ws.addRow([r.sku, r.ordered, '', { formula: `C${ws.rowCount + 1}-B${ws.rowCount + 1}` }, '']);
      row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_IN_FILL } };
    }
    bold(ws.addRow(['Total', { formula: `SUM(B${first}:B${ws.rowCount})` }, { formula: `SUM(C${first}:C${ws.rowCount})` }, '', '']));
  }

  const path = outPath || `${process.env.HOME}/Downloads/${code} Ordered vs Produced by Lot.xlsx`;
  await wb.xlsx.writeFile(path);

  return {
    path,
    order: { id: order.id, production_code: order.production_code },
    stats: {
      shipped_discrepancies: sections.shipped.length,
      highlighted_under: sections.shipped.concat(sections.marked).filter((r) => r.highlight === 'under').length,
      highlighted_over: sections.shipped.concat(sections.marked).filter((r) => r.highlight === 'over').length,
      marked_skus: sections.marked.length,
      held_skus: sections.held.length,
    },
  };
}

module.exports = { buildSupplierLotSections, writeSupplierLotList, isSignificant };
