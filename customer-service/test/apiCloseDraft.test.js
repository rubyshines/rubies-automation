/**
 * Unit tests for the dashboard's apiCloseDraft handler.
 *
 * The case that motivated these: an unsent outreach draft has no Gorgias
 * ticket (it's created at send time), so closing it must skip Gorgias
 * entirely and close the cs_ticket locally by id. Before the fix, close hit
 * POST /tickets/null and failed with "pk is not a valid integer".
 *
 * Run: node --test customer-service/test/apiCloseDraft.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub Supabase and Gorgias BEFORE requiring server.js
// ---------------------------------------------------------------------------

const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const gorgiasPath = require.resolve('../import/gorgiasClient');
const autoLinkerPath = require.resolve('../lib/autoLinker');

let DRAFT;            // row returned for the cs_ai_drafts select
const captured = {};  // captures writes + gorgias calls

function makeSupabase() {
  function builder(table) {
    const state = { table, cols: '' };
    const b = {
      select(cols) { state.cols = cols || ''; return b; },
      insert(payload) { (captured.inserts ||= []).push({ table, payload }); return b; },
      update(payload) { (captured.updates ||= []).push({ table, payload }); return b; },
      eq(col, val) { (state.eqs ||= []).push([col, val]); captured.lastEqs = state.eqs; return b; },
      is() { return b; },
      order() { return b; },
      limit() { return b; },
      single() { return Promise.resolve(resolveRead(state)); },
      maybeSingle() { return Promise.resolve(resolveRead(state)); },
      then(onF, onR) { return Promise.resolve(resolveRead(state)).then(onF, onR); },
    };
    return b;
  }
  return { from: (table) => builder(table) };
}

function resolveRead(state) {
  const { table, cols } = state;
  if (table === 'cs_ai_drafts' && cols.includes('gorgias_ticket_id')) {
    return { data: DRAFT, error: null };
  }
  // cs_tickets note-lifecycle read (id, order_number) — no order attached.
  return { data: null, error: null };
}

require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: { getSupabaseClient: () => makeSupabase() },
};

require.cache[gorgiasPath] = {
  id: gorgiasPath, filename: gorgiasPath, loaded: true,
  exports: {
    createTicketReply: async () => ({ id: 9999 }),
    snoozeTicket: async (ticketId, days) => { (captured.snoozes ||= []).push({ ticketId, days }); },
    closeTicket: async (ticketId) => { (captured.closes ||= []).push({ ticketId }); },
    assignTicket: async (ticketId, who) => { (captured.assigns ||= []).push({ ticketId, who }); },
    addTicketTag: async () => {},
    createOutboundTicket: async () => ({ id: 1 }),
    getTicketMessages: async () => [],
  },
};

require.cache[autoLinkerPath] = {
  id: autoLinkerPath, filename: autoLinkerPath, loaded: true,
  exports: { autoLinkProducts: (html) => html },
};

const { apiCloseDraft } = require('../dashboard/server');

// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const k of Object.keys(captured)) delete captured[k];
});

describe('apiCloseDraft — unsent outreach draft (no Gorgias ticket)', () => {
  it('skips Gorgias entirely and closes the cs_ticket locally by id', async () => {
    DRAFT = { gorgias_ticket_id: null, ticket_id: 2817 };
    const result = await apiCloseDraft(41, { notes: null });

    assert.equal(result.success, true);
    assert.equal(captured.closes, undefined, 'no Gorgias close for a ticket that does not exist there');
    assert.equal(captured.assigns, undefined, 'no Gorgias assign either');

    const draftUpdate = captured.updates.find(u => u.table === 'cs_ai_drafts');
    assert.equal(draftUpdate.payload.status, 'sent');

    const ticketUpdate = captured.updates.find(u => u.table === 'cs_tickets');
    assert.equal(ticketUpdate.payload.status, 'closed');
    assert.ok(ticketUpdate.payload.closed_at, 'closed_at stamped');
  });
});

describe('apiCloseDraft — ordinary inbound draft', () => {
  it('closes and unassigns in Gorgias, then closes the cs_ticket', async () => {
    DRAFT = { gorgias_ticket_id: 555, ticket_id: 77 };
    const result = await apiCloseDraft(42, { notes: null });

    assert.equal(result.success, true);
    assert.deepEqual(captured.closes, [{ ticketId: 555 }]);
    assert.deepEqual(captured.assigns, [{ ticketId: 555, who: null }]);

    const ticketUpdate = captured.updates.find(u => u.table === 'cs_tickets');
    assert.equal(ticketUpdate.payload.status, 'closed');
  });
});
