/**
 * Generate the third-party inspector's QC Master workbook (.xlsx) for a
 * production order — the front half of Phase 4 (QC) of the production pipeline.
 *
 * The workbook mirrors the geometry qcSheetParser reads, so a sheet the
 * inspector fills in round-trips through ingest_qc_results unchanged:
 *
 *   row 1     "Note measurements are in cms"            (unit note, anchor col)
 *   band:     Size XS | Size S | Size M                  (size label, merged)
 *             GAF-BLK-XS | GAF-BLK-S | GAF-BLK-M         (SKU label, first colour)
 *                  BLK BLK BLK | BLK BLK BLK | …         (colour of each sample col)
 *             POM # | Garment Specification | Tolerance | · | Orig | 1 | 2 | 3 | Diff | · | Orig …
 *             one row per POM: code, name, "+/-0.75", target per block, blank
 *             sample cells, Diff = average(samples) - Orig (live formula)
 *   two blank rows, next band …
 *
 * Blocks run 3 across (one band = 3 sizes), samples per block = colours ×
 * samples-per-colour, Diff cells carry the same conditional fill the inspector
 * already knows (green within tolerance, red outside).
 *
 * buildQcTab is pure (order SKUs + tech-pack specs in, grid + block geometry
 * out); writeQcWorkbook styles and saves; generateQcSheet loads the order and
 * specs from Supabase and records a draft qc_inspections row.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { extractSizeFromSku } = require('../sizeUtils');
const { sizeSort } = require('./reconcileSheet');
const { resolveOrder } = require('./inboundReceiving');
const { fetchCurrentSpecs } = require('./gradingSpecs');
const { QC_PRODUCTS, qcProductForPrefix, findQcProducts } = require('./qcProducts');

const BLOCKS_PER_BAND = 3;
const DEFAULT_SAMPLES_PER_COLOR = 3;
const UNIT_NOTE = 'Note measurements are in cms';

// Colour order on the sheet: BLK first (the SKU label is always written in
// BLK), then the rest in the order they appear on the order.
function colourOrder(colours) {
  const list = [...new Set(colours)];
  return list.sort((a, b) => (a === 'BLK' ? -1 : b === 'BLK' ? 1 : list.indexOf(a) - list.indexOf(b)));
}

const sizeTokens = (v) => String(v || '').toUpperCase().split(/[\/,]|\s+/).map((t) => t.trim()).filter(Boolean);

// Spec rows are keyed by the tech pack's own size string, which may combine
// aliases ("16 / M"). Find the spec-size key that names this display size.
function specSizeKey(specSizes, size) {
  const want = String(size).toUpperCase();
  return specSizes.find((s) => sizeTokens(s).includes(want)) || null;
}

/**
 * Build one product tab. Pure.
 *
 * @param {object} p
 * @param {string} p.tabName        sheet tab name, e.g. "Naomi Gaff"
 * @param {string} p.prefix         catalog SKU prefix, e.g. "GAF"
 * @param {string[]} p.skus         the order's SKUs for this product (qty > 0)
 * @param {object[]} p.specs        current tech_pack_specs rows for the product
 * @param {number} [p.samplesPerColor=3]
 * @param {number} [p.blocksPerBand=3]
 */
function buildQcTab({ tabName, prefix, skus, specs, samplesPerColor = DEFAULT_SAMPLES_PER_COLOR, blocksPerBand = BLOCKS_PER_BAND }) {
  const parsed = [...new Set(skus)].map((sku) => ({
    sku,
    colour: String(sku).split('-')[1] || 'BLK',
    size: extractSizeFromSku(sku).normalized || extractSizeFromSku(sku).raw,
  }));
  const colours = colourOrder(parsed.map((p) => p.colour));
  const labelColour = colours[0] || 'BLK';

  // Sizes on the order, in size-chart order, grouped by the spec's size key so
  // two SKUs that share a grading ("12 / XS") share a block.
  const specSizes = [...new Set(specs.map((s) => s.size))];
  const orderedSizes = [...new Set(parsed.sort((a, b) => sizeSort(a.sku) - sizeSort(b.sku)).map((p) => p.size))];
  const groups = [];
  for (const size of orderedSizes) {
    const key = specSizeKey(specSizes, size) || size;
    const g = groups.find((x) => x.key === key);
    if (g) g.sizes.push(size); else groups.push({ key, sizes: [size], hasSpec: specSizes.includes(key) });
  }

  // POM order: the spec's sort_order, then code — one row set shared by every block.
  const pomsByCode = new Map();
  for (const s of specs) if (!pomsByCode.has(s.pom_code)) pomsByCode.set(s.pom_code, { pom_code: s.pom_code, pom_name: s.pom_name, sort_order: s.sort_order ?? 0 });
  const poms = [...pomsByCode.values()].sort((a, b) => (a.sort_order - b.sort_order) || String(a.pom_code).localeCompare(String(b.pom_code)));
  const specFor = (sizeKey, pomCode) => specs.find((s) => s.size === sizeKey && s.pom_code === pomCode) || null;

  const nSamples = colours.length * samplesPerColor;
  const blockWidth = 1 + nSamples + 1 + 1; // Orig, samples, Diff, spacer
  const FIRST_ANCHOR = 4;                   // column E
  const rows = [];
  const blocks = [];
  const merges = [];
  const set = (r, c, v) => { (rows[r] = rows[r] || [])[c] = v; };

  set(0, FIRST_ANCHOR, UNIT_NOTE);
  let r = 2;
  for (let gi = 0; gi < groups.length; gi += blocksPerBand) {
    const band = groups.slice(gi, gi + blocksPerBand);
    const sizeRow = r, skuRow = r + 1, colourRow = r + 2, headerRow = r + 3, firstPom = r + 4;
    set(headerRow, 0, 'POM #'); set(headerRow, 1, 'Garment Specification'); set(headerRow, 2, 'Tolerance');
    // Tolerance column is shared across the band; take the first block's.
    const bandTol = (pom) => {
      for (const g of band) { const s = specFor(g.key, pom.pom_code); if (s && s.tolerance_cm != null) return Number(s.tolerance_cm); }
      return null;
    };
    poms.forEach((pom, pi) => {
      set(firstPom + pi, 0, pom.pom_code);
      set(firstPom + pi, 1, pom.pom_name || '');
      const tol = bandTol(pom);
      set(firstPom + pi, 2, tol == null ? '' : `+/-${tol}`);
    });
    band.forEach((g, bi) => {
      const anchor = FIRST_ANCHOR + bi * blockWidth;
      const diffCol = anchor + nSamples + 1;
      set(sizeRow, anchor, `Size ${g.sizes.join(' / ')}`);
      set(skuRow, anchor, g.sizes.map((s) => `${prefix}-${labelColour}-${s}`).join(' / '));
      merges.push({ row: sizeRow, from: anchor, to: diffCol }, { row: skuRow, from: anchor, to: diffCol });
      set(headerRow, anchor, 'Orig');
      const sampleCols = [];
      let n = 1;
      for (const colour of colours) {
        for (let k = 0; k < samplesPerColor; k++, n++) {
          const col = anchor + n;
          set(colourRow, col, colour);
          set(headerRow, col, String(n));
          sampleCols.push({ col, colour, sample_number: n });
        }
      }
      set(headerRow, diffCol, 'Diff');
      const pomRows = poms.map((pom, pi) => {
        const s = specFor(g.key, pom.pom_code);
        const target = s && s.target_cm != null ? Number(s.target_cm) : null;
        set(firstPom + pi, anchor, target);
        return { row: firstPom + pi, pom_code: pom.pom_code, target_cm: target, tolerance_cm: s && s.tolerance_cm != null ? Number(s.tolerance_cm) : bandTol(pom) };
      });
      blocks.push({ sizes: g.sizes, specSize: g.hasSpec ? g.key : null, sizeRow, skuRow, colourRow, headerRow, anchor, sampleCols, diffCol, pomRows });
    });
    r = firstPom + poms.length + 2;
  }

  return {
    name: tabName,
    prefix,
    unit: 'cm',
    colours,
    samplesPerColor,
    sizes: orderedSizes,
    sizesWithoutSpec: groups.filter((g) => !g.hasSpec).flatMap((g) => g.sizes),
    poms: poms.map((p) => p.pom_code),
    rows,
    blocks,
    merges,
    lastRow: r,
  };
}

// --- xlsx --------------------------------------------------------------------

const FONT = { name: 'Arial', size: 8 };
const BOLD = { ...FONT, bold: true };
const THIN = { style: 'thin' };
const BOX = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const NUM = '#0.0';
const IN_TOL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF93C47D' }, bgColor: { argb: 'FF93C47D' } };
const OUT_TOL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE06666' }, bgColor: { argb: 'FFE06666' } };

const colLetter = (c0) => { let s = ''; for (let n = c0 + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function addTab(wb, tab) {
  const ws = wb.addWorksheet(tab.name);
  const maxCol = Math.max(...tab.blocks.map((b) => b.diffCol), 6);
  ws.columns = Array.from({ length: maxCol + 1 }, (_, c) => ({ width: c === 0 ? 7 : c === 1 ? 26 : c === 2 ? 10 : c === 3 ? 3 : 5.5 }));

  tab.rows.forEach((row, r) => (row || []).forEach((v, c) => { if (v !== undefined) ws.getCell(r + 1, c + 1).value = v; }));
  ws.getCell(1, 5).font = BOLD;
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 0 }];

  for (const m of tab.merges) ws.mergeCells(m.row + 1, m.from + 1, m.row + 1, m.to + 1);

  for (const b of tab.blocks) {
    const cells = (r, c) => ws.getCell(r + 1, c + 1);
    const span = [b.anchor, ...b.sampleCols.map((s) => s.col), b.diffCol];
    const size = cells(b.sizeRow, b.anchor); size.font = BOLD; size.alignment = { horizontal: 'center' }; size.border = { top: THIN, left: THIN, right: THIN };
    const sku = cells(b.skuRow, b.anchor); sku.font = BOLD; sku.alignment = { horizontal: 'center' }; sku.border = { left: THIN, right: THIN };
    for (const s of b.sampleCols) { const c = cells(b.colourRow, s.col); c.font = BOLD; c.alignment = { horizontal: 'center' }; }
    for (const c of [0, 1, 2]) { const h = cells(b.headerRow, c); h.font = BOLD; h.border = BOX; }
    for (const c of span) { const h = cells(b.headerRow, c); h.font = BOLD; h.border = { bottom: THIN, left: c === b.anchor ? THIN : undefined, right: c === b.diffCol ? THIN : undefined }; h.alignment = { horizontal: 'center' }; }

    const first = b.pomRows[0].row, last = b.pomRows[b.pomRows.length - 1].row;
    const sampleFrom = colLetter(b.sampleCols[0].col), sampleTo = colLetter(b.sampleCols[b.sampleCols.length - 1].col);
    const orig = colLetter(b.anchor), diff = colLetter(b.diffCol);
    for (const p of b.pomRows) {
      for (const c of [0, 1, 2]) { const cell = cells(p.row, c); cell.font = FONT; cell.border = BOX; }
      for (const c of span) {
        const cell = cells(p.row, c);
        cell.font = FONT; cell.numFmt = NUM; cell.alignment = { horizontal: 'right' };
        cell.border = { top: p.row === first ? THIN : undefined, bottom: p.row === last ? THIN : undefined, left: c === b.anchor ? THIN : undefined, right: c === b.diffCol ? THIN : undefined };
      }
      const xl = p.row + 1;
      // Live diff: mean of whatever samples were filled minus the target; blank until measured.
      cells(p.row, b.diffCol).value = { formula: `IF(COUNTA(${sampleFrom}${xl}:${sampleTo}${xl})=0,"",AVERAGEIF(${sampleFrom}${xl}:${sampleTo}${xl},"<>")-${orig}${xl})` };
    }
    const ref = `${diff}${first + 1}:${diff}${last + 1}`;
    ws.addConditionalFormatting({
      ref,
      rules: [
        { type: 'expression', priority: 1, formulae: [`AND(${diff}${first + 1}<>"",ABS(${diff}${first + 1})>ABS(VALUE(SUBSTITUTE($C${first + 1},"+/-",""))))`], style: { fill: OUT_TOL_FILL } },
        { type: 'expression', priority: 2, formulae: [`AND(${diff}${first + 1}<>"",ABS(${diff}${first + 1})<=ABS(VALUE(SUBSTITUTE($C${first + 1},"+/-",""))))`], style: { fill: IN_TOL_FILL } },
      ],
    });
  }
  return ws;
}

async function writeQcWorkbook({ tabs, outPath }) {
  const wb = new ExcelJS.Workbook();
  for (const tab of tabs) addTab(wb, tab);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

// --- Supabase-backed entry point -------------------------------------------------

async function loadOrderItems(sb, orderId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('production_order_items').select('sku, qty_ordered').eq('production_order_id', orderId).range(from, from + 999);
    if (error) throw new Error(`production_order_items: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function samplesPerColorFor(sb, handle) {
  const { data } = await sb.from('tech_packs').select('samples_per_color').eq('product_handle', handle).maybeSingle();
  return data && data.samples_per_color ? data.samples_per_color : DEFAULT_SAMPLES_PER_COLOR;
}

/**
 * Build the workbook for a production order.
 *
 * @param {object} p
 * @param {string} p.production_code   e.g. "KALI-2606"
 * @param {string[]} [p.products]      restrict to these products (prefix, handle or name); default every QC product on the order
 * @param {number} [p.samples_per_color]
 * @param {string} [p.out_path]
 * @param {boolean} [p.record=true]    write/refresh the draft qc_inspections row
 */
async function generateQcSheet({ production_code, products, samples_per_color, out_path, record = true } = {}) {
  if (!production_code) throw new Error('production_code is required');
  const sb = getSupabaseClient();
  const order = await resolveOrder(production_code);
  if (!order) throw new Error(`order "${production_code}" not found`);
  const items = (await loadOrderItems(sb, order.id)).filter((i) => (i.qty_ordered || 0) > 0);
  if (!items.length) throw new Error(`order ${order.production_code} has no line items with quantity`);

  const onOrder = new Set(items.map((i) => String(i.sku).split('-')[0]));
  let wanted = products && products.length ? findQcProducts(products) : QC_PRODUCTS.filter((p) => onOrder.has(p.prefix));
  const notOnOrder = wanted.filter((p) => !onOrder.has(p.prefix)).map((p) => p.tab);
  wanted = wanted.filter((p) => onOrder.has(p.prefix));
  if (!wanted.length) throw new Error(`none of the requested products are on ${order.production_code}${notOnOrder.length ? ` (not on order: ${notOnOrder.join(', ')})` : ''}`);
  const skipped = [...onOrder].filter((pre) => !qcProductForPrefix(pre));

  const tabs = [];
  for (const p of wanted) {
    const specs = (await Promise.all([].concat(p.handles).map((h) => fetchCurrentSpecs(h)))).flat();
    const skus = items.filter((i) => String(i.sku).split('-')[0] === p.prefix).map((i) => i.sku);
    const spc = samples_per_color || await samplesPerColorFor(sb, [].concat(p.handles)[0]);
    tabs.push(buildQcTab({ tabName: p.tab, prefix: p.prefix, skus, specs, samplesPerColor: spc }));
  }

  const categories = [...new Set(wanted.map((p) => p.category))];
  const category = categories.length === 1 ? categories[0] : null;
  const catLabel = category ? category[0].toUpperCase() + category.slice(1) : 'Mixed';
  const subset = products && products.length ? ` - ${wanted.map((p) => p.tab).join(', ')}` : '';
  const outPath = out_path || `${process.env.HOME}/Downloads/${order.production_code} ${catLabel} QC Master${subset}.xlsx`;
  await writeQcWorkbook({ tabs, outPath });

  let inspection_id = null;
  if (record && category) {
    const { data: existing } = await sb.from('qc_inspections').select('id, status').eq('production_order_id', order.id).eq('category', category).maybeSingle();
    if (!existing) {
      const { data, error } = await sb.from('qc_inspections').insert({ production_order_id: order.id, category, status: 'draft', sheet_url: outPath, notes: `generated ${new Date().toISOString().slice(0, 10)}: ${wanted.map((p) => p.tab).join(', ')}` }).select('id').single();
      if (error) throw new Error(`qc_inspections insert: ${error.message}`);
      inspection_id = data.id;
    } else if (existing.status === 'draft') {
      await sb.from('qc_inspections').update({ sheet_url: outPath, updated_at: new Date().toISOString() }).eq('id', existing.id);
      inspection_id = existing.id;
    } else {
      inspection_id = existing.id; // already sent/completed — never regress it
    }
  }

  return {
    path: outPath,
    order: { id: order.id, production_code: order.production_code },
    category,
    inspection_id,
    tabs: tabs.map((t) => ({ name: t.name, prefix: t.prefix, sizes: t.sizes, colours: t.colours, samples_per_color: t.samplesPerColor, poms: t.poms, sizes_without_spec: t.sizesWithoutSpec })),
    not_on_order: notOnOrder,
    skipped_prefixes: skipped,
  };
}

module.exports = { buildQcTab, writeQcWorkbook, generateQcSheet, colourOrder, specSizeKey };
