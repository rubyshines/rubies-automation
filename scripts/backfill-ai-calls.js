#!/usr/bin/env node
/**
 * backfill-ai-calls.js — populate ai_calls from historical timing JSONB so the
 * cost/latency trend lines aren't blank for the ~6 weeks before the wrapper
 * shipped.
 *
 * Sources:
 *   1. cs_ai_drafts.structured_output._timing.api_calls[]  → component cs_advisor
 *      (model assumed claude-opus-4-6 per project_cs_efficiency history)
 *   2. cs_diagnostic_runs.opus_timing.api_calls[]          → component depends on source
 *      ('advisor' → cs_advisor, 'operator' → cs_operator)  model claude-opus-4-6
 *   3. cs_diagnostic_runs.sonnet_timing.api_calls[]        → *_shadow components
 *      model claude-sonnet-4-6
 *
 * Each api_calls[] entry becomes one ai_calls row. Cost is computed from the
 * recorded tokens via shared/aiPricing.js. Rows are tagged
 * metadata.backfilled = true and carry a deterministic backfill_key so a re-run
 * is idempotent (existing backfilled rows are detected and the run aborts unless
 * --force is passed, in which case prior backfilled rows are deleted first).
 *
 * Usage (print-only by default):
 *   node scripts/backfill-ai-calls.js              # dry run — counts + sample
 *   node scripts/backfill-ai-calls.js --send       # write rows
 *   node scripts/backfill-ai-calls.js --send --force  # delete prior backfill, rewrite
 *
 * Safe to skip entirely — ai_calls works fine without historical rows.
 */

require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { computeCost } = require('../shared/aiPricing');

const SEND = process.argv.includes('--send');
const FORCE = process.argv.includes('--force');
const PAGE = 1000;

function rowFromApiCall({ component, model, provider = 'anthropic', call, created_at, ticket_id, draft_id, backfill_key, parent_call_id = null }) {
  const usage = {
    input_tokens: call.input_tokens ?? null,
    output_tokens: call.output_tokens ?? null,
    cache_read_tokens: call.cache_read_tokens || 0,
    cache_creation_tokens: call.cache_creation_tokens || 0,
  };
  const toolCalls = Array.isArray(call.tool_calls) ? call.tool_calls : [];
  return {
    component,
    model_id: model,
    provider,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    duration_ms: call.duration_ms ?? null,
    cost_usd: computeCost(model, usage),
    tool_calls: toolCalls.length ? toolCalls : null,
    tool_count: toolCalls.length,
    ticket_id: ticket_id ?? null,
    draft_id: draft_id ?? null,
    parent_call_id,
    metadata: { backfilled: true, backfill_key },
    error: null,
    created_at,
  };
}

async function pageAll(table, columns, filterFn) {
  const supabase = getSupabaseClient();
  const out = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(columns).order('id', { ascending: true }).range(from, from + PAGE - 1);
    q = filterFn ? filterFn(q) : q;
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

(async () => {
  const supabase = getSupabaseClient();

  // Probe ai_calls existence.
  const { error: probeErr } = await supabase.from('ai_calls').select('id').limit(0);
  if (probeErr) {
    console.error('ai_calls table does not exist yet. Run shared/ai-calls-schema.sql first.');
    process.exit(1);
  }

  // Idempotency guard.
  const { count: existingBackfill } = await supabase
    .from('ai_calls')
    .select('id', { count: 'exact', head: true })
    .eq('metadata->>backfilled', 'true');
  if (existingBackfill > 0) {
    if (!FORCE) {
      console.error(`Found ${existingBackfill} existing backfilled rows. Re-run with --force to delete and rewrite, or leave as-is.`);
      process.exit(1);
    }
    if (SEND) {
      console.log(`--force: deleting ${existingBackfill} prior backfilled rows...`);
      const { error: delErr } = await supabase.from('ai_calls').delete().eq('metadata->>backfilled', 'true');
      if (delErr) throw delErr;
    }
  }

  const rows = [];

  // 1. cs_ai_drafts → cs_advisor
  const drafts = await pageAll(
    'cs_ai_drafts',
    'id, gorgias_ticket_id, created_at, structured_output',
    (q) => q.not('structured_output->_timing', 'is', null)
  );
  for (const d of drafts) {
    const calls = d.structured_output?._timing?.api_calls || [];
    let parent = null;
    calls.forEach((call, idx) => {
      const key = `draft:${d.id}:${idx}`;
      const row = rowFromApiCall({
        component: 'cs_advisor',
        model: 'claude-opus-4-6',
        call,
        created_at: d.created_at,
        ticket_id: d.gorgias_ticket_id || null,
        draft_id: d.id,
        backfill_key: key,
        parent_call_id: parent, // best-effort, local placeholder (not a real id pre-insert)
      });
      rows.push(row);
      if (idx === 0) parent = null; // we can't know real ids pre-insert; leave null
    });
  }

  // 2 + 3. cs_diagnostic_runs → opus (production component) + sonnet (shadow)
  const diags = await pageAll(
    'cs_diagnostic_runs',
    'id, source, created_at, ticket_id, draft_id, opus_timing, sonnet_timing'
  );
  for (const r of diags) {
    const prodComponent = r.source === 'operator' ? 'cs_operator' : 'cs_advisor';
    const shadowComponent = r.source === 'operator' ? 'cs_operator_shadow' : 'cs_advisor_shadow';

    (r.opus_timing?.api_calls || []).forEach((call, idx) => {
      rows.push(rowFromApiCall({
        component: prodComponent,
        model: 'claude-opus-4-6',
        call,
        created_at: r.created_at,
        ticket_id: r.ticket_id || null,
        draft_id: r.draft_id || null,
        backfill_key: `diag-opus:${r.id}:${idx}`,
      }));
    });
    (r.sonnet_timing?.api_calls || []).forEach((call, idx) => {
      rows.push(rowFromApiCall({
        component: shadowComponent,
        model: 'claude-sonnet-4-6',
        call,
        created_at: r.created_at,
        ticket_id: r.ticket_id || null,
        draft_id: r.draft_id || null,
        backfill_key: `diag-sonnet:${r.id}:${idx}`,
      }));
    });
  }

  const totalCost = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const byComponent = {};
  for (const r of rows) byComponent[r.component] = (byComponent[r.component] || 0) + 1;

  console.log(`Backfill candidates: ${rows.length} ai_calls rows`);
  console.log(`  by component:`, byComponent);
  console.log(`  total historical cost: $${totalCost.toFixed(4)}`);
  if (rows[0]) console.log(`  sample row:`, JSON.stringify(rows[0], null, 2));

  if (!SEND) {
    console.log('\nDRY RUN — pass --send to write. (No rows inserted.)');
    return;
  }

  // Insert in batches.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('ai_calls').insert(batch);
    if (error) throw error;
    inserted += batch.length;
    console.log(`  inserted ${inserted}/${rows.length}`);
  }
  console.log(`Done. Inserted ${inserted} backfilled ai_calls rows.`);
})().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
