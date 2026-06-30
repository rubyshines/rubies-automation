/**
 * Canonicalize supplier SKU codes to real catalog (Shopify/Warehance) SKUs.
 *
 * Kali's packing lists code the plus sizes as "{n}X" / "{n}XT" (e.g. AJ-BLK-1X,
 * SKY2-BLK-2XT) while the catalog uses "XL/2XL/3XL/4XL" (+ a "T" tall suffix).
 * We do NOT trust the transform blindly: a supplier SKU is remapped only when the
 * transformed code actually exists in `product_variants`. Anything that resolves to
 * no real SKU is returned as `unknown` for a human to look at — we never invent a SKU.
 *
 * This is the one place the alias rule lives. It's a deterministic mechanical lookup
 * (a code translation validated against the catalog), which is exactly the kind of
 * thing that belongs in code rather than the model.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

/**
 * Load the set of real catalog SKUs from product_variants (paginated).
 * @returns {Promise<Set<string>>}
 */
async function loadCatalogSkus() {
  const sb = getSupabaseClient();
  const skus = new Set();
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await sb.from('product_variants').select('sku').range(from, from + page - 1);
    if (error) throw new Error(`loadCatalogSkus: ${error.message}`);
    for (const r of data) if (r.sku) skus.add(r.sku);
    if (data.length < page) break;
    from += page;
  }
  return skus;
}

// Supplier "{n}X" plus-size code -> catalog "{n}XL" (and "1X" -> "XL"), preserving a
// trailing "T" (tall). Returns null when the size segment isn't a plus-size code.
function aliasCandidate(sku) {
  const segs = String(sku || '').split('-');
  if (segs.length < 3) return null;
  const size = segs.slice(2).join('-');
  const m = size.match(/^(\d)X(T?)$/i);
  if (!m) return null;
  const digit = m[1];
  const tall = m[2] ? m[2].toUpperCase() : '';
  const newSize = digit === '1' ? `XL${tall}` : `${digit}XL${tall}`;
  return [...segs.slice(0, 2), newSize].join('-');
}

/**
 * Resolve one supplier SKU against the catalog.
 * @returns {{sku, matched: 'exact'|'alias'|'unknown', original?, candidate?}}
 */
function canonicalizeSku(sku, catalog) {
  if (catalog.has(sku)) return { sku, matched: 'exact' };
  const cand = aliasCandidate(sku);
  if (cand && catalog.has(cand)) return { sku: cand, original: sku, matched: 'alias' };
  return { sku, matched: 'unknown', candidate: cand || null };
}

/**
 * Canonicalize a list of {sku, qty} lines. Lines that collapse to the same canonical
 * SKU are merged (qty summed). Unknown SKUs are kept (so nothing is silently dropped)
 * and listed separately for review.
 * @returns {{ items: {sku, qty, matched, original?}[], remapped: object[], unknown: object[] }}
 */
function canonicalizeItems(lines, catalog) {
  const merged = new Map(); // canonical sku -> { sku, qty, matched, original? }
  const remapped = [];
  const unknown = [];
  for (const line of lines) {
    const res = canonicalizeSku(line.sku, catalog);
    if (res.matched === 'alias') remapped.push({ from: res.original, to: res.sku, qty: line.qty });
    if (res.matched === 'unknown') unknown.push({ sku: line.sku, qty: line.qty, candidate: res.candidate });
    const key = res.sku;
    if (merged.has(key)) {
      merged.get(key).qty += line.qty;
    } else {
      merged.set(key, { sku: res.sku, qty: line.qty, matched: res.matched, ...(res.original ? { original: res.original } : {}) });
    }
  }
  return { items: [...merged.values()], remapped, unknown };
}

module.exports = { loadCatalogSkus, canonicalizeSku, canonicalizeItems, aliasCandidate };
