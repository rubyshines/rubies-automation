/**
 * QC results ingestion + review — the back half of Phase 4 (QC) of the
 * production pipeline.
 *
 *   ingestQcResults  — inspector's completed QC Master .xlsx -> qc_inspections
 *                      + per-sample qc_measurements with tolerance flags,
 *                      cross-validated against tech_pack_specs targets
 *   ingestQcReport   — inspector's AQL PDF report -> qc_issues (Opus extraction;
 *                      the PDF is free-form inspector prose, not a fixed grid)
 *   reviewProductionQc — pass/fail summary: out-of-tolerance POMs, AQL issues,
 *                      coverage vs the order's items
 *   approveProductionQc — Jamie's approval gate; releases due balance payments
 *
 * Supabase is canonical; the sheets/PDF are the interchange artifacts.
 */

const fs = require('fs');
const path = require('path');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { callClaude } = require('../../../shared/aiClient');
const { MODELS } = require('../../../shared/aiPricing');
const { loadCatalogSkus } = require('./skuCanonical');
const { parseQcWorkbook, flattenMeasurements } = require('./qcSheetParser');

// QC Master tab -> tech-pack handle(s). Sky's grading is split youth/adult, so
// the tab maps to both and the size picks the handle at validation time.
const TAB_HANDLES = {
  'AJ Underwear': 'aj',
  'Sassy Underwear': 'sassy',
  'Flo Dance Underwear': 'flo',
  'Charlie Underwear': 'charlie',
  'Brooke Bra': 'brooke',
  'Ava Seamless Bra': 'ava',
  'Evey Sports Bra': 'sportsbra',
  'Cami Top': 'cami',
  'Quinn Boxers': 'boxer',
  'Ruby Bikini Bottom': 'ruby',
  'Cheeky Bikini Bottom': 'cheeky',
  'Mia Halter Bikini Top': 'mia',
  'Sunny Tankini': 'tankini',
  'Serena Shorty Shorts': 'shorty',
  'Sky One Piece': ['sky_youth', 'sky_reg'],
};

// Tab -> catalog SKU prefix, where the sheet's labels don't match the catalog.
// Both the Ava and Evey tabs are labeled AVA-*; the catalog products are SB-*
// (Ava Seamless Bra) and SPB-* (Evey Sports Bra). Tab-scoped on purpose — a
// global AVA-> rule cannot disambiguate the two.
const TAB_PREFIX_OVERRIDES = {
  'Ava Seamless Bra': 'SB',
  'Evey Sports Bra': 'SPB',
};

const normName = (s) => String(s || '').toUpperCase().replace(/\(.*?\)/g, '').replace(/[^A-Z0-9]/g, '');

// Bidirectional size match: either side may be a combined alias ("16 / M").
function sizesOverlap(a, b) {
  const toks = (v) => String(v || '').toUpperCase().split(/[\/,]|\s+/).map((t) => t.trim()).filter(Boolean);
  const ta = toks(a);
  const tb = new Set(toks(b));
  return ta.some((t) => tb.has(t));
}

async function getOrderByCode(sb, production_code) {
  const { data, error } = await sb
    .from('production_orders')
    .select('id, production_code, supplier_id, status, placed_date')
    .eq('production_code', production_code)
    .maybeSingle();
  if (error) throw new Error(`production_orders lookup: ${error.message}`);
  if (!data) throw new Error(`No production order with production_code=${production_code}`);
  return data;
}

// One inspection row per (order, category); reused on re-ingest so the whole
// flow is idempotent.
async function upsertInspection(sb, { production_order_id, category, patch }) {
  const { data: existing, error: selErr } = await sb
    .from('qc_inspections')
    .select('id')
    .eq('production_order_id', production_order_id)
    .eq('category', category)
    .maybeSingle();
  if (selErr) throw new Error(`qc_inspections select: ${selErr.message}`);
  if (existing) {
    const { error } = await sb.from('qc_inspections').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', existing.id);
    if (error) throw new Error(`qc_inspections update: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await sb
    .from('qc_inspections')
    .insert({ production_order_id, category, ...patch })
    .select('id')
    .single();
  if (error) throw new Error(`qc_inspections insert: ${error.message}`);
  return data.id;
}

// Validate the sheet's Orig targets against the digitized grading. The sheet
// is the operative contract the inspector measured against; a drift from
// tech_pack_specs means one of the two is stale and Jamie should know which.
function validateAgainstSpecs(rows, specRows) {
  const specsByHandle = new Map();
  for (const r of specRows) {
    if (!specsByHandle.has(r.product_handle)) specsByHandle.set(r.product_handle, []);
    specsByHandle.get(r.product_handle).push(r);
  }
  const seen = new Set();
  const mismatches = [];
  const unmatched = [];
  for (const row of rows) {
    if (row.target_cm == null) continue;
    const key = `${row.tab}|${row.size}|${row.pom_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const handles = [].concat(TAB_HANDLES[row.tab] || []);
    if (!handles.length) { unmatched.push({ ...keyInfo(row), reason: 'no_tab_mapping' }); continue; }
    let spec = null;
    for (const h of handles) {
      const candidates = (specsByHandle.get(h) || []).filter((s) => sizesOverlap(s.size, row.size));
      spec = candidates.find((s) => String(s.pom_code).toUpperCase() === String(row.pom_code).toUpperCase())
        || candidates.find((s) => normName(s.pom_name) === normName(row.pom_name))
        || null;
      if (spec) break;
    }
    if (!spec) { unmatched.push({ ...keyInfo(row), reason: 'no_spec' }); continue; }
    const delta = Number((row.target_cm - spec.target_cm).toFixed(2));
    if (Math.abs(delta) > 0.05) {
      mismatches.push({ ...keyInfo(row), sheet_target: row.target_cm, spec_target: spec.target_cm, delta });
    }
  }
  return { mismatches, unmatched };

  function keyInfo(row) {
    return { tab: row.tab, size: row.size, pom_code: row.pom_code, pom_name: row.pom_name };
  }
}

function inferCategory(filePath) {
  const f = path.basename(filePath).toLowerCase();
  if (f.includes('swim')) return 'swimwear';
  if (f.includes('underwear')) return 'underwear';
  return null;
}

/**
 * Ingest a completed QC Master workbook for a production order.
 */
async function ingestQcResults({ file_path, production_code, category, inspector }) {
  if (!fs.existsSync(file_path)) throw new Error(`File not found: ${file_path}`);
  const cat = category || inferCategory(file_path);
  if (!cat) throw new Error('category is required (could not infer swimwear/underwear from the filename)');

  const sb = getSupabaseClient();
  const order = await getOrderByCode(sb, production_code);
  const catalog = await loadCatalogSkus();
  const parsed = parseQcWorkbook(file_path);
  const { rows, remapped, unknown } = flattenMeasurements(parsed, { catalog, expectedPrefixByTab: TAB_PREFIX_OVERRIDES });
  const measured = rows.filter((r) => r.measured_cm != null);

  // Validate every sheet target (not just measured ones) against the grading.
  const validationRows = [];
  for (const tab of parsed.tabs) {
    for (const b of tab.blocks) {
      for (const p of b.pom_rows) {
        if (p.target_cm != null) {
          validationRows.push({ tab: tab.tab, size: b.size_label, pom_code: p.pom_code, pom_name: p.pom_name, target_cm: p.target_cm });
        }
      }
    }
  }
  const specRows = await fetchAllCurrentSpecs();
  const { mismatches, unmatched } = validateAgainstSpecs(validationRows, specRows);

  const inspectionId = await upsertInspection(sb, {
    production_order_id: order.id,
    category: cat,
    patch: {
      status: 'completed',
      completed_at: new Date().toISOString(),
      inspector: inspector || null,
      sheet_url: file_path,
    },
  });

  for (let i = 0; i < measured.length; i += 500) {
    const batch = measured.slice(i, i + 500).map((r) => ({
      qc_inspection_id: inspectionId,
      sku: r.sku,
      size: r.size,
      color: r.color,
      pom_code: r.pom_code,
      sample_number: r.sample_number,
      measured_cm: r.measured_cm,
      target_cm: r.target_cm,
      tolerance_cm: r.tolerance_cm,
      diff_cm: r.diff_cm,
      in_tolerance: r.in_tolerance,
    }));
    const { error } = await sb.from('qc_measurements').upsert(batch, { onConflict: 'qc_inspection_id,sku,color,pom_code,sample_number' });
    if (error) throw new Error(`qc_measurements upsert: ${error.message}`);
  }

  const outOfTolerance = measured.filter((r) => r.in_tolerance === false);
  const nonCmTabs = parsed.tabs
    .filter((t) => t.unit !== 'cm' && t.blocks.some((b) => b.pom_rows.some((p) => p.samples.length)))
    .map((t) => `${t.tab} (${t.unit})`);
  return {
    inspection_id: inspectionId,
    order,
    category: cat,
    tabs: parsed.tabs.map((t) => t.tab),
    measurements: measured.length,
    out_of_tolerance: outOfTolerance,
    skus_measured: [...new Set(measured.map((r) => r.sku))],
    remapped: dedupeBy(remapped, (r) => `${r.tab}|${r.from}|${r.to}`),
    unknown_skus: dedupeBy(unknown, (r) => `${r.tab}|${r.sku_label}|${r.color}`),
    spec_mismatches: mismatches,
    spec_unmatched_count: unmatched.length,
    non_cm_tabs: nonCmTabs,
  };
}

async function fetchAllCurrentSpecs() {
  // fetchCurrentSpecs isn't paginated (fine per-product, not for all 1,700 rows).
  const sb = getSupabaseClient();
  const out = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('tech_pack_specs')
      .select('product_handle, size, pom_code, pom_name, target_cm, tolerance_cm')
      .eq('is_current', true)
      .range(from, from + 999);
    if (error) throw new Error(`tech_pack_specs: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Ingest the inspector's AQL PDF report -> qc_issues. The PDF is free-form
 * inspector prose (per-product findings, AQL math, pass/fail), so extraction
 * is an Opus job, per AI-first architecture. Issues attach to the inspection
 * whose category the product belongs to.
 */
async function ingestQcReport({ file_path, production_code }) {
  if (!fs.existsSync(file_path)) throw new Error(`File not found: ${file_path}`);
  const sb = getSupabaseClient();
  const order = await getOrderByCode(sb, production_code);

  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: fs.readFileSync(file_path) });
  const { text } = await parser.getText();

  const extraction = await extractReport(text);

  // Map each product to its inspection via the QC Master tab it appears on.
  const { data: inspections, error: insErr } = await sb
    .from('qc_inspections')
    .select('id, category')
    .eq('production_order_id', order.id);
  if (insErr) throw new Error(`qc_inspections: ${insErr.message}`);
  if (!inspections.length) throw new Error(`No qc_inspections for ${production_code} — ingest the QC Master .xlsx first`);
  const byCategory = Object.fromEntries(inspections.map((i) => [i.category, i.id]));
  const fallbackId = inspections[0].id;

  const written = [];
  for (const p of extraction.products) {
    const inspectionId = byCategory[p.category] || fallbackId;
    const conclusion = `AQL ${p.aql ?? '2.5'} · sampled ${p.sampling_size ?? '?'} · majors ${p.majors ?? 0} / minors ${p.minors ?? 0} · ${p.passed ? 'PASSED' : 'FAILED'}`;
    const issues = (p.findings && p.findings.length ? p.findings : [{ description: 'No defects found', severity: 'info' }])
      .map((f) => ({
        qc_inspection_id: inspectionId,
        sku: null,
        pom_code: null,
        severity: p.passed ? (f.severity || 'minor') : 'major',
        description: `[${p.product_name}] ${f.description} — ${conclusion}`,
        status: p.passed ? 'resolved' : 'open',
        resolution: p.passed ? 'Within AQL — passed inspection' : null,
      }));
    for (const issue of issues) {
      // qc_issues has no natural key; dedupe on (inspection, description).
      const { data: existing } = await sb
        .from('qc_issues')
        .select('id')
        .eq('qc_inspection_id', issue.qc_inspection_id)
        .eq('description', issue.description)
        .maybeSingle();
      if (existing) continue;
      const { error } = await sb.from('qc_issues').insert(issue);
      if (error) throw new Error(`qc_issues insert: ${error.message}`);
      written.push(issue);
    }
  }

  if (extraction.packing_status && !/finished|complete/i.test(extraction.packing_status)) {
    const desc = `[Packing] ${extraction.packing_status}`;
    const { data: existing } = await sb.from('qc_issues').select('id').eq('qc_inspection_id', fallbackId).eq('description', desc).maybeSingle();
    if (!existing) {
      const { error } = await sb.from('qc_issues').insert({ qc_inspection_id: fallbackId, severity: 'minor', description: desc, status: 'open' });
      if (error) throw new Error(`qc_issues insert: ${error.message}`);
      written.push({ description: desc });
    }
  }

  return { order, products: extraction.products, packing_status: extraction.packing_status, issues_written: written.length };
}

async function extractReport(text) {
  const tabNames = Object.keys(TAB_HANDLES);
  const response = await callClaude({
    component: 'qc_report_ingest',
    model: MODELS.OPUS,
    max_tokens: 4000,
    tools: [{
      name: 'record_extraction',
      description: 'Record the structured extraction of the QC inspection report',
      input_schema: {
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_name: { type: 'string', description: `Canonical product name — one of: ${tabNames.join(', ')}` },
                category: { type: 'string', enum: ['underwear', 'swimwear'] },
                findings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      description: { type: 'string', description: 'One finding, e.g. "2pcs threads not trimmed well"' },
                      severity: { type: 'string', enum: ['major', 'minor'] },
                    },
                    required: ['description', 'severity'],
                  },
                },
                aql: { type: 'string' },
                sampling_size: { type: 'integer' },
                majors: { type: 'number' },
                minors: { type: 'number' },
                passed: { type: 'boolean' },
              },
              required: ['product_name', 'category', 'findings', 'passed'],
            },
          },
          packing_status: { type: 'string', description: 'The packing section status, e.g. "Unfinished"' },
        },
        required: ['products'],
      },
    }],
    tool_choice: { type: 'tool', name: 'record_extraction' },
    messages: [{
      role: 'user',
      content: `Extract every product's inspection result from this third-party QC report. Classify each finding's severity from the report's own AQL math (it states majors/minors per product). Underwear products: AJ, Sassy, Flo Dance, Charlie, Brooke Bra, Ava Seamless Bra, Evey Sports Bra, Cami Top, Quinn Boxers. Swimwear: Ruby Bikini Bottom, Cheeky Bikini Bottom, Mia Halter Bikini Top, Sunny Tankini, Serena Shorty Shorts, Sky One Piece. Use the canonical product names given in the schema.\n\n<report>\n${text}\n</report>`,
    }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('qc report extraction returned no structured output');
  return toolUse.input;
}

/**
 * Summarize QC for an order: measurement pass/fail by product/POM, AQL issues,
 * and coverage vs the order's line items.
 */
async function reviewProductionQc({ production_code }) {
  const sb = getSupabaseClient();
  const order = await getOrderByCode(sb, production_code);

  const { data: inspections, error: insErr } = await sb
    .from('qc_inspections')
    .select('id, category, status, inspector, completed_at, approved_at, approved_by, sheet_url')
    .eq('production_order_id', order.id);
  if (insErr) throw new Error(`qc_inspections: ${insErr.message}`);

  const measurements = [];
  for (const ins of inspections) {
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from('qc_measurements')
        .select('sku, size, color, pom_code, sample_number, measured_cm, target_cm, tolerance_cm, diff_cm, in_tolerance')
        .eq('qc_inspection_id', ins.id)
        .range(from, from + 999);
      if (error) throw new Error(`qc_measurements: ${error.message}`);
      data.forEach((m) => measurements.push({ ...m, category: ins.category }));
      if (data.length < 1000) break;
      from += 1000;
    }
  }

  const { data: issues, error: issErr } = await sb
    .from('qc_issues')
    .select('qc_inspection_id, severity, description, status, resolution')
    .in('qc_inspection_id', inspections.map((i) => i.id));
  if (issErr) throw new Error(`qc_issues: ${issErr.message}`);

  const { data: items, error: itemErr } = await sb
    .from('production_order_items')
    .select('sku, qty_ordered')
    .eq('production_order_id', order.id);
  if (itemErr) throw new Error(`production_order_items: ${itemErr.message}`);

  // Group out-of-tolerance measurements by product prefix + POM + size.
  const oot = measurements.filter((m) => m.in_tolerance === false);
  const groups = new Map();
  for (const m of oot) {
    const prefix = m.sku.split('-')[0];
    const key = `${prefix}|${m.pom_code}|${m.size}`;
    if (!groups.has(key)) groups.set(key, { prefix, pom_code: m.pom_code, size: m.size, tolerance_cm: m.tolerance_cm, samples: 0, worst_diff: 0, skus: new Set() });
    const g = groups.get(key);
    g.samples += 1;
    g.skus.add(m.sku);
    if (Math.abs(m.diff_cm) > Math.abs(g.worst_diff)) g.worst_diff = m.diff_cm;
  }
  const ootGroups = [...groups.values()]
    .map((g) => ({ ...g, skus: [...g.skus] }))
    .sort((a, b) => Math.abs(b.worst_diff) / (b.tolerance_cm || 1) - Math.abs(a.worst_diff) / (a.tolerance_cm || 1));

  // Coverage: which ordered products were sampled at all.
  const orderedPrefixes = new Set(items.map((i) => i.sku.split('-')[0]));
  const measuredPrefixes = new Set(measurements.map((m) => m.sku.split('-')[0]));
  const notSampled = [...orderedPrefixes].filter((p) => !measuredPrefixes.has(p));
  const sampledNotOrdered = [...measuredPrefixes].filter((p) => !orderedPrefixes.has(p));

  return {
    order,
    inspections,
    totals: {
      measurements: measurements.length,
      out_of_tolerance: oot.length,
      skus_measured: new Set(measurements.map((m) => m.sku)).size,
      ordered_skus: items.length,
    },
    oot_groups: ootGroups,
    issues: issues || [],
    coverage: { ordered_prefixes: [...orderedPrefixes], not_sampled: notSampled, sampled_not_ordered: sampledNotOrdered },
  };
}

/**
 * Approve QC for an order (per category or all). Releases due balance
 * payments in the summary so Jamie knows what's now payable.
 */
async function approveProductionQc({ production_code, category, approved_by = 'Jamie' }) {
  const sb = getSupabaseClient();
  const order = await getOrderByCode(sb, production_code);

  let q = sb
    .from('qc_inspections')
    .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by, updated_at: new Date().toISOString() })
    .eq('production_order_id', order.id);
  if (category) q = q.eq('category', category);
  const { data: updated, error } = await q.select('id, category, status');
  if (error) throw new Error(`qc_inspections approve: ${error.message}`);
  if (!updated.length) throw new Error(`No qc_inspections to approve for ${production_code}${category ? ` (${category})` : ''}`);

  const { data: payments } = await sb
    .from('production_payments')
    .select('id, type, pct, amount, currency, due_event, status')
    .eq('production_order_id', order.id)
    .eq('status', 'due');

  return { order, approved: updated, due_payments: payments || [] };
}

module.exports = {
  TAB_HANDLES,
  TAB_PREFIX_OVERRIDES,
  validateAgainstSpecs,
  inferCategory,
  ingestQcResults,
  ingestQcReport,
  reviewProductionQc,
  approveProductionQc,
};
