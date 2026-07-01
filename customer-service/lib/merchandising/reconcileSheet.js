/**
 * Build the reconciliation VIEW that gets written to the "2026 Production Numbers"
 * Google Sheet — the founder's review surface for a production order. Supabase stays
 * the source of truth; this is a rewritten-on-demand view.
 *
 * Columns: SKU | Ordered | Produced | Shipped | Received | Δ | Flag | Note.
 * Produced = finished (ship + hold_storage lots); Shipped = in this shipment. They differ
 * only when a production issue splits a line (some units held/remade). The Note column
 * carries the lot disposition (e.g. "pink_sticker · thin_black_fabric"). Grouped by
 * product/color like the order tab, with live =SUM subtotals + grand total (never
 * hardcoded), colour-coded flags, and an assessment block (⚠ ANOMALIES + 🎨 FABRIC/QUALITY).
 * Pure — takes reconcile data + a sku->{product,color} resolver.
 */

const { NUMERIC_SIZES, LETTER_SIZES, SIZE_ALIASES, parseSizeVariant } = require('../sizeUtils');

function sizeFromSku(sku) {
  return String(sku || '').split('-').slice(2).join('-');
}

// Size sort so a group reads XXS..4XL (and tall variants after), not alphabetical.
function sizeSort(sku) {
  const { base, modifier } = parseSizeVariant(sizeFromSku(sku).toUpperCase());
  const canonical = (base && (SIZE_ALIASES[base] || base)) || sizeFromSku(sku).toUpperCase();
  const isTall = modifier === 'Tall';
  const ni = NUMERIC_SIZES.indexOf(canonical);
  if (ni !== -1) return isTall ? 50 + ni : ni;
  const li = LETTER_SIZES.indexOf(canonical);
  if (li !== -1) return isTall ? 200 + li : 100 + li;
  return 999;
}

// Group reconcile lines by product+color via a sku->{product,color} resolver.
function groupLines(lines, resolve) {
  const groups = new Map();
  for (const l of lines) {
    const { product, color } = resolve(l.sku);
    const key = `${product}|||${color}`;
    if (!groups.has(key)) groups.set(key, { product, color, lines: [] });
    groups.get(key).lines.push(l);
  }
  const arr = [...groups.values()];
  for (const g of arr) g.lines.sort((a, b) => sizeSort(a.sku) - sizeSort(b.sku));
  arr.sort((a, b) => `${a.product}${a.color}`.localeCompare(`${b.product}${b.color}`));
  return arr;
}

/**
 * The lines worth the founder's attention. Thresholds keep 1-2 unit noise out of the
 * SHORT bucket (factories are rarely exact); over-production is only flagged when large.
 * @param reconcile  output of reconcileProductionOrder
 * @param opts { shortAbs, shortPct, overMult, catalog (Set of real SKUs) }
 */
function summarizeAnomalies(reconcile, opts = {}) {
  const { shortAbs = 10, shortPct = 0.1, overMult = 2, catalog = null } = opts;
  const a = { missing: [], short: [], extra: [], big_over: [], pending_catalog: [] };
  for (const l of reconcile.lines) {
    const gap = l.ordered - l.produced;
    if (l.flag === 'missing') a.missing.push(l);
    else if (l.flag === 'short' && gap >= shortAbs && gap >= l.ordered * shortPct) a.short.push(l);
    else if (l.flag === 'extra') a.extra.push(l);
    else if (l.flag === 'over' && l.ordered > 0 && l.produced >= l.ordered * overMult) a.big_over.push(l);
    if (catalog && !catalog.has(l.sku)) a.pending_catalog.push(l.sku);
  }
  return a;
}

function anomalyLines(a) {
  const fmt = (l) => `${l.sku} (ord ${l.ordered}/prod ${l.produced})`;
  const out = [];
  if (a.missing.length) out.push([`Missing — ordered, not in this shipment (${a.missing.length}): ${a.missing.map(fmt).join(', ')}`]);
  if (a.short.length) out.push([`Short-shipped beyond tolerance (${a.short.length}): ${a.short.map(fmt).join(', ')}`]);
  if (a.extra.length) out.push([`Extra — shipped, not ordered (${a.extra.length}): ${a.extra.map((l) => `${l.sku} (${l.produced})`).join(', ')}`]);
  if (a.big_over.length) out.push([`Large over-production, 2×+ ordered (${a.big_over.length}): ${a.big_over.map(fmt).join(', ')}`]);
  if (a.pending_catalog.length) out.push([`Not yet in catalog (${a.pending_catalog.length}): ${[...new Set(a.pending_catalog)].join(', ')}`]);
  if (!out.length) out.push(['None — every line within tolerance.']);
  return out;
}

// Per-line note describing the lot split (marker, quality, held count).
function lotNote(l) {
  const parts = [];
  if (l.marker) parts.push(l.marker);
  if (l.quality && l.quality !== 'standard') parts.push(l.quality);
  const held = (l.produced || 0) - (l.shipped || 0);
  if (held > 0) parts.push(`${held} held`);
  return parts.join(' · ');
}

// The fabric/quality (production-issue) view for the assessment block.
function summarizeLots(reconcile) {
  const flagged = reconcile.lines.filter((l) => l.flagged);
  const held = reconcile.lines.filter((l) => ((l.produced || 0) - (l.shipped || 0)) > 0);
  return { flagged, held };
}

function qualityLines(reconcile) {
  const { flagged, held } = summarizeLots(reconcile);
  const out = [];
  if (flagged.length) {
    const q = flagged[0].quality;
    const m = flagged[0].marker;
    const units = flagged.reduce((s, l) => s + (l.shipped || 0), 0);
    out.push([`Flagged test batch — ${m ? `${m} · ` : ''}${q} (${flagged.length} SKUs, ${units} units shipped): ${flagged.map((l) => `${l.sku}(${l.shipped})`).join(', ')}`]);
  }
  if (held.length) out.push([`Held in storage, not shipped (${held.length}): ${held.map((l) => `${l.sku}(${(l.produced || 0) - (l.shipped || 0)})`).join(', ')}`]);
  return out;
}

const FLAG_COLORS = {
  missing: { red: 0.96, green: 0.80, blue: 0.80 },
  short: { red: 0.98, green: 0.85, blue: 0.85 },
  extra: { red: 1, green: 0.90, blue: 0.75 },
  over: { red: 1, green: 0.95, blue: 0.80 },
  ok: { red: 0.85, green: 0.94, blue: 0.83 },
};

/**
 * Build the sheet matrix + formatting hints.
 * @returns { values: any[][], boldRows: number[], flagCells: {row,col,flag}[], anomalies }
 */
function buildReconcileRows(reconcile, resolve, dateStr, opts = {}) {
  const anomalies = summarizeAnomalies(reconcile, opts);
  const rows = [];
  const boldRows = [];
  const flagCells = [];
  const t = reconcile.totals;
  const NCOL = 8;
  const FLAG_COL = 6; // column G (0-based): SKU,Ord,Prod,Ship,Recv,Δ,Flag,Note

  boldRows.push(rows.length);
  rows.push([`Reconcile — ${reconcile.order.production_code} (as of ${dateStr}) · ordered ${t.ordered.toLocaleString()} / produced ${t.produced.toLocaleString()} / shipped ${(t.shipped ?? t.produced).toLocaleString()} / received ${t.received.toLocaleString()}`]);
  rows.push([]);
  boldRows.push(rows.length);
  rows.push(['SKU', 'Ordered', 'Produced', 'Shipped', 'Received', 'Δ', 'Flag', 'Note']);

  for (const g of groupLines(reconcile.lines, resolve)) {
    boldRows.push(rows.length);
    rows.push([g.color ? `${g.product} - ${g.color}` : g.product]);
    const first = rows.length + 1; // 1-based sheet row of first data line
    for (const l of g.lines) {
      const r = rows.length + 1;
      rows.push([l.sku, l.ordered, l.produced, l.shipped == null ? l.produced : l.shipped, l.received == null ? 0 : l.received, `=C${r}-B${r}`, l.flag.toUpperCase(), lotNote(l)]);
      flagCells.push({ row: rows.length - 1, col: FLAG_COL, flag: l.flag });
    }
    const last = first + g.lines.length - 1;
    boldRows.push(rows.length);
    rows.push(['', `=SUM(B${first}:B${last})`, `=SUM(C${first}:C${last})`, `=SUM(D${first}:D${last})`, `=SUM(E${first}:E${last})`, `=SUM(F${first}:F${last})`, '', '']);
    rows.push([]);
  }

  boldRows.push(rows.length);
  rows.push([
    'TOTAL',
    '=SUMIFS(B:B,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(C:C,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(D:D,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(E:E,A:A,"<>",A:A,"<>TOTAL")',
    '=SUMIFS(F:F,A:A,"<>",A:A,"<>TOTAL")',
    '', '',
  ]);

  rows.push([]);
  boldRows.push(rows.length);
  rows.push(['⚠ ANOMALIES']);
  for (const line of anomalyLines(anomalies)) rows.push(line);

  const quality = qualityLines(reconcile);
  if (quality.length) {
    rows.push([]);
    boldRows.push(rows.length);
    rows.push(['🎨 FABRIC / QUALITY (production issue)']);
    for (const line of quality) rows.push(line);
  }

  return { values: rows, boldRows, flagCells, anomalies, flagColors: FLAG_COLORS, ncol: NCOL };
}

module.exports = { buildReconcileRows, summarizeAnomalies, groupLines, sizeSort };
