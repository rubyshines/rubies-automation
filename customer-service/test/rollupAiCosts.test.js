/**
 * Unit tests for lib/rollupAiCosts.js — daily ai_calls → ai_costs_daily rollup.
 *
 * Mocks shared/supabaseClient. Verifies aggregation by (component, model_id),
 * idempotent delete-then-insert, per-component breakdown, p95/avg duration, and
 * the fail-soft skip when tables are absent.
 *
 * Run: node --test customer-service/test/rollupAiCosts.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const supabasePath = require.resolve('../../shared/supabaseClient');

// Mutable mock state.
let aiCalls;          // rows returned for the ai_calls day query
let tablesPresent;    // { ai_calls, ai_costs_daily }
let deletedDates;     // dates passed to ai_costs_daily delete
let insertedRows;     // rows inserted into ai_costs_daily

function makeStub() {
  return {
    from(table) {
      if (table === 'ai_calls') {
        return {
          select() {
            return {
              limit() { return Promise.resolve({ error: tablesPresent.ai_calls ? null : { message: 'missing' } }); },
              // chainable for the day query
              gte() { return this; },
              lte() { return this; },
              order() { return this; },
              range() { return Promise.resolve({ data: aiCalls, error: null }); },
            };
          },
        };
      }
      if (table === 'ai_costs_daily') {
        return {
          select() { return { limit() { return Promise.resolve({ error: tablesPresent.ai_costs_daily ? null : { message: 'missing' } }); } }; },
          delete() { return { eq(_c, date) { deletedDates.push(date); return Promise.resolve({ error: null }); } }; },
          insert(rows) { insertedRows.push(...rows); return Promise.resolve({ error: null }); },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabaseClient: () => makeStub() },
};

const { rollupAiCosts } = require('../../lib/rollupAiCosts');

beforeEach(() => {
  aiCalls = [];
  tablesPresent = { ai_calls: true, ai_costs_daily: true };
  deletedDates = [];
  insertedRows = [];
});

describe('rollupAiCosts', () => {
  it('aggregates by component and model, computes avg/p95 and cost', async () => {
    aiCalls = [
      { component: 'cs_advisor', model_id: 'claude-opus-4-6', input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_creation_tokens: 0, duration_ms: 1000, cost_usd: 0.01, error: null },
      { component: 'cs_advisor', model_id: 'claude-opus-4-6', input_tokens: 200, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 3000, cost_usd: 0.02, error: null },
      { component: 'gmail_email_classifier', model_id: 'claude-sonnet-4-6', input_tokens: 500, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 800, cost_usd: 0.0016, error: null },
      { component: 'gmail_email_classifier', model_id: 'claude-haiku-4-5-20251001', input_tokens: 500, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 400, cost_usd: 0.0005, error: 'overloaded' },
    ];

    const res = await rollupAiCosts('2026-05-26');

    // 3 distinct (component, model) groups.
    assert.equal(insertedRows.length, 3);
    const advisor = insertedRows.find(r => r.component === 'cs_advisor');
    assert.equal(advisor.call_count, 2);
    assert.equal(advisor.total_input_tokens, 300);
    assert.equal(advisor.total_output_tokens, 150);
    assert.equal(advisor.total_cache_read_tokens, 10);
    assert.equal(advisor.total_cost_usd, 0.03);
    assert.equal(advisor.avg_duration_ms, 2000);
    assert.equal(advisor.p95_duration_ms, 3000);
    assert.equal(advisor.error_count, 0);

    const haiku = insertedRows.find(r => r.model_id === 'claude-haiku-4-5-20251001');
    assert.equal(haiku.error_count, 1);

    // Deleted the day first (idempotent).
    assert.deepEqual(deletedDates, ['2026-05-26']);

    // Per-component breakdown collapses models, sorted by cost desc.
    const bd = res.sources.ai_costs.breakdown;
    assert.equal(bd[0].component, 'cs_advisor'); // 0.03 highest
    const classifier = bd.find(b => b.component === 'gmail_email_classifier');
    assert.equal(classifier.calls, 2);
    assert.equal(classifier.cost_usd, 0.0021);
    assert.equal(classifier.errors, 1);
    assert.equal(res.sources.ai_costs.total_calls, 4);
    assert.equal(res.status, 'ok');
  });

  it('deletes the day even when there are no calls (idempotent re-run)', async () => {
    aiCalls = [];
    const res = await rollupAiCosts('2026-05-26');
    assert.deepEqual(deletedDates, ['2026-05-26']);
    assert.equal(insertedRows.length, 0);
    assert.equal(res.sources.ai_costs.rowsWritten, 0);
  });

  it('skips fail-soft when ai_calls table is absent', async () => {
    tablesPresent.ai_calls = false;
    const res = await rollupAiCosts('2026-05-26');
    assert.equal(res.sources.ai_costs.skipped, true);
    assert.equal(res.status, 'ok');
    assert.equal(deletedDates.length, 0);
    assert.equal(insertedRows.length, 0);
  });

  it('skips fail-soft when ai_costs_daily table is absent', async () => {
    tablesPresent.ai_costs_daily = false;
    const res = await rollupAiCosts('2026-05-26');
    assert.equal(res.sources.ai_costs.skipped, true);
    assert.equal(insertedRows.length, 0);
  });
});
