#!/usr/bin/env node
/**
 * Measure what leaks into operator_action_summary: classify every clause as
 * EXECUTABLE (the operator agent needs it to run the tool) or EXTRA
 * (customer-facing copy, narration, or restated draft prose).
 *
 * Baseline, 313 advisor drafts 2026-06-01 → 08-11, BEFORE the field spec
 * shipped: donation copy 16.0%, narration 17.9%, dollar amounts 0.3%, any
 * extra 33.5% (≈30% after discounting classifier false positives — it misfiles
 * refund item lists and split-shipment target dates as narration, so read the
 * flagged clauses with --show before quoting a number).
 *
 * Re-run after enough drafts accumulate under the new prompt to see whether the
 * donation and narration rates moved. Reads only; costs a few cents in Sonnet.
 *
 * Sonnet: narrow per-item classification with a fixed label set, every finding
 * carrying a verbatim quote so a hallucinated clause is droppable in code, and
 * the whole output is read by a human before anything changes. Not a
 * consequential action loop.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { callClaude } = require('../shared/aiClient');
const { MODELS } = require('../shared/aiPricing');

const SINCE = process.argv[2] || '2026-06-01';
const LIMIT = Number(process.argv[3] || 0);

const RUBRIC = `You are auditing the "operator action" field a CS AI advisor writes for a RUBIES
(gender-affirming apparel) operator. That field is prefilled verbatim into a command box and
handed to an agentic tool-calling agent that then calls Shopify/Warehance tools
(create_exchange_order, refund_order, edit_order, cancel_order, warehouse_hold,
create_invoice_order, split_shipment, create_discount_code, update_customer).

The operator agent ALSO separately receives the full customer-facing email draft and the order
contents, so anything that merely restates the email or the order is redundant here.

Split the field into clauses. Label each clause exactly one of:

- EXECUTABLE — a parameter or instruction the tool call needs: order number, products, SKUs,
  quantities, sizes, colors, which items are replaced, $0/free vs invoice-the-difference,
  shipping speed, address to ship to, release-the-hold-after, discount percent.
- EXTRA_DONATION — anything about donating, returning, keeping, or washing the old items, or a
  named partner organisation. The operator never acts on this; it is customer-facing copy.
- EXTRA_MONEY — a computed or stated dollar/currency amount that the tool would compute itself
  ($0 and "no invoice"/"invoice the difference" are EXECUTABLE, not this; an explicit non-zero
  total, price, or refund figure is EXTRA_MONEY unless the clause is an invoice total or a
  custom non-line-item refund, which are legitimately operator-set).
- EXTRA_NARRATION — stock/availability commentary, restock ETAs, ship-date or delivery promises,
  the customer's reason or backstory, sentiment, apologies, or a restatement of what the email
  says.
- EXTRA_OTHER — anything else the operator agent does not need.

Return JSON only:
{"clauses":[{"quote":"<verbatim substring of the field>","label":"<LABEL>"}]}

Every quote MUST be an exact substring of the field. Cover the whole field; do not overlap.`;

async function classify(row) {
  const res = await callClaude({
    component: 'operator_action_leakage_audit',
    model: MODELS.SONNET,
    max_tokens: 1200,
    system: RUBRIC,
    messages: [{
      role: 'user',
      content: `action_type: ${row.action_type}\noperator action field:\n"""${row.summary}"""`,
    }],
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function main() {
  const sb = getSupabaseClient();
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('cs_ai_drafts')
      .select('id, created_at, message_type, structured_output')
      .eq('source', 'poller').eq('draft_kind', 'advisor_draft')
      .gte('created_at', SINCE)
      .order('created_at', { ascending: false })
      .range(from, from + 499);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 500) break;
    from += 500;
  }

  let items = rows
    .map(r => ({
      id: r.id,
      created_at: r.created_at,
      message_type: r.message_type,
      action_type: r.structured_output?.action_type || null,
      summary: r.structured_output?.operator_action_summary || null,
    }))
    .filter(r => r.summary && String(r.summary).trim());
  if (LIMIT) items = items.slice(0, LIMIT);

  console.log(`classifying ${items.length} operator_action_summary values since ${SINCE}\n`);

  const results = [];
  const CONC = 8;
  for (let i = 0; i < items.length; i += CONC) {
    const batch = items.slice(i, i + CONC);
    const out = await Promise.all(batch.map(async r => {
      try {
        const parsed = await classify(r);
        if (!parsed?.clauses) return { ...r, clauses: [], failed: true };
        // Drop hallucinated citations — quote must appear verbatim in the field.
        const clauses = parsed.clauses.filter(c => c.quote && r.summary.includes(c.quote));
        return { ...r, clauses, dropped: parsed.clauses.length - clauses.length };
      } catch (e) {
        return { ...r, clauses: [], failed: true, err: e.message };
      }
    }));
    results.push(...out);
    process.stderr.write(`  ${results.length}/${items.length}\r`);
  }

  const LABELS = ['EXECUTABLE', 'EXTRA_DONATION', 'EXTRA_MONEY', 'EXTRA_NARRATION', 'EXTRA_OTHER'];
  const draftsWith = {};
  const clauseCount = {};
  let failed = 0, droppedTotal = 0;
  for (const r of results) {
    if (r.failed) { failed++; continue; }
    droppedTotal += r.dropped || 0;
    const seen = new Set();
    for (const c of r.clauses) {
      clauseCount[c.label] = (clauseCount[c.label] || 0) + 1;
      seen.add(c.label);
    }
    for (const l of seen) draftsWith[l] = (draftsWith[l] || 0) + 1;
  }
  const n = results.length - failed;

  console.log(`\n\nclassified ${n} (failed ${failed}, hallucinated quotes dropped ${droppedTotal})\n`);
  console.log('label                 drafts containing ≥1        clauses');
  for (const l of LABELS) {
    const d = draftsWith[l] || 0;
    console.log(`${l.padEnd(20)} ${String(d).padStart(4)}  ${(100 * d / n).toFixed(1).padStart(5)}%      ${String(clauseCount[l] || 0).padStart(4)}`);
  }

  const anyExtra = results.filter(r => !r.failed && r.clauses.some(c => c.label !== 'EXECUTABLE'));
  console.log(`\ndrafts with ANY extra: ${anyExtra.length} / ${n} (${(100 * anyExtra.length / n).toFixed(1)}%)`);

  // by action_type
  const byType = {};
  for (const r of results) {
    if (r.failed) continue;
    const t = r.action_type || 'null';
    byType[t] = byType[t] || { n: 0, extra: 0 };
    byType[t].n++;
    if (r.clauses.some(c => c.label !== 'EXECUTABLE')) byType[t].extra++;
  }
  console.log('\n=== extras by action_type ===');
  for (const [t, v] of Object.entries(byType).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${t.padEnd(26)} ${String(v.extra).padStart(3)}/${String(v.n).padEnd(3)}  ${(100 * v.extra / v.n).toFixed(0)}%`);
  }

  if (process.argv.includes('--show')) {
    console.log('\n=== every extra clause ===');
    for (const r of results) {
      const ex = (r.clauses || []).filter(c => c.label !== 'EXECUTABLE');
      if (!ex.length) continue;
      console.log(`\n[#${r.id} ${r.created_at.slice(0, 10)} ${r.action_type}] ${r.summary}`);
      for (const c of ex) console.log(`   ${c.label}: "${c.quote}"`);
    }
  }

  require('fs').writeFileSync(
    process.env.LEAK_OUT || '/tmp/operator-action-leakage.json',
    JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
