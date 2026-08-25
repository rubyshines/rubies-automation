/**
 * sweepStaleDraftClaims — recovery for an intake claim stranded by a dead worker.
 *
 * Why this exists: the draft claim is taken BEFORE the advisor call (that is the
 * point — it stops duplicate Opus spend). So a worker that dies between claiming
 * and committing leaves a row nothing will ever fill in. `reclaimIfStale` covers
 * that case only when a NEW delivery of the SAME message collides at 23505, and
 * Gorgias does not redeliver a webhook it already ACKed. The recovery path was
 * therefore purely reactive, and the failure is silent by construction: a claim
 * row is 'superseded', which is exactly what keeps it out of the dashboard
 * queues, so the customer disappears from both sides.
 *
 * Live case: ticket 113280513, claimed 3 seconds after a deploy commit landed.
 * The customer's "Yes the address is correct" went unanswered for 5 days and
 * only the daily drift digest ever saw it — and drift deliberately never
 * auto-drafts, so nothing would have recovered it.
 *
 * Invariants pinned here:
 *   1. Only OUR unfilled intake claims are eligible, and only inside the age
 *      window — never a committed draft, never the auto-close claim's marker.
 *   2. The claim is deleted BEFORE the ticket is reprocessed, or the re-claim
 *      inside processTicket collides with the row we are trying to recover.
 *   3. A reprocess failure is loud and leaves no claim behind (a stuck claim is
 *      the thing being fixed).
 *   4. Nothing stale → no writes at all. This runs every 5 minutes.
 *
 * Run: node --test customer-service/test/staleClaimSweep.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'http://test';
process.env.SUPABASE_SERVICE_KEY ||= 'test';
process.env.GORGIAS_DOMAIN ||= 'test';
process.env.GORGIAS_API_KEY ||= 'test';
process.env.GORGIAS_EMAIL ||= 'test@test.com';

const SUPABASE_PATH = require.resolve('../../shared/supabaseClient');
const GORGIAS_PATH = require.resolve('../import/gorgiasClient');
const MODULE_PATH = require.resolve('../intake/processGorgiasTickets');

let ops;
let origWarn, origError, origLog;
let logs;

/**
 * Chainable Supabase stub. Every terminal await records the call with its full
 * filter chain; `staleRows` is what the eligibility query returns.
 */
function makeSupabase({ staleRows = [] }) {
  ops = [];
  function builder(table) {
    const call = { table, op: null, filters: [], columns: null };
    const settle = (resolve) => {
      ops.push(call);
      if (call.op === 'select' && call.columns?.includes('created_at')) {
        return resolve({ data: staleRows, error: null });
      }
      if (call.op === 'select') return resolve({ data: [{ gorgias_message_id: 777 }], error: null });
      return resolve({ data: null, error: null });
    };
    const api = {
      select(cols) { call.op = call.op || 'select'; call.columns = cols; return api; },
      delete() { call.op = 'delete'; return api; },
      eq(c, v) { call.filters.push(['eq', c, v]); return api; },
      contains(c, v) { call.filters.push(['contains', c, v]); return api; },
      lt(c, v) { call.filters.push(['lt', c, v]); return api; },
      gt(c, v) { call.filters.push(['gt', c, v]); return api; },
      order(c) { call.filters.push(['order', c]); return api; },
      then(resolve) { settle(resolve); },
    };
    return api;
  }
  return { from: builder };
}

function loadModule({ staleRows = [], gorgias = {} } = {}) {
  delete require.cache[MODULE_PATH];
  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true, exports: {
      getSupabaseClient: () => makeSupabase({ staleRows }),
    },
  };
  require.cache[GORGIAS_PATH] = {
    id: GORGIAS_PATH, filename: GORGIAS_PATH, loaded: true, exports: {
      findUser: async () => ({ id: 1 }),
      getTicket: async id => ({ id, customer: { email: 'c@example.com' } }),
      // processTicket bails immediately on an empty message list, which is all
      // this test needs — the advisor is out of scope here.
      getTicketMessages: async () => [],
      delay: async () => {},
      ...gorgias,
    },
  };
  return require('../intake/processGorgiasTickets');
}

const claim = (over = {}) => ({
  id: 3421,
  gorgias_ticket_id: 113280513,
  gorgias_message_id: 325949308,
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  ...over,
});

describe('sweepStaleDraftClaims', () => {
  beforeEach(() => {
    origWarn = console.warn; origError = console.error; origLog = console.log;
    logs = [];
    console.warn = m => logs.push(String(m));
    console.error = m => logs.push(String(m));
    console.log = () => {};
  });

  afterEach(() => {
    console.warn = origWarn; console.error = origError; console.log = origLog;
    delete require.cache[SUPABASE_PATH];
    delete require.cache[GORGIAS_PATH];
    delete require.cache[MODULE_PATH];
  });

  it('matches only unfilled intake claims inside the age window', async () => {
    const { sweepStaleDraftClaims } = loadModule({ staleRows: [] });
    await sweepStaleDraftClaims();

    assert.equal(ops.length, 1, 'nothing stale → exactly one read, zero writes');
    const [query] = ops;
    assert.equal(query.table, 'cs_ai_drafts');
    assert.equal(query.op, 'select');

    // An empty draft_response plus the intake_claim marker is what distinguishes
    // our unfilled claim from a committed draft and from the auto-close claim,
    // which carries a different marker. Recovering either would double-reply.
    assert.deepEqual(query.filters.slice(0, 2), [
      ['eq', 'draft_response', ''],
      ['contains', 'structured_output', { intake_claim: true }],
    ]);

    // Older than the staleness cutoff (never steal a LIVE claim mid-draft) and
    // newer than the max age (never answer a question the customer dropped).
    const [ltOp, ltCol, ltVal] = query.filters[2];
    const [gtOp, gtCol, gtVal] = query.filters[3];
    assert.deepEqual([ltOp, ltCol, gtOp, gtCol], ['lt', 'created_at', 'gt', 'created_at']);
    assert.ok(new Date(gtVal) < new Date(ltVal), 'the window must not be inverted');
  });

  it('deletes the claim BEFORE reprocessing the ticket', async () => {
    // Ordering is load-bearing: processTicket re-claims the same
    // (ticket, message) key, so a claim still present would collide with the
    // very row being recovered and the sweep would achieve nothing.
    const order = [];
    const { sweepStaleDraftClaims } = loadModule({
      staleRows: [claim()],
      gorgias: {
        getTicket: async (id) => { order.push('getTicket'); return { id, customer: { email: 'c@example.com' } }; },
      },
    });

    const { swept } = await sweepStaleDraftClaims();

    const deleteIdx = ops.findIndex(o => o.op === 'delete');
    assert.ok(deleteIdx >= 0, 'the claim must be deleted');
    assert.deepEqual(ops[deleteIdx].filters, [['eq', 'id', 3421]], 'deletes exactly the claim row');
    assert.equal(order[0], 'getTicket');
    assert.ok(deleteIdx < ops.length - 1, 'the delete precedes the reprocess reads');

    assert.equal(swept.length, 1);
    assert.equal(swept[0].claimId, 3421);
    assert.equal(swept[0].ticketId, 113280513);
  });

  it('reports without writing in dry-run mode', async () => {
    const { sweepStaleDraftClaims } = loadModule({ staleRows: [claim()] });
    const { swept } = await sweepStaleDraftClaims({ write: false });

    assert.deepEqual(swept.map(s => s.status), ['found']);
    assert.deepEqual(ops.map(o => o.op), ['select'], 'dry run touches nothing');
  });

  it('a failed reprocess is loud, and does not restore the stuck claim', async () => {
    const { sweepStaleDraftClaims } = loadModule({
      staleRows: [claim()],
      gorgias: { getTicket: async () => { throw new Error('Gorgias 502'); } },
    });

    const { swept } = await sweepStaleDraftClaims();

    assert.equal(swept[0].status, 'failed');
    assert.match(swept[0].error, /502/);
    assert.ok(logs.some(l => /claim-sweep/.test(l) && /FAILED/.test(l)), 'the operator must hear about it');
    // The claim is already gone; the next sweep finds nothing and the daily
    // drift digest still reports the ticket. Better than re-stranding it.
    assert.ok(ops.some(o => o.op === 'delete'));
  });

  it('one bad claim does not stop the rest of the sweep', async () => {
    let calls = 0;
    const { sweepStaleDraftClaims } = loadModule({
      staleRows: [claim({ id: 1, gorgias_ticket_id: 11 }), claim({ id: 2, gorgias_ticket_id: 22 })],
      gorgias: {
        getTicket: async (id) => {
          calls++;
          if (calls === 1) throw new Error('boom');
          return { id, customer: { email: 'c@example.com' } };
        },
      },
    });

    const { swept } = await sweepStaleDraftClaims();

    assert.equal(swept.length, 2);
    assert.equal(swept[0].status, 'failed');
    assert.notEqual(swept[1].status, 'failed');
  });

  it('survives a query error without throwing into the timer', async () => {
    delete require.cache[MODULE_PATH];
    require.cache[SUPABASE_PATH] = {
      id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true, exports: {
        getSupabaseClient: () => ({
          from: () => ({
            select: () => ({
              eq: () => ({ contains: () => ({ lt: () => ({ gt: () => ({
                order: () => Promise.resolve({ data: null, error: { message: 'connection failure' } }),
              }) }) }) }),
            }),
          }),
        }),
      },
    };
    require.cache[GORGIAS_PATH] = {
      id: GORGIAS_PATH, filename: GORGIAS_PATH, loaded: true,
      exports: { findUser: async () => null, getTicket: async () => ({}), getTicketMessages: async () => [], delay: async () => {} },
    };
    const { sweepStaleDraftClaims } = require('../intake/processGorgiasTickets');

    const result = await sweepStaleDraftClaims();

    assert.deepEqual(result, { swept: [] });
    assert.ok(logs.some(l => /claim-sweep/.test(l)));
  });

  it('the staleness cutoff stays far beyond a real draft', async () => {
    // Stealing a LIVE claim would reintroduce the duplicate Opus spend the whole
    // claim mechanism exists to stop. Production drafts run 18-44s.
    const { STALE_CLAIM_MS, CLAIM_SWEEP_MAX_AGE_MS } = loadModule();
    assert.ok(STALE_CLAIM_MS >= 10 * 60 * 1000, 'cutoff must dwarf a real draft');
    assert.ok(CLAIM_SWEEP_MAX_AGE_MS > STALE_CLAIM_MS);
  });
});
