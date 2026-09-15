/**
 * MCP tools for QC inspection — Phase 4 of the production pipeline.
 *
 *   generate_qc_sheet    — order + tech-pack specs -> blank QC Master .xlsx for the inspector
 *   ingest_qc_results    — completed QC Master .xlsx -> qc_measurements + flags
 *   ingest_qc_report     — inspector's AQL PDF -> qc_issues
 *   review_production_qc — pass/fail summary + coverage vs the order
 *   approve_production_qc — approval gate; lists balance payments now due
 */

const { ingestQcResults, ingestQcReport, reviewProductionQc, approveProductionQc } = require('../merchandising/qcResults');
const { generateQcSheet } = require('../merchandising/qcSheetWriter');

const ok = (text) => ({ content: [{ type: 'text', text }] });
const err = (text) => ({ content: [{ type: 'text', text: `Error: ${text}` }] });

const fmtDiff = (d) => `${d > 0 ? '+' : ''}${d}`;

function ootLines(rows, limit = 30) {
  return rows.slice(0, limit).map((r) =>
    `- ${r.sku} ${r.color} · POM ${r.pom_code} ${r.pom_name || ''} · sample ${r.sample_number}: ${r.measured_cm} vs ${r.target_cm} (${fmtDiff(r.diff_cm)}, tol ±${r.tolerance_cm})`
  ).concat(rows.length > limit ? [`  … ${rows.length - limit} more`] : []);
}

function ingestSummary(res) {
  const lines = [
    `**QC ingested** — ${res.category} · order ${res.order.production_code} · inspection #${res.inspection_id}`,
    `${res.measurements.toLocaleString()} sample measurements across ${res.tabs.length} products · ${res.skus_measured.length} SKUs`,
  ];
  if (res.out_of_tolerance.length) {
    lines.push(`\n⚠️ **${res.out_of_tolerance.length} out-of-tolerance measurements:**`);
    lines.push(...ootLines(res.out_of_tolerance));
  } else {
    lines.push('✅ All measurements within tolerance.');
  }
  if (res.remapped.length) {
    lines.push(`\nSKU labels remapped (catalog-validated): ${res.remapped.map((r) => `${r.from}→${r.to}`).join(', ')}`);
  }
  if (res.unknown_skus.length) {
    lines.push(`\n🔎 **Unresolved SKU labels** (kept, flagged — never invented): ${res.unknown_skus.map((u) => `${u.tab}: ${u.sku_label} [${u.color}]${u.candidate ? ` → ${u.candidate}?` : ''}`).join('; ')}`);
  }
  if (res.spec_mismatches.length) {
    lines.push(`\n📐 **Sheet targets that disagree with tech_pack_specs** (${res.spec_mismatches.length}) — one of the two is stale:`);
    lines.push(...res.spec_mismatches.slice(0, 20).map((m) => `- ${m.tab} · size ${m.size} · POM ${m.pom_code} ${m.pom_name || ''}: sheet ${m.sheet_target} vs spec ${m.spec_target} (Δ${fmtDiff(m.delta)})`));
    if (res.spec_mismatches.length > 20) lines.push(`  … ${res.spec_mismatches.length - 20} more`);
  }
  if (res.spec_unmatched_count) {
    lines.push(`\n${res.spec_unmatched_count} sheet rows had no matching tech_pack_spec (subset POMs / missing tech pack — allowed).`);
  }
  if (res.non_cm_tabs && res.non_cm_tabs.length) {
    lines.push(`\n🚨 **Tabs with measurements in NON-CM units** (stored values are raw sheet numbers — convert before trusting): ${res.non_cm_tabs.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = [
  {
    name: 'generate_qc_sheet',
    description: 'Generate the blank QC Master workbook (.xlsx) the third-party inspector fills in for a production order: one tab per product on the order, size blocks from the order\'s SKUs, target measurements and tolerances from the current tech_pack_specs, sample columns per colour, live Diff formulas with in/out-of-tolerance colouring. Same geometry ingest_qc_results reads, so the completed sheet round-trips. Records a draft qc_inspections row. Optionally restrict to some products (SKU prefix, tech-pack handle or tab name).',
    input_schema: {
      type: 'object',
      properties: {
        production_code: { type: 'string', description: 'Production order code, e.g. KALI-2606' },
        category: { type: 'string', enum: ['underwear', 'swimwear'], description: 'One workbook per category, which is how the inspector receives them and how ingest_qc_results reads them back. Omit only when the order is single-category or you deliberately want one mixed file.' },
        products: { type: 'array', items: { type: 'string' }, description: 'Only these products, e.g. ["naomi"] or ["GAF", "AJ"]; omit for every QC product on the order' },
        samples_per_color: { type: 'integer', description: 'Sample columns per colour per size (default: the tech pack\'s samples_per_color, normally 3)' },
        out_path: { type: 'string', description: 'Where to write the .xlsx (default ~/Downloads/<code> <Category> QC Master.xlsx)' },
      },
      required: ['production_code'],
    },
    handler: async (args) => {
      try {
        const r = await generateQcSheet(args);
        const lines = [
          `**QC Master generated** — ${r.order.production_code}${r.category ? ` · ${r.category}` : ''}${r.inspection_id ? ` · inspection #${r.inspection_id} (draft)` : ''}`,
          `File: ${r.path}`,
          ...r.tabs.map((t) => `- ${t.name} (${t.prefix}): sizes ${t.sizes.join(', ')} · colours ${t.colours.join('/')} × ${t.samples_per_color} samples · POMs ${t.poms.join(', ')} · tolerance ±${t.tolerances.join('/±')} · POM sketch ${t.pom_image ? 'embedded' : 'missing (add customer-service/assets/qc-pom/<handle>.png)'}${t.sizes_without_spec.length ? ` · ⚠️ no spec for ${t.sizes_without_spec.join(', ')} (blank targets)` : ''}`),
        ];
        if (r.not_on_order.length) lines.push(`Requested but not on this order: ${r.not_on_order.join(', ')}`);
        if (r.skipped_prefixes.length) lines.push(`On the order, no QC tab (accessories / unmapped): ${r.skipped_prefixes.join(', ')}`);
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    },
  },
  {
    name: 'ingest_qc_results',
    description: 'Ingest a third-party inspector\'s completed QC Master workbook (.xlsx) for a production order. Parses every product tab (size blocks × color samples), resolves SKUs against the catalog, writes per-sample qc_measurements with in/out-of-tolerance flags, and cross-validates the sheet\'s targets against the digitized grading (tech_pack_specs). Idempotent — safe to re-run on a corrected file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the completed QC Master .xlsx' },
        production_code: { type: 'string', description: 'Production order code, e.g. KALI-2601' },
        category: { type: 'string', enum: ['underwear', 'swimwear'], description: 'Inferred from the filename when omitted' },
        inspector: { type: 'string', description: 'Inspector name (e.g. Joyce)' },
      },
      required: ['file_path', 'production_code'],
    },
    handler: async (args) => {
      try {
        return ok(ingestSummary(await ingestQcResults(args)));
      } catch (e) { return err(e.message); }
    },
  },
  {
    name: 'ingest_qc_report',
    description: 'Ingest the inspector\'s AQL inspection report (PDF) for a production order — the per-product findings, majors/minors, and pass/fail conclusions. Writes qc_issues (failed products stay open; passed findings recorded as resolved). Requires the QC Master .xlsx to be ingested first so issues attach to the right inspection.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the inspection report PDF' },
        production_code: { type: 'string' },
      },
      required: ['file_path', 'production_code'],
    },
    handler: async (args) => {
      try {
        const res = await ingestQcReport(args);
        const lines = [
          `**AQL report ingested** — order ${res.order.production_code} · ${res.issues_written} new issues recorded`,
          ...res.products.map((p) => `- ${p.passed ? '✅' : '❌'} ${p.product_name}: majors ${p.majors ?? 0} / minors ${p.minors ?? 0}${p.findings.length ? ` — ${p.findings.map((f) => f.description).join('; ')}` : ''}`),
        ];
        if (res.packing_status) lines.push(`Packing: ${res.packing_status}`);
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    },
  },
  {
    name: 'review_production_qc',
    description: 'Review QC for a production order before approval: out-of-tolerance POMs grouped by product/size (worst-first), open AQL issues from the inspection report, and sampling coverage vs the order\'s line items.',
    input_schema: {
      type: 'object',
      properties: { production_code: { type: 'string' } },
      required: ['production_code'],
    },
    handler: async (args) => {
      try {
        const r = await reviewProductionQc(args);
        const lines = [
          `**QC review — ${r.order.production_code}** (order status: ${r.order.status})`,
          r.inspections.map((i) => `- ${i.category}: ${i.status}${i.inspector ? ` · ${i.inspector}` : ''}${i.approved_at ? ` · approved by ${i.approved_by}` : ''}`).join('\n'),
          `Totals: ${r.totals.measurements.toLocaleString()} measurements · ${r.totals.skus_measured} SKUs sampled · ${r.totals.out_of_tolerance} out of tolerance`,
        ];
        if (r.oot_groups.length) {
          lines.push('\n⚠️ **Out-of-tolerance by product/POM/size** (worst first):');
          lines.push(...r.oot_groups.slice(0, 25).map((g) =>
            `- ${g.prefix} · POM ${g.pom_code} · size ${g.size}: ${g.samples} sample(s), worst ${fmtDiff(g.worst_diff)} vs ±${g.tolerance_cm} — ${g.skus.join(', ')}`));
          if (r.oot_groups.length > 25) lines.push(`  … ${r.oot_groups.length - 25} more groups`);
        } else {
          lines.push('✅ No out-of-tolerance measurements.');
        }
        const open = r.issues.filter((i) => i.status === 'open');
        if (open.length) {
          lines.push(`\n❌ **Open issues** (${open.length}):`);
          lines.push(...open.map((i) => `- [${i.severity}] ${i.description}`));
        }
        if (r.coverage.not_sampled.length) lines.push(`\nOrdered but not sampled: ${r.coverage.not_sampled.join(', ')}`);
        if (r.coverage.sampled_not_ordered.length) lines.push(`Sampled but NOT on this order: ${r.coverage.sampled_not_ordered.join(', ')}`);
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    },
  },
  {
    name: 'approve_production_qc',
    description: 'Approve QC for a production order (optionally one category) after review — the gate before the balance payment. Marks inspections approved and lists any balance payments now due.',
    input_schema: {
      type: 'object',
      properties: {
        production_code: { type: 'string' },
        category: { type: 'string', enum: ['underwear', 'swimwear'], description: 'Approve one category only; omit to approve all' },
        approved_by: { type: 'string' },
      },
      required: ['production_code'],
    },
    handler: async (args) => {
      try {
        const r = await approveProductionQc(args);
        const lines = [
          `**QC approved** — ${r.order.production_code}: ${r.approved.map((a) => a.category).join(', ')}`,
        ];
        if (r.due_payments.length) {
          lines.push('💰 Balance payment(s) now releasable:');
          lines.push(...r.due_payments.map((p) => `- ${p.type} ${p.pct ? `${p.pct}%` : ''} ${p.amount ? `${p.amount} ${p.currency || ''}` : ''} (due at ${p.due_event})`));
        } else {
          lines.push('No due payments on record for this order.');
        }
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    },
  },
];
