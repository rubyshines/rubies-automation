/**
 * Read access to the digitized tech-pack grading (tech_pack_specs) + consistency reporting.
 * Core logic behind the get_graded_specs / check_grading_consistency MCP tools.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { analyzeGrading } = require('./gradingConsistency');

const PAGE = 1000;

// Current-version specs for a product (or all products if handle omitted).
// Paginated: the table is past Supabase's 1000-row default, so an unpaginated
// read silently dropped whole products (8 of 19 as of 2026-08-11, including
// the Sassy and Stella) from both get_graded_specs and the consistency check.
async function fetchCurrentSpecs(productHandle) {
  const sb = getSupabaseClient();
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb
      .from('tech_pack_specs')
      .select('product_handle, size, pom_code, pom_name, target_cm, tolerance_cm, sort_order')
      .eq('is_current', true);
    if (productHandle) q = q.eq('product_handle', productHandle.toLowerCase());
    const { data, error } = await q
      .order('product_handle').order('sort_order').order('size')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchCurrentSpecs: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// rows -> { handle: { pom_code: { pom_name, tolerance_cm, sizes: { size: target_cm } } } }
function reshape(rows) {
  const out = {};
  for (const r of rows) {
    if (!out[r.product_handle]) out[r.product_handle] = {};
    if (!out[r.product_handle][r.pom_code]) {
      out[r.product_handle][r.pom_code] = { pom_name: r.pom_name, tolerance_cm: r.tolerance_cm, sizes: {} };
    }
    out[r.product_handle][r.pom_code].sizes[r.size] = r.target_cm;
  }
  return out;
}

// True if `requested` matches a stored size, including combined aliases like "16 / M".
function sizeMatches(stored, requested) {
  const want = String(requested).trim().toUpperCase();
  const s = String(stored).trim().toUpperCase();
  if (s === want) return true;
  return s.split(/[\/,]|\s+/).map(t => t.trim()).filter(Boolean).includes(want);
}

async function getGradedSpecs({ product_handle, size }) {
  const rows = await fetchCurrentSpecs(product_handle);
  const filtered = size ? rows.filter(r => sizeMatches(r.size, size)) : rows;
  return { rows: filtered, byProduct: reshape(filtered) };
}

async function checkGradingConsistency({ product_handle }) {
  const rows = await fetchCurrentSpecs(product_handle);
  return analyzeGrading(reshape(rows));
}

module.exports = { fetchCurrentSpecs, reshape, sizeMatches, getGradedSpecs, checkGradingConsistency };
