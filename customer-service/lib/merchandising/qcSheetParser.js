/**
 * Parse the third-party inspector's QC Master workbook (.xlsx) into per-sample
 * measurements.
 *
 * Sheet geometry (one tab per product): size blocks laid out in a grid — rows of
 * bands, 3-5 blocks across. Each block is anchored by an "Orig" cell in a header
 * row whose column A reads "POM #":
 *
 *   row H-3   Size 12 / XS                 (size label, at the anchor column)
 *   row H-2   AJ-BLK-12 / AJ-BLK-XS        (SKU label(s) — always written in BLK)
 *   row H-1        BLK BLK BLK PNK PNK …   (color of each sample column)
 *   row H     POM# | Spec | Tolerance | … | Orig | 1 | 2 | … | Diff | …
 *   row H+1.. one row per POM: code, name, "+/-0.75", then per-block target +
 *             sample measurements. Tolerance (col C) is shared across the band.
 *
 * Anchor columns vary per tab (E/Q/AC vs E/N/W vs D/P/AB …) and sample-column
 * count varies with the tab's colors × samples-per-color, so all geometry is
 * detected from the header row, never assumed.
 *
 * SKU resolution is catalog-validated (same rule as the packing-list parser):
 * a label is remapped only when the result exists in product_variants — we never
 * invent a SKU. Labels are per-color templates ("AJ-BLK-12" measured in PNK →
 * AJ-PNK-12), and remapping is TAB-scoped via expectedPrefix because the same
 * label prefix can belong to different products on different tabs (both the Ava
 * and Evey tabs are labeled AVA-*; the catalog products are SB-* and SPB-*).
 */

const XLSX = require('xlsx');
const { canonicalizeSku } = require('./skuCanonical');

// "+/-0.75", "±1", "+/- 1.25" -> 0.75 / 1 / 1.25 (null when unparseable)
function parseTolerance(raw) {
  const m = String(raw == null ? '' : raw).match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

// "AJ-BLK-12 / AJ-BLK-XS" | "AJ-BLK-14, AJ-BLK-M" -> [{prefix, color, size}, …]
function splitSkuLabel(label) {
  return String(label || '')
    .split(/[\/,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^([A-Z0-9]+)-([A-Z]+)-(.+)$/i);
      return m ? { prefix: m[1].toUpperCase(), color: m[2].toUpperCase(), size: m[3].trim().toUpperCase() } : null;
    })
    .filter(Boolean);
}

// "Size 12 / XS" -> "12 / XS"
function parseSizeLabel(raw) {
  return String(raw || '').replace(/^size\s*/i, '').trim();
}

/**
 * Parse one tab into blocks of POM rows with per-sample measurements.
 * Pure grid walk — no catalog, no DB.
 */
function parseSheet(ws, tabName) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const str = (v) => (v == null ? '' : String(v).trim());
  const blocks = [];

  // Unit note, e.g. "Note measurements are in cms" / "… in inches" (seen on the
  // real Sunny Tankini tab). Default cm when absent.
  let unit = 'cm';
  for (const row of rows.slice(0, 3)) {
    for (const cell of row || []) {
      const m = String(cell || '').match(/measurements?\s+are\s+in\s+(\w+)/i);
      if (m) unit = /inch/i.test(m[1]) ? 'inches' : 'cm';
    }
  }

  rows.forEach((row, ri) => {
    if (str(row[0]) !== 'POM #') return;
    const sizeRow = rows[ri - 3] || [];
    const skuRow = rows[ri - 2] || [];
    const colorRow = rows[ri - 1] || [];

    // Anchors: every "Orig" in this header row; samples run until "Diff".
    row.forEach((cell, ci) => {
      if (str(cell) !== 'Orig') return;
      const sampleCols = [];
      for (let j = ci + 1; j < row.length; j++) {
        const h = str(row[j]);
        if (h === 'Diff') break;
        if (/^\d+$/.test(h)) sampleCols.push({ col: j, sample_number: Number(h), color: str(colorRow[j]).toUpperCase() || null });
      }
      if (!sampleCols.length) return;

      const block = {
        tab: tabName,
        size_label: parseSizeLabel(sizeRow[ci]),
        sku_label: str(skuRow[ci]),
        sku_variants: splitSkuLabel(skuRow[ci]),
        pom_rows: [],
      };

      // POM rows follow the header until a blank POM cell / next header.
      for (let r = ri + 1; r < rows.length; r++) {
        const pr = rows[r] || [];
        const code = str(pr[0]);
        if (!code || code === 'POM #') break;
        const target = typeof pr[ci] === 'number' ? pr[ci] : null;
        const samples = sampleCols
          .filter((sc) => typeof pr[sc.col] === 'number')
          .map((sc) => ({ sample_number: sc.sample_number, color: sc.color, measured_cm: pr[sc.col] }));
        block.pom_rows.push({
          pom_code: code,
          pom_name: str(pr[1]),
          tolerance_cm: parseTolerance(pr[2]),
          target_cm: target,
          samples,
        });
      }
      if (block.pom_rows.length) blocks.push(block);
    });
  });

  return { tab: tabName, unit, blocks };
}

function parseQcWorkbook(filePath) {
  const wb = XLSX.readFile(filePath);
  return { tabs: wb.SheetNames.map((n) => parseSheet(wb.Sheets[n], n)) };
}

/**
 * Resolve the catalog SKU for one block + color.
 * Tries every label variant (and the block's size label as a fallback size),
 * with the tab's expected prefix substituted, and returns the first candidate
 * that exists in the catalog (exact or via the plus-size alias rule).
 */
function resolveSku(block, color, { expectedPrefix, catalog }) {
  const variants = block.sku_variants.length ? block.sku_variants : [];
  const sizes = [];
  for (const v of variants) sizes.push(v.size);
  for (const tok of block.size_label.split(/[\/,]/)) {
    const s = tok.trim().toUpperCase();
    if (s && !sizes.includes(s)) sizes.push(s);
  }
  const prefix = expectedPrefix || (variants[0] && variants[0].prefix) || null;
  if (!prefix || !sizes.length) return { sku: null, matched: 'unparseable' };

  const tried = [];
  for (const size of sizes) {
    const candidate = `${prefix}-${color}-${size}`;
    tried.push(candidate);
    const res = canonicalizeSku(candidate, catalog);
    if (res.matched !== 'unknown') {
      const labelSku = variants[0] ? `${variants[0].prefix}-${color}-${variants[0].size}` : candidate;
      const canonicalSize = res.sku.split('-').slice(2).join('-');
      return { sku: res.sku, size: canonicalSize, matched: res.matched, original: res.sku === labelSku ? undefined : labelSku };
    }
  }
  // Nothing resolved — keep the first candidate so nothing is silently dropped.
  return { sku: tried[0], size: sizes[0], matched: 'unknown', tried };
}

/**
 * Flatten a parsed workbook into per-sample measurement rows with tolerance
 * flags, resolving SKUs against the catalog. Pure — catalog is a Set,
 * expectedPrefixByTab maps tab name -> catalog prefix override.
 *
 * Returns { rows, remapped, unknown } where rows carry:
 *   tab, sku, size, color, pom_code, pom_name, sample_number,
 *   measured_cm, target_cm, tolerance_cm, diff_cm, in_tolerance, sku_matched
 */
function flattenMeasurements(parsed, { catalog, expectedPrefixByTab = {} } = {}) {
  const rows = [];
  const remapped = [];
  const unknown = [];

  for (const tab of parsed.tabs) {
    const expectedPrefix = expectedPrefixByTab[tab.tab] || null;
    for (const block of tab.blocks) {
      const skuByColor = new Map();
      for (const pom of block.pom_rows) {
        for (const s of pom.samples) {
          if (!s.color) continue;
          if (!skuByColor.has(s.color)) {
            const res = resolveSku(block, s.color, { expectedPrefix, catalog });
            skuByColor.set(s.color, res);
            if (res.matched === 'alias' || (res.original && res.matched === 'exact')) {
              remapped.push({ tab: tab.tab, from: res.original, to: res.sku });
            }
            if (res.matched === 'unknown' || res.matched === 'unparseable') {
              unknown.push({ tab: tab.tab, sku_label: block.sku_label, color: s.color, candidate: res.sku || null });
            }
          }
          const res = skuByColor.get(s.color);
          if (!res.sku) continue;
          const diff = pom.target_cm == null ? null : Number((s.measured_cm - pom.target_cm).toFixed(2));
          const inTol = diff == null || pom.tolerance_cm == null
            ? null
            : Math.abs(diff) <= pom.tolerance_cm + 1e-9;
          rows.push({
            tab: tab.tab,
            sku: res.sku,
            size: res.size || block.size_label,
            color: s.color,
            pom_code: pom.pom_code,
            pom_name: pom.pom_name,
            sample_number: s.sample_number,
            measured_cm: s.measured_cm,
            target_cm: pom.target_cm,
            tolerance_cm: pom.tolerance_cm,
            diff_cm: diff,
            in_tolerance: inTol,
            sku_matched: res.matched,
          });
        }
      }
    }
  }
  return { rows, remapped, unknown };
}

module.exports = { parseTolerance, splitSkuLabel, parseSizeLabel, parseSheet, parseQcWorkbook, resolveSku, flattenMeasurements };
