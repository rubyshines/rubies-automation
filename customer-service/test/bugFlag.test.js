/**
 * Unit tests for the Bug flag — the "this ticket is blocked on an advisor fix"
 * marker behind the dashboard's Bug tab.
 *
 * The whole design rests on one property: the flag is ORTHOGONAL to ticket
 * status. It has to survive send-and-close, because the everyday case is a draft
 * the operator rewrites and sends while the underlying bug is still outstanding.
 * The way that property gets broken is by someone copying the On Me handler
 * (which writes `status` and banks the focus timer) as the starting point, so
 * the load-bearing assertions here are the negative ones: these handlers write
 * the two bug columns and nothing else.
 *
 * Run: node --test customer-service/test/bugFlag.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const gorgiasPath = require.resolve('../import/gorgiasClient');
const autoLinkerPath = require.resolve('../lib/autoLinker');

let TICKET;           // row returned for the cs_tickets select
const captured = {};  // writes + query shape + gorgias calls

function makeSupabase() {
  function builder(table) {
    const state = { table, cols: '', eqs: [], nots: [], orders: [] };
    const b = {
      select(cols) { state.cols = cols || ''; return b; },
      update(payload) { (captured.updates ||= []).push({ table, payload }); return b; },
      insert(payload) { (captured.inserts ||= []).push({ table, payload }); return b; },
      eq(col, val) { state.eqs.push([col, val]); (captured.eqs ||= []).push([col, val]); return b; },
      not(col, op, val) { state.nots.push([col, op, val]); (captured.nots ||= []).push([col, op, val]); return b; },
      is() { return b; },
      in() { return b; },
      order(col, opts) { state.orders.push([col, opts]); (captured.orders ||= []).push([col, opts]); return b; },
      limit() { return b; },
      single() { return Promise.resolve(read(state)); },
      maybeSingle() { return Promise.resolve(read(state)); },
      then(onF, onR) { return Promise.resolve(read(state)).then(onF, onR); },
    };
    return b;
  }
  return { from: (table) => builder(table) };
}

function read(state) {
  if (state.table === 'cs_tickets' && state.cols.includes('bug_flagged_at')) {
    captured.lastQuery = state;
    // The tab query is a list read; the handler reads are single-row.
    return { data: captured.listMode ? [] : TICKET, error: null };
  }
  return { data: null, error: null };
}

require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: { getSupabaseClient: () => makeSupabase() },
};

require.cache[gorgiasPath] = {
  id: gorgiasPath, filename: gorgiasPath, loaded: true,
  exports: {
    createTicketReply: async () => ({ id: 1 }),
    snoozeTicket: async (ticketId) => { (captured.gorgias ||= []).push(['snooze', ticketId]); },
    closeTicket: async (ticketId) => { (captured.gorgias ||= []).push(['close', ticketId]); },
    assignTicket: async (ticketId) => { (captured.gorgias ||= []).push(['assign', ticketId]); },
    addTicketTag: async () => {},
    createOutboundTicket: async () => ({ id: 1 }),
    getTicketMessages: async () => [],
  },
};

require.cache[autoLinkerPath] = {
  id: autoLinkerPath, filename: autoLinkerPath, loaded: true,
  exports: { autoLinkProducts: (html) => html },
};

const { apiFlagBug, apiClearBug, apiGetTickets } = require('../dashboard/server');

// Columns a bug handler must never write. status/active_draft_id would collapse
// the flag back into a status; updated_at would silently reorder New and On Me,
// which sort on it, so flagging would look like activity on the conversation.
const FORBIDDEN = ['status', 'active_draft_id', 'updated_at', 'closed_at', 'snoozed_at', 'parked_at', 'focus_time_seconds'];

function assertOnlyBugColumns(update) {
  for (const col of FORBIDDEN) {
    assert.ok(!(col in update.payload), `bug handlers must never write ${col} — that is what keeps the flag orthogonal to status`);
  }
  for (const col of Object.keys(update.payload)) {
    assert.ok(col === 'bug_flagged_at' || col === 'bug_note', `unexpected column written: ${col}`);
  }
}

beforeEach(() => {
  for (const k of Object.keys(captured)) delete captured[k];
});

describe('apiFlagBug', () => {
  it('stamps bug_flagged_at and stores the note on an unflagged ticket', async () => {
    TICKET = { id: 7, bug_flagged_at: null };
    const result = await apiFlagBug(7, { note: 'asked for a size the order already stated' });

    assert.equal(result.success, true);
    const update = captured.updates.find(u => u.table === 'cs_tickets');
    assert.ok(update.payload.bug_flagged_at, 'flag timestamp stamped');
    assert.equal(update.payload.bug_note, 'asked for a size the order already stated');
    assertOnlyBugColumns(update);
  });

  it('flags with no note when the operator skips the prompt', async () => {
    TICKET = { id: 8, bug_flagged_at: null };
    await apiFlagBug(8, {});

    const update = captured.updates.find(u => u.table === 'cs_tickets');
    assert.ok(update.payload.bug_flagged_at);
    assert.ok(!('bug_note' in update.payload), 'an absent note leaves the column alone');
  });

  it('does NOT reset the clock when re-flagging — the age is the nag', async () => {
    const original = '2026-08-20T10:00:00.000Z';
    TICKET = { id: 9, bug_flagged_at: original };
    const result = await apiFlagBug(9, { note: 'still broken, now with detail' });

    const update = captured.updates.find(u => u.table === 'cs_tickets');
    assert.ok(!('bug_flagged_at' in update.payload), 'an already-flagged ticket keeps its original timestamp');
    assert.equal(update.payload.bug_note, 'still broken, now with detail');
    assert.equal(result.bug_flagged_at, original);
  });

  it('writes nothing at all when there is nothing to change', async () => {
    TICKET = { id: 10, bug_flagged_at: '2026-08-20T10:00:00.000Z' };
    await apiFlagBug(10, {});
    assert.equal(captured.updates, undefined, 'a no-op re-flag does not touch the row');
  });

  it('never calls Gorgias — the flag is ours alone', async () => {
    TICKET = { id: 11, bug_flagged_at: null };
    await apiFlagBug(11, { note: 'x' });
    assert.equal(captured.gorgias, undefined);
  });

  it('rejects an unknown ticket rather than writing a phantom row', async () => {
    TICKET = null;
    await assert.rejects(() => apiFlagBug(999, {}), /Ticket not found/);
    assert.equal(captured.updates, undefined);
  });
});

describe('apiClearBug', () => {
  it('nulls both columns and touches nothing else', async () => {
    TICKET = { id: 12, bug_flagged_at: '2026-08-20T10:00:00.000Z' };
    const result = await apiClearBug(12);

    assert.equal(result.success, true);
    const update = captured.updates.find(u => u.table === 'cs_tickets');
    assert.equal(update.payload.bug_flagged_at, null);
    assert.equal(update.payload.bug_note, null);
    assertOnlyBugColumns(update);
    assert.equal(captured.gorgias, undefined);
  });
});

describe('the Bug tab query', () => {
  it('filters on the flag and NOT on status, so it spans open, On Me and closed', async () => {
    captured.listMode = true;
    await apiGetTickets(new URLSearchParams({ tab: 'bug' }));

    assert.deepEqual(captured.nots, [['bug_flagged_at', 'is', null]]);
    const statusFilter = (captured.eqs || []).find(([col]) => col === 'status');
    assert.equal(statusFilter, undefined,
      'a status filter here would hide exactly the case the flag exists for — a bug on a ticket already answered and closed');
  });

  it('ages on the flag, oldest first, not on the conversation clock', async () => {
    captured.listMode = true;
    await apiGetTickets(new URLSearchParams({ tab: 'bug' }));

    assert.deepEqual(captured.orders, [['bug_flagged_at', { ascending: true }]]);
  });

  it('selects the bug columns on every tab, so the badge renders outside the Bug tab too', async () => {
    captured.listMode = true;
    await apiGetTickets(new URLSearchParams({ tab: 'new' }));

    assert.ok(captured.lastQuery.cols.includes('bug_flagged_at'));
    assert.ok(captured.lastQuery.cols.includes('bug_note'));
  });
});

describe('the guards can see something', () => {
  // The status assertion above passes trivially if the stub never records an
  // eq() at all. This is the positive control: an ordinary tab DOES filter on
  // status, so an empty `captured.eqs` would be a broken harness, not a pass.
  it('an ordinary tab still filters on status', async () => {
    captured.listMode = true;
    await apiGetTickets(new URLSearchParams({ tab: 'onme' }));
    assert.deepEqual(captured.eqs, [['status', 'pending_operator']]);
  });
});
