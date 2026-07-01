/**
 * Supplier packing / shipping-list parser — the read-side counterpart to the
 * production-order sheet parser. Suppliers (Kali et al.) send an .xlsx "shipping
 * list" once goods are crated and ready to ship; this turns it into canonical
 * { sku, qty } lines plus the shipment-level packing totals (cartons, CBM, weight).
 *
 * Real Kali format (one sheet, repeated per product):
 *   Row band header:  SKU | Shipping QTY | CARTON NO. | N.W | G.W | MEANS | CBM
 *   Product header:   "THE AJ NO-TUCK SHAPING UNDERWEAR - SND"   (no qty)
 *   SKU line:         "    AJ-SND-12" | 56 | 1 | 13.7 | 14.7 | 60*40*30 | 0.07
 *   Subtotal line:    "" | 5087 | 20 | 329.5 | 349.5 | "" | 1.4   (blank SKU + totals)
 *   Final:            "" | <grand qty> ...   and/or a "GRAND TOTAL" banner
 *
 * Quirks handled: a SKU can appear on multiple carton rows (summed); carton number
 * is blank when a SKU shares the previous carton; "*** ASK SUPPLIER ***" annotations
 * in headers; repeated header bands between products; indented SKU labels.
 *
 * Pure: takes either a file path or an already-read matrix of rows. SKUs are returned
 * verbatim (supplier codes); canonicalization to catalog SKUs happens downstream in
 * skuCanonical.js so this stays a dumb, deterministic reader.
 */

const XLSX = require('xlsx');

// Same SKU shape as the order parser: letter-led prefix + hyphen segments, no spaces.
const SKU_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/i;

function isSku(s) {
  return SKU_RE.test(String(s || '').trim());
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function cleanHeader(text) {
  return String(text).replace(/\*{2,}[^*]*\*{2,}/g, '').replace(/\s+/g, ' ').trim();
}

// Column layout of the Kali shipping list. Override if a supplier differs.
const COLS = { sku: 0, qty: 1, carton: 2, nw: 3, gw: 4, means: 5, cbm: 6 };

/**
 * Parse a packing list into canonical lines + totals.
 * @param {string|Array[]} input - file path to an .xlsx, or a matrix of rows.
 * @param {object} [opts] - { sheetName, cols }
 * @returns {{
 *   items: {sku, qty}[],            // one row per distinct supplier SKU, qty summed
 *   sections: {name, units}[],      // product/color groupings in sheet order
 *   totals: {units, sku_count, cartons, cbm, net_weight_kg, gross_weight_kg},
 *   subtotal_units: number,         // sum of the supplier's own subtotal rows (checksum)
 *   warnings: string[],
 * }}
 */
function parsePackingList(input, opts = {}) {
  const cols = { ...COLS, ...(opts.cols || {}) };
  let rows = input;
  if (typeof input === 'string') {
    const wb = XLSX.readFile(input);
    const ws = wb.Sheets[opts.sheetName || wb.SheetNames[0]];
    if (!ws) throw new Error(`packing list sheet "${opts.sheetName || wb.SheetNames[0]}" not found`);
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  }

  const bySku = new Map();
  const sectionOf = new Map();  // sku -> the product/color header it first appeared under
  const sections = [];
  const warnings = [];
  const cartonNos = new Set();
  let curSection = null;
  let units = 0, cbm = 0, nw = 0, gw = 0;
  let subtotalUnits = 0;

  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i] || [];
    const c0 = String(r[cols.sku] != null ? r[cols.sku] : '').trim();
    const qty = num(r[cols.qty]);

    if (c0 === 'SKU') continue;                 // repeated header band
    if (!c0 && qty == null) continue;           // blank separator
    if (/grand\s*total/i.test(c0)) continue;    // final banner

    if (isSku(c0)) {
      if (qty == null) { warnings.push(`Row ${i + 1}: SKU ${c0} has no quantity`); continue; }
      bySku.set(c0, (bySku.get(c0) || 0) + qty);
      if (!sectionOf.has(c0)) sectionOf.set(c0, curSection ? curSection.name : '');
      units += qty;
      if (curSection) curSection.units += qty;
      const carton = r[cols.carton];
      const cn = num(carton);
      if (cn != null) cartonNos.add(cn);
      const cbmV = num(r[cols.cbm]); if (cbmV != null) cbm += cbmV;
      const nwV = num(r[cols.nw]); if (nwV != null) nw += nwV;
      const gwV = num(r[cols.gw]); if (gwV != null) gw += gwV;
      continue;
    }

    // Subtotal row: blank SKU column but a quantity present.
    if (!c0 && qty != null) { subtotalUnits += qty; continue; }

    // Otherwise a product/color header.
    curSection = { name: cleanHeader(c0), units: 0 };
    sections.push(curSection);
  }

  const items = [...bySku.entries()].map(([sku, qty]) => ({ sku, qty, section: sectionOf.get(sku) || '' }));

  if (subtotalUnits && subtotalUnits !== units) {
    warnings.push(`Checksum: SKU rows sum to ${units} but supplier subtotals sum to ${subtotalUnits}`);
  }

  return {
    items,
    sections,
    totals: {
      units,
      sku_count: items.length,
      cartons: cartonNos.size,
      cbm: Math.round(cbm * 100) / 100,
      net_weight_kg: Math.round(nw * 10) / 10,
      gross_weight_kg: Math.round(gw * 10) / 10,
    },
    subtotal_units: subtotalUnits,
    warnings,
  };
}

// Correct a supplier mislabel by rewriting a SKU's prefix (from -> to), optionally only
// for lines whose packing-list section header matches `section` (case-insensitive
// substring). Use when a factory barcodes a product under the WRONG prefix — e.g. the
// Evey sports bra shipped under `SB` (the Ava bra's prefix) when it should be `SPB`.
// Scoping by section keeps it from ever touching a genuinely-`SB` Ava line.
// @param items {sku, qty, section?}[]  @param remap {from, to, section?}[]
function applySkuRemap(items, remap) {
  if (!remap || !remap.length) return { items, rewritten: [] };
  const rewritten = [];
  const out = items.map((it) => {
    for (const rule of remap) {
      const from = String(rule.from || '').toUpperCase();
      const to = String(rule.to || '').toUpperCase();
      if (!from || !to) continue;
      if (String(it.sku).split('-')[0].toUpperCase() !== from) continue;
      if (rule.section && !String(it.section || '').toLowerCase().includes(String(rule.section).toLowerCase())) continue;
      const nextSku = String(it.sku).replace(new RegExp(`^${from}-`, 'i'), `${to}-`);
      rewritten.push({ from: it.sku, to: nextSku, qty: it.qty });
      return { ...it, sku: nextSku };
    }
    return it;
  });
  return { items: out, rewritten };
}

module.exports = { parsePackingList, isSku, applySkuRemap };
