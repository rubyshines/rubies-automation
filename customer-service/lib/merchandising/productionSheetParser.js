/**
 * Production-order sheet read-back parser — the deterministic core of the "GO" step.
 *
 * Jamie edits quantities directly in the "2026 Production Numbers" Google Sheet, then says GO;
 * this parses that tab back into canonical {sku, qty} items (Supabase = source of truth) and
 * validates the founder's subtotals against the computed sums.
 *
 * Tolerates the real quirks seen in the sheet:
 *   - product/color headers like "THE AJ NO-TUCK SHAPING UNDERWEAR - BLK"
 *   - indented SKU rows ("    AJ-BLK-8,200")
 *   - subtotal rows as ",2980" (blank SKU col + number) OR a bare "515"
 *   - "*** ASK SUPPLIER ***" annotations inside a header
 *   - blank separator rows, a trailing "TOTAL,60" row
 *
 * Input: rows = array of rows, each row = array of cell values (as returned by the Google
 * Sheets values.get API). Pure function.
 */

// A SKU has a letter-led prefix then one or more hyphen segments: AJ-BLK-8, SKY2-BLK-3XLT,
// RUBY-BLK-XS1, MPAD-SND-S. No spaces (headers like "GAFF - BLK" have spaces -> not a SKU).
const SKU_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/i;

function cell(row, i) {
  const v = row && row[i] != null ? row[i] : '';
  return String(v).trim();
}

function isSku(s) {
  return SKU_RE.test(s);
}

function toInt(s) {
  if (s === '' || s == null) return null;
  const n = parseInt(String(s).replace(/,/g, '').trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function parseHeader(text) {
  // strip "*** ... ***" annotations and collapse whitespace
  const t = String(text).replace(/\*{2,}[^*]*\*{2,}/g, '').replace(/\s+/g, ' ').trim();
  const idx = t.lastIndexOf(' - ');
  if (idx !== -1) {
    return { product_name: t.slice(0, idx).trim(), color: t.slice(idx + 3).trim() };
  }
  return { product_name: t, color: '' };
}

function parseProductionSheet(rows) {
  const groups = [];
  const items = [];
  const warnings = [];
  let current = null;
  let declaredGrand = null;

  for (let i = 0; i < (rows || []).length; i++) {
    const c0 = cell(rows[i], 0);
    const c1 = cell(rows[i], 1);

    if (!c0 && !c1) continue; // blank separator

    // Item line: SKU + qty
    if (isSku(c0)) {
      const qty = toInt(c1);
      if (qty == null) {
        warnings.push(`Row ${i + 1}: SKU ${c0} has non-numeric qty "${c1}"`);
        continue;
      }
      if (!current) {
        current = { header: '(no header)', product_name: '', color: '', items: [] };
        groups.push(current);
        warnings.push(`Row ${i + 1}: SKU ${c0} appears before any product header`);
      }
      current.items.push({ sku: c0, qty });
      items.push({ sku: c0, qty, product_name: current.product_name, color: current.color });
      continue;
    }

    // Trailing grand-total row: "TOTAL,60"
    if (/^total$/i.test(c0)) {
      const gt = toInt(c1) != null ? toInt(c1) : toInt(c0 === 'TOTAL' ? '' : c0);
      if (gt != null) declaredGrand = gt;
      continue;
    }

    const c0num = toInt(c0);
    const c1num = toInt(c1);

    // Subtotal row: ",2980" (blank SKU + number) or a bare "515"
    if (!c0 && c1num != null) {
      if (current) current.subtotal_declared = c1num;
      else warnings.push(`Row ${i + 1}: subtotal ${c1num} before any product group`);
      continue;
    }
    if (c0num != null && !c1) {
      if (current) current.subtotal_declared = c0num;
      continue;
    }

    // Otherwise: a product/color header
    const { product_name, color } = parseHeader(c0 || c1);
    current = { header: (c0 || c1), product_name, color, items: [] };
    groups.push(current);
  }

  // Compute subtotals + validate against the founder's declared subtotals
  let computedGrand = 0;
  for (const g of groups) {
    g.subtotal_computed = g.items.reduce((s, it) => s + it.qty, 0);
    computedGrand += g.subtotal_computed;
    if (g.subtotal_declared != null) {
      g.subtotal_ok = g.subtotal_declared === g.subtotal_computed;
      if (!g.subtotal_ok) {
        warnings.push(`Subtotal mismatch for "${g.header}": sheet says ${g.subtotal_declared}, items sum to ${g.subtotal_computed}`);
      }
    }
  }
  if (declaredGrand != null && declaredGrand !== computedGrand) {
    warnings.push(`Grand-total mismatch: sheet says ${declaredGrand}, items sum to ${computedGrand}`);
  }

  return { groups, items, grand_total: computedGrand, declared_grand_total: declaredGrand, warnings };
}

module.exports = { parseProductionSheet, isSku, parseHeader };
