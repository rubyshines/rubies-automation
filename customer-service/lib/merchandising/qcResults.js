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
// specRows -> lookup fn: ({tab, size, pom_code, pom_name}) -> spec row | null.
// Matches by pom_code first, then normalized name (sheet and spec POM-code
// conventions drift per product: AJ numeric↔numeric, Sassy numeric↔letters).
function buildSpecLookup(specRows) {
  const specsByHandle = new Map();
  for (const r of specRows) {
    if (!specsByHandle.has(r.product_handle)) specsByHandle.set(r.product_handle, []);
    specsByHandle.get(r.product_handle).push(r);
  }
  return (row) => {
    const handles = [].concat(TAB_HANDLES[row.tab] || []);
    for (const h of handles) {
      const candidates = (specsByHandle.get(h) || []).filter((s) => sizesOverlap(s.size, row.size));
      const spec = candidates.find((s) => String(s.pom_code).toUpperCase() === String(row.pom_code).toUpperCase())
        || candidates.find((s) => normName(s.pom_name) === normName(row.pom_name))
        || null;
      if (spec) return spec;
    }
    return null;
  };
}

function validateAgainstSpecs(rows, specRows) {
  const lookup = buildSpecLookup(specRows);
  const seen = new Set();
  const mismatches = [];
  const unmatched = [];
  for (const row of rows) {
    if (row.target_cm == null) continue;
    const key = `${row.tab}|${row.size}|${row.pom_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (![].concat(TAB_HANDLES[row.tab] || []).length) { unmatched.push({ ...keyInfo(row), reason: 'no_tab_mapping' }); continue; }
    const spec = lookup(row);
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
    model: 'claude-opus-4-6',
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

// --- QC review tab (founder's decision surface) --------------------------------

// Parse "[Product] finding — AQL 2.5 · sampled 50 · majors 7 / minors 4 · FAILED"
// back into structured AQL results (the format ingestQcReport writes).
function parseAqlIssues(issues) {
  const byProduct = new Map();
  for (const i of issues) {
    const m = String(i.description).match(/^\[([^\]]+)\]\s*(.*?)(?:\s*—\s*AQL.*?majors\s*([\d.]+)\s*\/\s*minors\s*([\d.]+).*?(PASSED|FAILED))?$/i);
    if (!m || m[1] === 'Packing') continue;
    const [, product, finding, majors, minors, verdict] = m;
    if (!byProduct.has(product)) byProduct.set(product, { product_name: product, findings: [], majors: 0, minors: 0, passed: true });
    const p = byProduct.get(product);
    if (finding && !/^No defects found$/i.test(finding.trim())) p.findings.push(finding.trim());
    if (majors != null) p.majors = Number(majors);
    if (minors != null) p.minors = Number(minors);
    if (verdict) p.passed = verdict.toUpperCase() === 'PASSED';
  }
  return [...byProduct.values()].sort((a, b) => Number(a.passed) - Number(b.passed) || a.product_name.localeCompare(b.product_name));
}

/**
 * Assemble everything the review tab needs. Re-parses the QC workbooks (paths
 * from the inspections' sheet_url, or file_paths override) to recover POM names,
 * sample detail and spec targets — pure recompute of the ingest pass; Supabase
 * stays canonical for issues/coverage and is cross-checked for drift.
 */
async function assembleQcReview({ production_code, file_paths }) {
  const review = await reviewProductionQc({ production_code });

  const paths = file_paths && file_paths.length
    ? file_paths
    : review.inspections.map((i) => i.sheet_url).filter(Boolean);
  if (!paths.length) throw new Error('No QC workbook paths on file — pass file_paths');
  const missing = paths.filter((p) => !fs.existsSync(p));
  if (missing.length) throw new Error(`QC workbook file(s) moved since ingest — pass file_paths. Missing: ${missing.join(', ')}`);

  const catalog = await loadCatalogSkus();
  const specLookup = buildSpecLookup(await fetchAllCurrentSpecs());

  const allRows = [];
  for (const p of paths) {
    const parsed = parseQcWorkbook(p);
    const { rows } = flattenMeasurements(parsed, { catalog, expectedPrefixByTab: TAB_PREFIX_OVERRIDES });
    allRows.push(...rows.filter((r) => r.measured_cm != null));
  }

  // Drift guard: the tab is built from the files; the DB is what was ingested.
  const parseOot = allRows.filter((r) => r.in_tolerance === false).length;
  const drift = parseOot !== review.totals.out_of_tolerance
    ? `workbook parse found ${parseOot} out-of-tolerance vs ${review.totals.out_of_tolerance} in Supabase — file changed since ingest? Re-run ingest_qc_results.`
    : null;

  const groups = new Map();
  for (const r of allRows.filter((x) => x.in_tolerance === false)) {
    const key = `${r.tab}|${r.pom_code}|${r.size}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: groups.size + 1,
        product: r.tab, tab: r.tab, size: r.size, pom_code: r.pom_code, pom_name: r.pom_name,
        tolerance_cm: r.tolerance_cm, sheet_target: r.target_cm,
        spec_target: (specLookup(r) || {}).target_cm ?? null,
        samples: [], worst_diff: 0,
      });
    }
    const g = groups.get(key);
    g.samples.push({ color: r.color, measured_cm: r.measured_cm, diff_cm: r.diff_cm });
    if (Math.abs(r.diff_cm) > Math.abs(g.worst_diff)) g.worst_diff = r.diff_cm;
  }
  const sorted = [...groups.values()].sort(
    (a, b) => Math.abs(b.worst_diff) / (b.tolerance_cm || 1) - Math.abs(a.worst_diff) / (a.tolerance_cm || 1)
  );

  return {
    order: review.order,
    totals: review.totals,
    inspections: review.inspections,
    inspector: review.inspections.map((i) => i.inspector).find(Boolean) || null,
    aql: parseAqlIssues(review.issues),
    packing_status: (review.issues.find((i) => i.description.startsWith('[Packing]')) || {}).description?.replace('[Packing] ', '') || null,
    coverage: review.coverage,
    groups: sorted,
    drift,
  };
}

/**
 * Opus triage of the flagged groups: is each one a real garment deviation, a
 * stale sheet target (the digitized spec + measurements agree, the sheet Orig
 * doesn't), or a data-entry suspect (implausible value)? Judgment call -> AI,
 * with the deterministic facts as input.
 */
async function triageQcGroups(review, { batchSize = 25 } = {}) {
  if (!review.groups.length) return {};
  const payload = review.groups.map((g) => ({
    id: g.id,
    product: g.product,
    size: g.size,
    pom: `${g.pom_code} ${g.pom_name || ''}`.trim(),
    tolerance: g.tolerance_cm,
    sheet_target: g.sheet_target,
    digitized_spec_target: g.spec_target,
    samples: g.samples.map((s) => s.measured_cm),
    worst_diff_vs_sheet_target: g.worst_diff,
  }));
  const aqlContext = review.aql.map((p) => `${p.product_name}: ${p.passed ? 'passed' : 'FAILED'}${p.findings.length ? ` — ${p.findings.join('; ')}` : ''}`).join('\n');

  // Batched + retried: one big call proved fragile on a flaky uplink, and an
  // order can have arbitrarily many flagged groups.
  const verdicts = {};
  for (let i = 0; i < payload.length; i += batchSize) {
    const chunk = payload.slice(i, i + batchSize);
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        Object.assign(verdicts, await triageBatch(chunk, aqlContext));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
    if (lastErr) throw lastErr;
  }
  return verdicts;
}

async function triageBatch(chunk, aqlContext) {
  const response = await callClaude({
    component: 'qc_review_triage',
    model: 'claude-opus-4-6',
    max_tokens: 4000,
    stream: true,
    streamStallMs: 90000,
    tools: [{
      name: 'record_triage',
      description: 'Record the triage verdict for every flagged group',
      input_schema: {
        type: 'object',
        properties: {
          verdicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                verdict: { type: 'string', enum: ['real_deviation', 'stale_sheet_target', 'data_entry_suspect', 'unclear'] },
                why: { type: 'string', description: 'One short sentence a founder can act on' },
              },
              required: ['id', 'verdict', 'why'],
            },
          },
        },
        required: ['verdicts'],
      },
    }],
    tool_choice: { type: 'tool', name: 'record_triage' },
    messages: [{
      role: 'user',
      content: `You are triaging out-of-tolerance QC measurements from a third-party garment inspection so the founder reviews real problems first.

For each flagged group decide:
- "real_deviation" — the garments genuinely measure off-spec (samples consistent with each other, target trustworthy). Cross-reference the inspector's AQL findings below; a matching finding strongly confirms.
- "stale_sheet_target" — the QC sheet's target (Orig) is wrong/outdated: the measurements cluster near the digitized spec target instead, or the sheet target breaks the product's size progression while measurements look sane.
- "data_entry_suspect" — the measured value is implausible for the POM (wrong magnitude, e.g. 2.375 where ~19 is expected; lone wild sample while siblings sit near target).
- "unclear" — genuinely ambiguous; say what would settle it.

Measurements are in cm. diff = measured − sheet target. The digitized spec is a first-stab import and can itself be wrong — when sheet and spec disagree, let the measurements arbitrate.

Inspector AQL results:
${aqlContext}

Flagged groups:
${JSON.stringify(chunk, null, 1)}`,
    }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('qc triage returned no structured output');
  return Object.fromEntries(toolUse.input.verdicts.map((v) => [v.id, v]));
}

/**
 * Synthesize the triaged groups into the SHORT list of findings a human acts
 * on — the generalities, not 139 rows. Groups sharing a root cause (same
 * product+POM across sizes, systematic offsets, marginal noise) merge into one
 * finding. Judgment call -> AI.
 */
async function synthesizeQcFindings(review) {
  if (!review.groups.length) return [];
  const compact = review.groups.map((g) => ({
    id: g.id,
    product: g.product,
    size: g.size,
    pom: `${g.pom_code} ${g.pom_name || ''}`.trim(),
    tolerance: g.tolerance_cm,
    worst_diff: g.worst_diff,
    samples: g.samples.length,
    verdict: g.verdict || null,
    why: g.why || null,
  }));
  const aqlContext = review.aql.map((p) => `${p.product_name}: ${p.passed ? 'passed' : 'FAILED'}${p.findings.length ? ` — ${p.findings.join('; ')}` : ''}`).join('\n');

  const response = await callClaude({
    component: 'qc_review_synthesis',
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    stream: true,
    streamStallMs: 90000,
    tools: [{
      name: 'record_findings',
      description: 'Record the synthesized QC findings',
      input_schema: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'The generality, one line, e.g. "Sky One Piece strap lengths systematically wrong across 5 sizes"' },
                verdict: { type: 'string', enum: ['real_deviation', 'stale_sheet_target', 'data_entry_suspect', 'unclear'] },
                severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                scope: { type: 'string', description: 'Products/sizes/POMs affected, compact, e.g. "Sky One Piece · POM K · sizes 9, 13, XLT, 3XLT"' },
                evidence: { type: 'string', description: 'The numbers that prove it, one line' },
                action: { type: 'string', description: 'What the founder should do about it, one line' },
                group_ids: { type: 'array', items: { type: 'integer' }, description: 'The detail-group ids this finding covers' },
              },
              required: ['title', 'verdict', 'severity', 'scope', 'evidence', 'action', 'group_ids'],
            },
          },
        },
        required: ['findings'],
      },
    }],
    tool_choice: { type: 'tool', name: 'record_findings' },
    messages: [{
      role: 'user',
      content: `You are preparing a garment founder's QC review. Below are ${compact.length} out-of-tolerance measurement groups (already triaged) plus the inspector's AQL results. Produce the SHORT list of distinct findings a human should act on — typically 5-15, ordered most important first.

Merge aggressively:
- Same product + same POM across many sizes = ONE finding (a systematic pattern, e.g. straps cut wrong, band graded small).
- Related stale-sheet-target groups = ONE finding per product ("QC Master targets outdated for X").
- Everything marginal (small exceedances, scattered, no pattern) = ONE rollup finding at severity low, stating the count and the typical magnitude — normal sewing variance the founder can accept in one decision.
- A data-entry suspect stays its own finding only if it would matter; otherwise fold into a rollup.
Every group id must appear in exactly one finding's group_ids.

Cross-reference the AQL results: a finding confirmed by the inspector's defect log is high severity.

Measurements in cm; diff = measured − sheet target.

AQL results:
${aqlContext}

Coverage: ${JSON.stringify(review.coverage)}

Triaged groups:
${JSON.stringify(compact, null, 1)}`,
    }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('qc findings synthesis returned no structured output');
  if (response.stop_reason === 'max_tokens') throw new Error('qc findings synthesis hit max_tokens — output truncated');
  const findings = toolUse.input.findings;
  if (!Array.isArray(findings) || !findings.length) {
    throw new Error(`qc findings synthesis returned ${Array.isArray(findings) ? 'zero findings' : 'no findings array'} for ${review.groups.length} flagged groups`);
  }
  return findings;
}

/**
 * Write the "QC — <code>" review tab to the production sheet.
 */
async function writeQcReviewSheet({ production_code, file_paths, spreadsheetId, skip_triage = false }) {
  const { buildQcReviewRows } = require('./qcReviewSheet');
  const { writeFormattedTab } = require('./inboundReceiving');
  const { getSheetsClient } = require('../../../shared/googleSheetsClient');
  const SHEET_ID = process.env.PRODUCTION_SHEET_ID || '1kMZ-thv7pmBEvudlT_Ujw1z1wb-2zwjV5vT_TuNm87w';

  const review = await assembleQcReview({ production_code, file_paths });
  if (!skip_triage) {
    const verdicts = await triageQcGroups(review);
    for (const g of review.groups) {
      const v = verdicts[g.id];
      if (v) { g.verdict = v.verdict; g.why = v.why; }
    }
    review.findings = await synthesizeQcFindings(review);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const built = buildQcReviewRows(review, dateStr);
  const sheetId = spreadsheetId || SHEET_ID;
  const tabName = `QC — ${review.order.production_code}`;
  const sheets = await getSheetsClient();
  await writeFormattedTab(sheets, sheetId, tabName, built);

  const verdictCounts = {};
  for (const g of review.groups) verdictCounts[g.verdict || 'untriaged'] = (verdictCounts[g.verdict || 'untriaged'] || 0) + 1;
  return {
    tab_name: tabName,
    url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    order: review.order,
    groups: review.groups.length,
    findings: (review.findings || []).map((f) => `[${f.severity}] ${f.title}`),
    verdict_counts: verdictCounts,
    aql_failed: review.aql.filter((p) => !p.passed).map((p) => p.product_name),
    drift: review.drift,
  };
}

module.exports = {
  TAB_HANDLES,
  TAB_PREFIX_OVERRIDES,
  buildSpecLookup,
  validateAgainstSpecs,
  inferCategory,
  ingestQcResults,
  ingestQcReport,
  reviewProductionQc,
  approveProductionQc,
  parseAqlIssues,
  assembleQcReview,
  triageQcGroups,
  synthesizeQcFindings,
  writeQcReviewSheet,
};
