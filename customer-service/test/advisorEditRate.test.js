/**
 * Unit tests for the advisor edit-rate metric (daily ops digest tripwire).
 * Mocks Supabase so the computation is deterministic. Run:
 *   node --test customer-service/test/advisorEditRate.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const supabasePath = require.resolve('../../shared/supabaseClient');

// cs_ai_drafts holds every outbound message. Only advisor-written rows belong
// in an advisor-quality metric, and inbound replies are the headline surface.
const ROWS = [
  { source: 'poller', draft_response: 'Hi there', sent_response: 'Hi there' },            // identical
  { source: 'poller', draft_response: 'Hi\n\nthere', sent_response: 'Hi\nthere' },        // whitespace-only -> identical
  { source: 'poller', draft_response: 'Hi  there ', sent_response: 'Hi there' },          // spacing-only -> identical
  { source: 'poller', draft_response: 'Refund $32', sent_response: 'Refund $28' },        // edited
  { source: 'poller', draft_response: 'Black only', sent_response: 'Black and Pink' },    // edited
  { source: 'operator_outreach', draft_response: 'Pre-order note', sent_response: 'Pre-order note' },
  { source: 'operator_outreach', draft_response: 'Delay note', sent_response: 'Delay note, sorry' },
];

// Records every filter the query applies so the tests pin the server-side
// exclusion, not just the arithmetic. Filters chain in any order AFTER
// select() — but select() must come first, exactly as PostgREST requires. An
// earlier permissive stub allowed filters before select() and happily passed a
// query that threw "sb.from(...).eq is not a function" against real Supabase.
const applied = { eq: {}, in: {} };
function filters() {
  const self = {
    select: () => { throw new Error('select() called twice'); },
    not: () => self,
    gte: () => self,
    order: () => self,
    eq: (col, val) => { applied.eq[col] = val; return self; },
    in: (col, val) => { applied.in[col] = val; return self; },
    range: () => ({ data: ROWS, error: null }),
  };
  return self;
}

require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    getSupabaseClient: () => ({ from: () => ({ select: () => filters() }) }),
    fetchAllPaginated: async (buildQuery) => {
      const { data, error } = await buildQuery().range(0, 999);
      if (error) throw new Error(`fetchAllPaginated: ${error.message}`);
      return data || [];
    },
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

  it('headlines inbound replies only, with outreach broken out', async () => {
    // Outbound outreach is a different task with its own edit profile, so
    // folding it into the headline moves the tripwire for reasons that have
    // nothing to do with advisor drift.
    const m = await computeAdvisorEditRate({ days: 30 });
    assert.equal(m.sent, 5, 'headline counts poller rows only');
    assert.equal(m.outreach.sent, 2);
    assert.equal(m.outreach.edited, 1);
    assert.equal(m.outreach.edit_rate_pct, 50);
  });

  it('excludes rows the advisor never wrote', async () => {
    // 'operator_reply' and 'manual_send' are Jamie composing from scratch,
    // stored into BOTH draft_response and sent_response so each one scores as
    // a flawless untouched draft; 'auto_follow_up' is a fixed template (~97%
    // byte-identical); 'simulator' is test traffic. Leaving them in
    // understated the rate by ~5 points (48.4% reported vs 53.3% true).
    await computeAdvisorEditRate({ days: 30 });
    assert.equal(applied.eq.draft_kind, 'advisor_draft');
    assert.deepEqual(applied.in.source, ['poller', 'operator_outreach']);
  });

  it('reports null rate when no sent drafts', async () => {
    // empty dataset
    ROWS.length = 0;
    const m = await computeAdvisorEditRate({ days: 30 });
    assert.equal(m.sent, 0);
    assert.equal(m.edit_rate_pct, null);
  });
});
