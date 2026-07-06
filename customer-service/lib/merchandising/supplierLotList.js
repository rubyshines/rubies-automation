/**
 * Supplier-facing ordered-vs-produced list for a production order, one section
 * per lot, organized the way the production order itself reads: grouped by
 * PRODUCT NAME - COLOR with SKUs in size order and live subtotals per group.
 *
 *   1. SHIPPED GOODS — the full order curve for standard shipped lots (incl.
 *      ordered-but-missing and shipped-but-not-ordered lines, in their product
 *      group), so diffs read in the context of the size curve
 *   2. Marked test batches (e.g. pink sticker) — shipped, for reference
 *   3. HELD AT FACTORY — nominal quantities with a fill-in column; the
 *      supplier's answers become the next shipment's expected packing list
 *
 * Significance highlighting (founder rules, same thresholds as the reconcile
 * anomalies): RED under-production = short by >=10 units AND >=10% of ordered
 * (incl. missing). ORANGE over-production = produced >= 2x ordered (incl.
 * shipped-but-not-ordered >=10 units). Ordinary over-runs stay plain —
 * factories round up for cutting efficiency.
 *
 * Output is .xlsx (suppliers work in Excel, not Google Sheets).
 */

const ExcelJS = require('exceljs');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { resolveOrder, buildSkuResolver } = require('./inboundReceiving');
const { groupLines } = require('./reconcileSheet');

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

function noteFor(ordered, produced, highlight) {
  if (ordered > 0 && produced === 0) return 'ordered, not in shipment — please confirm';
  if (ordered === 0 && produced > 0) return 'shipped but not on the order — please confirm';
  if (highlight === 'under') return 'short of ordered qty';
  if (highlight === 'over') return 'large over-run';
  return '';
}

/**
 * Pure: split an order's items+lots into the three sections with per-row
 * significance. Section rows: { sku, ordered, produced, diff, note,
 * highlight: 'under'|'over'|null }. Shipped carries the FULL curve (exact
 * lines included) so it can be grouped like the order.
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
  const shippedSkus = new Set([...ordered.keys(), ...shipStd.keys()]);
  for (const sku of shippedSkus) {
    if (held.has(sku) || marked.has(sku)) continue; // their own sections
    const ord = ordered.get(sku) || 0;
    const prod = shipStd.get(sku) || 0;
    if (ord === 0 && prod === 0) continue; // zero-qty order lines
    const diff = prod - ord;
    const sig = diff !== 0 && isSignificant(ord, diff, opts);
    const highlight = sig ? (diff < 0 ? 'under' : 'over') : null;
    shipped.push({ sku, ordered: ord, produced: prod, diff, note: noteFor(ord, prod, highlight), highlight });
  }

  const markedRows = [...marked.entries()].map(([sku, prod]) => {
    const ord = ordered.get(sku) || 0;
    const diff = prod - ord;
    const sig = diff !== 0 && isSignificant(ord, diff, opts);
    return { sku, ordered: ord, produced: prod, diff, note: '', highlight: sig ? (diff < 0 ? 'under' : 'over') : null };
  });

  const heldRows = [...held.entries()].map(([sku, qty]) => ({
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
  const allSkus = [...new Set([...sections.shipped, ...sections.marked, ...sections.held].map((r) => r.sku))];
  const resolve = await buildSkuResolver(allSkus);
  const code = order.production_code || `order-${order.id}`;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(code);
  ws.columns = [{ width: 30 }, { width: 10 }, { width: 20 }, { width: 10 }, { width: 40 }];
  const bold = (row) => { row.font = { bold: true }; return row; };
  const fillRow = (row, argb) => { for (let c = 1; c <= 5; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };
  const applyHighlight = (row, h) => { if (h === 'under') fillRow(row, UNDER_FILL); else if (h === 'over') fillRow(row, OVER_FILL); };

  bold(ws.addRow([`${code} — Ordered vs Produced, by lot`]));
  ws.addRow([`Generated ${new Date().toISOString().slice(0, 10)} · Red = significant under-production (≥10 units and ≥10%) · Orange = large over-production (2× ordered or more)`]);
  ws.addRow([]);

  // One product-color group: header row, size-ordered SKU rows, live subtotal.
  // Formula cells always carry a cached result — viewers that don't recalc
  // (Numbers, previews) render result-less formulas as blank, which reads as
  // missing subtotals. Held-section fill-in diffs stay result-less on purpose
  // (blank until the supplier fills the produced column).
  const emitGroups = (rows, { fillProduced = false } = {}) => {
    for (const g of groupLines(rows, resolve)) {
      bold(ws.addRow([g.color ? `${g.product} - ${g.color}` : g.product]));
      const first = ws.rowCount + 1;
      let subOrd = 0, subProd = 0, subDiff = 0;
      for (const r of g.lines) {
        const rowNum = ws.rowCount + 1;
        subOrd += r.ordered || 0;
        subProd += fillProduced ? 0 : (r.produced || 0);
        const diff = fillProduced ? undefined : (r.produced || 0) - (r.ordered || 0);
        if (diff !== undefined) subDiff += diff;
        const row = ws.addRow([
          r.sku, r.ordered,
          fillProduced ? '' : r.produced,
          diff === undefined ? { formula: `C${rowNum}-B${rowNum}` } : { formula: `C${rowNum}-B${rowNum}`, result: diff },
          r.note,
        ]);
        applyHighlight(row, r.highlight);
        if (fillProduced) row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_IN_FILL } };
      }
      const last = ws.rowCount;
      bold(ws.addRow(['',
        { formula: `SUM(B${first}:B${last})`, result: subOrd },
        fillProduced ? { formula: `SUM(C${first}:C${last})` } : { formula: `SUM(C${first}:C${last})`, result: subProd },
        fillProduced ? { formula: `SUM(D${first}:D${last})` } : { formula: `SUM(D${first}:D${last})`, result: subDiff },
        '']));
      ws.addRow([]);
    }
  };

  bold(ws.addRow(['1. SHIPPED GOODS — vs the order']));
  bold(ws.addRow(['SKU', 'Ordered', 'Produced', 'Diff', 'Note']));
  emitGroups(sections.shipped);

  if (sections.marked.length) {
    bold(ws.addRow(['2. MARKED TEST BATCH (shipped) — for reference']));
    bold(ws.addRow(['SKU', 'Ordered', 'Produced', 'Diff', '']));
    emitGroups(sections.marked);
  }

  if (sections.held.length) {
    bold(ws.addRow(['3. HELD AT FACTORY — ships in the next shipment']));
    ws.addRow(['Our records show the ORDERED quantity. Please fill in the ACTUAL PRODUCED quantity for each SKU.']);
    bold(ws.addRow(['SKU', 'Ordered', 'Produced (please fill)', 'Diff', '']));
    emitGroups(sections.held, { fillProduced: true });
  }

  const path = outPath || `${process.env.HOME}/Downloads/${code} Ordered vs Produced by Lot.xlsx`;
  await wb.xlsx.writeFile(path);

  return {
    path,
    order: { id: order.id, production_code: order.production_code },
    stats: {
      shipped_rows: sections.shipped.length,
      shipped_discrepancies: sections.shipped.filter((r) => r.diff !== 0).length,
      highlighted_under: sections.shipped.concat(sections.marked).filter((r) => r.highlight === 'under').length,
      highlighted_over: sections.shipped.concat(sections.marked).filter((r) => r.highlight === 'over').length,
      marked_skus: sections.marked.length,
      held_skus: sections.held.length,
    },
  };
}

module.exports = { buildSupplierLotSections, writeSupplierLotList, isSignificant };
