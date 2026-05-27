/**
 * Unit tests for the advisor edit-rate metric (daily ops digest tripwire).
 * Mocks Supabase so the computation is deterministic. Run:
 *   node --test customer-service/test/advisorEditRate.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const supabasePath = require.resolve('../../shared/supabaseClient');

// Drafts: identical (incl. whitespace-only diff) vs edited.
const ROWS = [
  { draft_response: 'Hi there', sent_response: 'Hi there' },                       // identical
  { draft_response: 'Hi\n\nthere', sent_response: 'Hi\nthere' },                   // whitespace-only -> identical
  { draft_response: 'Hi  there ', sent_response: 'Hi there' },                     // spacing-only -> identical
  { draft_response: 'Refund $32', sent_response: 'Refund $28' },                   // edited
  { draft_response: 'Black only', sent_response: 'Black and Pink' },               // edited
];

require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            not: () => ({
              gte: () => ({
                range: () => ({ data: ROWS, error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
};

const { computeAdvisorEditRate, normalize } = require('../../lib/advisorEditRate');

describe('normalize', () => {
  it('collapses whitespace and blank lines', () => {
    assert.equal(normalize('Hi  there\n\n\nyou '), 'Hi there\nyou');
  });
});

describe('computeAdvisorEditRate', () => {
  it('counts whitespace-only diffs as identical, real diffs as edited', async () => {
    const m = await computeAdvisorEditRate({ days: 30 });
    assert.equal(m.sent, 5);
    assert.equal(m.identical, 3);
    assert.equal(m.edited, 2);
    assert.equal(m.edit_rate_pct, 40); // 2/5
  });

  it('reports null rate when no sent drafts', async () => {
    // empty dataset
    ROWS.length = 0;
    const m = await computeAdvisorEditRate({ days: 30 });
    assert.equal(m.sent, 0);
    assert.equal(m.edit_rate_pct, null);
  });
});
