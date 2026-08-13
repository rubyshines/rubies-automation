/**
 * Unit tests for the intake draft claim — claimDraftSlot / releaseDraftSlot and
 * commitDraft's claim fill-in path.
 *
 * Why this exists: Gorgias emits ticket-message-created once per message, and
 * the offline chat widget lands a whole flow transcript at once (measured: 8-10
 * customer messages inside one second). Every delivery ran a full Opus draft,
 * all of them resolved to the SAME latest customer message, and all but one
 * were discarded at INSERT on UNIQUE(gorgias_ticket_id, gorgias_message_id).
 * The dedupe was correct but sat AFTER the expensive work, so every redundant
 * draft was paid for — measured at ~49% of advisor spend on real tickets over
 * 30 days. The claim moves that same dedupe to BEFORE the advisor call.
 *
 * Invariants pinned here:
 *   1. A claim collision (23505) returns null — the loser must spend nothing.
 *   2. Any other claim error also returns null (fail closed: never risk a
 *      second draft for a message another worker may own).
 *   3. The claim row is created 'superseded' so it stays out of dashboard
 *      queues and the previous-draft narrative until it is filled in.
 *   4. With a claim held, commitDraft UPDATEs that row — inserting would
 *      collide with our own claim — and still supersedes only OLDER pending
 *      drafts and moves active_draft_id forward only.
 *   5. Without a claim, commitDraft keeps its original insert behaviour.
 *
 * Run: node --test customer-service/test/draftClaim.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'http://test';
process.env.SUPABASE_SERVICE_KEY ||= 'test';
process.env.GORGIAS_DOMAIN ||= 'test';
process.env.GORGIAS_API_KEY ||= 'test';
process.env.GORGIAS_EMAIL ||= 'test@test.com';

const {
  claimDraftSlot,
  releaseDraftSlot,
  commitDraft,
} = require('../intake/processGorgiasTickets');

// Chainable stub. `result` is what any terminal .single() resolves to; every
// operation is recorded with its filter chain.
function makeSupabase({ result = { data: null, error: null }, results = null, staleLookup = { data: null } } = {}) {
  const ops = [];
  const queue = results ? [...results] : null;
  const nextResult = () => (queue && queue.length ? queue.shift() : result);
  function builder(table) {
    const call = { table, op: null, values: null, filters: [] };
    const api = {
      insert(values) { call.op = 'insert'; call.values = values; return api; },
      update(values) { call.op = 'update'; call.values = values; return api; },
      delete() { call.op = 'delete'; return api; },
      select() { call.op = call.op || 'select'; return api; },
      eq(col, val) { call.filters.push(['eq', col, val]); return api; },
      is(col, val) { call.filters.push(['is', col, val]); return api; },
      contains(col, val) { call.filters.push(['contains', col, val]); return api; },
      lt(col, val) { call.filters.push(['lt', col, val]); return api; },
      or(expr) { call.filters.push(['or', expr]); return api; },
      async maybeSingle() { ops.push(call); return staleLookup; },
      async single() { ops.push(call); return nextResult(); },
      then(resolve) { ops.push(call); resolve({ data: null, error: null }); },
    };
    return api;
  }
  return { from: builder, _ops: ops };
}

const DUP = { data: null, error: { code: '23505', message: 'duplicate key value' } };

const DRAFT_FIELDS = { gorgias_ticket_id: 555, gorgias_message_id: 999, draft_response: 'hi' };

describe('claimDraftSlot', () => {
  it('wins the claim: returns the row and writes a superseded placeholder', async () => {
    const sb = makeSupabase({ result: { data: { id: 42 }, error: null } });
    const claim = await claimDraftSlot(sb, 555, 999);

    assert.deepEqual(claim, { id: 42 });
    assert.equal(sb._ops.length, 1);

    const [insert] = sb._ops;
    assert.deepEqual([insert.table, insert.op], ['cs_ai_drafts', 'insert']);
    assert.equal(insert.values.gorgias_ticket_id, 555);
    assert.equal(insert.values.gorgias_message_id, 999);
    // 'superseded' is what keeps the placeholder out of the dashboard queue and
    // out of buildPreviousDraftContext's narrative before it is filled in.
    assert.equal(insert.values.status, 'superseded');
    assert.equal(insert.values.structured_output.intake_claim, true);
    // cs_ai_drafts.draft_response is NOT NULL. Omitting it makes every claim
    // fail, claimDraftSlot return null, and NOTHING ever draft — a silent CS
    // outage that a stubbed Supabase cannot reproduce. Pin it.
    assert.equal(insert.values.draft_response, '');
  });

  it('loses the claim (23505) to a LIVE claim: returns null so the loser spends nothing', async () => {
    // staleLookup returns nothing → the existing claim is live, leave it alone.
    const sb = makeSupabase({ result: DUP, staleLookup: { data: null } });
    const claim = await claimDraftSlot(sb, 555, 999);

    assert.equal(claim, null);
    // One failed insert plus the staleness check. Crucially: no second insert.
    assert.deepEqual(sb._ops.map(o => o.op), ['insert', 'select']);
  });

  it('reclaims a STALE claim stranded by a dead worker, then drafts', async () => {
    // First insert collides; the stale lookup finds an unfilled old claim; the
    // retry insert wins.
    const sb = makeSupabase({
      results: [DUP, { data: { id: 77 }, error: null }],
      staleLookup: { data: { id: 42 } },
    });
    const claim = await claimDraftSlot(sb, 555, 999);

    assert.deepEqual(claim, { id: 77 });
    assert.deepEqual(sb._ops.map(o => o.op), ['insert', 'select', 'delete', 'insert']);

    // The lookup must only ever match OUR unfilled intake claims: a committed
    // draft has draft_response set, and the auto-close claim uses a different
    // marker. Stealing either would be a duplicate customer reply.
    const lookup = sb._ops[1];
    assert.deepEqual(lookup.filters.slice(0, 4), [
      ['eq', 'gorgias_ticket_id', 555],
      ['eq', 'gorgias_message_id', 999],
      ['eq', 'draft_response', ''],
      ['contains', 'structured_output', { intake_claim: true }],
    ]);
    // ...and only rows older than the staleness cutoff.
    assert.equal(lookup.filters[4][0], 'lt');
    assert.equal(lookup.filters[4][1], 'created_at');

    assert.deepEqual(sb._ops[2].filters, [['eq', 'id', 42]]); // deletes the stale row, not ours
  });

  it('two workers race to reclaim the same stale claim: the loser still returns null', async () => {
    // Both see the stale row and both delete; the retry insert collides again.
    const sb = makeSupabase({ results: [DUP, DUP], staleLookup: { data: { id: 42 } } });
    assert.equal(await claimDraftSlot(sb, 555, 999), null);
    assert.deepEqual(sb._ops.map(o => o.op), ['insert', 'select', 'delete', 'insert']);
  });

  it('claim errors for any other reason: fails closed, still returns null', async () => {
    const sb = makeSupabase({ result: { data: null, error: { code: '08006', message: 'connection failure' } } });
    assert.equal(await claimDraftSlot(sb, 555, 999), null);
  });
});

describe('releaseDraftSlot', () => {
  it('deletes exactly the claim row', async () => {
    const sb = makeSupabase();
    await releaseDraftSlot(sb, 42);

    assert.deepEqual(sb._ops.map(o => [o.table, o.op]), [['cs_ai_drafts', 'delete']]);
    assert.deepEqual(sb._ops[0].filters, [['eq', 'id', 42]]);
  });

  it('never throws when the delete fails — a stuck claim beats a double send', async () => {
    const exploding = { from() { throw new Error('network down'); } };
    await assert.doesNotReject(() => releaseDraftSlot(exploding, 42));
  });
});

describe('commitDraft with a claim held', () => {
  it('fills in the claim row by UPDATE, then supersedes and repoints as before', async () => {
    const sb = makeSupabase({ result: { data: { id: 42 }, error: null } });
    const result = await commitDraft(sb, {
      ticketRowId: 7, gorgiasTicketId: 555, draftFields: DRAFT_FIELDS, claimId: 42,
    });

    assert.deepEqual(result, { id: 42 });
    assert.deepEqual(sb._ops.map(o => [o.table, o.op]), [
      ['cs_ai_drafts', 'update'],   // NOT insert — that would collide with our own claim
      ['cs_ai_drafts', 'update'],
      ['cs_tickets', 'update'],
    ]);

    const [fill, supersede, repoint] = sb._ops;
    // The fill-in carries the caller's fields PLUS the status flip: the claim
    // row was inserted 'superseded' to stay out of the dashboard queues while
    // unfilled, and filling it in is the moment it becomes a real draft. This
    // assertion used to compare by reference, which is what let the missing
    // flip ship — every claim-path draft stayed superseded and the send path
    // refused it ("Draft N is not pending"), 2026-08-12 to 2026-08-13.
    assert.deepEqual(fill.values, { ...DRAFT_FIELDS, status: 'pending' });
    assert.deepEqual(fill.filters, [['eq', 'id', 42]]);

    assert.deepEqual(supersede.values, { status: 'superseded' });
    assert.deepEqual(supersede.filters, [
      ['eq', 'gorgias_ticket_id', 555],
      ['eq', 'status', 'pending'],
      ['lt', 'id', 42],
    ]);

    assert.deepEqual(repoint.values, { active_draft_id: 42 });
    assert.deepEqual(repoint.filters, [
      ['eq', 'id', 7],
      ['or', 'active_draft_id.is.null,active_draft_id.lt.42'],
    ]);
  });

  it('fill-in failure returns the error and writes nothing else', async () => {
    const err = { code: '22P02', message: 'invalid input' };
    const sb = makeSupabase({ result: { data: null, error: err } });
    const result = await commitDraft(sb, {
      ticketRowId: 7, gorgiasTicketId: 555, draftFields: DRAFT_FIELDS, claimId: 42,
    });

    assert.deepEqual(result, { error: err });
    assert.deepEqual(sb._ops.map(o => o.op), ['update']);
  });

  it('without a claim, the original insert path is unchanged', async () => {
    const sb = makeSupabase({ result: { data: { id: 42 }, error: null } });
    const result = await commitDraft(sb, { ticketRowId: 7, gorgiasTicketId: 555, draftFields: DRAFT_FIELDS });

    assert.deepEqual(result, { id: 42 });
    assert.deepEqual(sb._ops.map(o => o.op), ['insert', 'update', 'update']);
  });
});
