/**
 * Unit tests for commitDraft — the insert → supersede → repoint sequence.
 *
 * Regression pin for the 2026-07-09 incident: two intake runs raced on a
 * two-message chat burst. The old order (supersede-then-insert) let the
 * losing run mark the winner's fresh draft 'superseded', then die on the
 * UNIQUE (gorgias_ticket_id, gorgias_message_id) insert — stranding the
 * ticket's only draft as superseded with no replacement, which the dashboard
 * rendered but the send path refused ("Draft X is not pending").
 *
 * Invariants pinned here:
 *   1. Insert happens FIRST; a failed insert (duplicate or otherwise) issues
 *      no writes at all.
 *   2. Supersede targets only OLDER pending drafts (id < new id) on the same
 *      Gorgias ticket.
 *   3. active_draft_id only moves forward (null or < new id).
 *
 * Run: node --test customer-service/test/commitDraft.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Env required by upstream requires; values don't matter for these tests.
process.env.SUPABASE_URL ||= 'http://test';
process.env.SUPABASE_SERVICE_KEY ||= 'test';
process.env.GORGIAS_DOMAIN ||= 'test';
process.env.GORGIAS_API_KEY ||= 'test';
process.env.GORGIAS_EMAIL ||= 'test@test.com';

const { commitDraft } = require('../intake/processGorgiasTickets');

// Chainable supabase stub: records every terminal operation with its filter
// chain; the insert result is scripted per-test.
function makeSupabase({ insertResult }) {
  const ops = [];
  function builder(table) {
    const call = { table, op: null, values: null, filters: [] };
    const api = {
      insert(values) { call.op = 'insert'; call.values = values; return api; },
      update(values) { call.op = 'update'; call.values = values; return api; },
      select() { return api; },
      eq(col, val) { call.filters.push(['eq', col, val]); return api; },
      lt(col, val) { call.filters.push(['lt', col, val]); return api; },
      or(expr) { call.filters.push(['or', expr]); return api; },
      async single() { ops.push(call); return insertResult; },
      // updates resolve without .single()
      then(resolve) { ops.push(call); resolve({ data: null, error: null }); },
    };
    return api;
  }
  return { from: builder, _ops: ops };
}

const DRAFT_FIELDS = { gorgias_ticket_id: 555, gorgias_message_id: 999, draft_response: 'hi' };

describe('commitDraft', () => {
  it('happy path: inserts first, supersedes only older pending drafts, repoints monotonically', async () => {
    const sb = makeSupabase({ insertResult: { data: { id: 42 }, error: null } });
    const result = await commitDraft(sb, { ticketRowId: 7, gorgiasTicketId: 555, draftFields: DRAFT_FIELDS });

    assert.deepEqual(result, { id: 42 });
    assert.deepEqual(sb._ops.map(o => [o.table, o.op]), [
      ['cs_ai_drafts', 'insert'],
      ['cs_ai_drafts', 'update'],
      ['cs_tickets', 'update'],
    ]);

    const [insert, supersede, repoint] = sb._ops;
    assert.equal(insert.values, DRAFT_FIELDS);

    assert.deepEqual(supersede.values, { status: 'superseded' });
    assert.deepEqual(supersede.filters, [
      ['eq', 'gorgias_ticket_id', 555],
      ['eq', 'status', 'pending'],
      ['lt', 'id', 42], // never the draft just inserted, never a NEWER concurrent draft
    ]);

    assert.deepEqual(repoint.values, { active_draft_id: 42 });
    assert.deepEqual(repoint.filters, [
      ['eq', 'id', 7],
      ['or', 'active_draft_id.is.null,active_draft_id.lt.42'], // pointer only moves forward
    ]);
  });

  it('duplicate insert (23505): reports duplicate and writes nothing else', async () => {
    const sb = makeSupabase({ insertResult: { data: null, error: { code: '23505', message: 'duplicate key value' } } });
    const result = await commitDraft(sb, { ticketRowId: 7, gorgiasTicketId: 555, draftFields: DRAFT_FIELDS });

    assert.deepEqual(result, { duplicate: true });
    // The losing run must not supersede the winner's draft — that's the bug.
    assert.deepEqual(sb._ops.map(o => o.op), ['insert']);
  });

  it('other insert error: returns the error and writes nothing else', async () => {
    const err = { code: '22P02', message: 'invalid input' };
    const sb = makeSupabase({ insertResult: { data: null, error: err } });
    const result = await commitDraft(sb, { ticketRowId: 7, gorgiasTicketId: 555, draftFields: DRAFT_FIELDS });

    assert.deepEqual(result, { error: err });
    assert.deepEqual(sb._ops.map(o => o.op), ['insert']);
  });
});
