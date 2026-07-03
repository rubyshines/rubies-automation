/**
 * Read access to the digitized tech-pack grading (tech_pack_specs) + consistency reporting.
 * Core logic behind the get_graded_specs / check_grading_consistency MCP tools.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { analyzeGrading } = require('./gradingConsistency');

// Current-version specs for a product (or all products if handle omitted).
async function fetchCurrentSpecs(productHandle) {
  const sb = getSupabaseClient();
  let q = sb
    .from('tech_pack_specs')
    .select('product_handle, size, pom_code, pom_name, target_cm, tolerance_cm, sort_order')
    .eq('is_current', true);
  if (productHandle) q = q.eq('product_handle', productHandle.toLowerCase());
  const { data, error } = await q
    .order('product_handle').order('sort_order').order('size');
  if (error) throw new Error(`fetchCurrentSpecs: ${error.message}`);
  return data || [];
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
