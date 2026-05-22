/**
 * Unit tests for the dashboard's apiSendDraft handler.
 *
 * These cover the server-side backstop that prevents a cross-ticket send
 * misfire: a send is bound to a specific draft, and a draft that is no longer
 * `pending` is rejected before any Gorgias write. This is the data-layer
 * guarantee behind the client's draft-scoped dispatch — if the dashboard ever
 * fires a stale duplicate at an already-sent draft, the reply never lands.
 *
 * Run: node --test customer-service/test/apiSendDraft.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub Supabase, Gorgias, and autoLinker BEFORE requiring server.js
// ---------------------------------------------------------------------------

const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const gorgiasPath = require.resolve('../import/gorgiasClient');
const autoLinkerPath = require.resolve('../lib/autoLinker');

// Mutable test state, reset per test.
let DRAFT;            // the row returned for cs_ai_drafts select('*')
const captured = {};  // captures writes + gorgias calls

// Chainable Supabase mock. Intermediate methods return the builder (which is
// itself thenable so `update(...).eq(...)` can be awaited); terminal reads
// (single/maybeSingle) resolve to configured data keyed by table + columns.
function makeSupabase() {
  function builder(table) {
    const state = { table, cols: '', op: 'select', payload: null };
    const b = {
      select(cols) { state.op = 'select'; state.cols = cols || ''; return b; },
      insert(payload) { state.op = 'insert'; state.payload = payload; (captured.inserts ||= []).push({ table, payload }); return b; },
      update(payload) { state.op = 'update'; state.payload = payload; (captured.updates ||= []).push({ table, payload }); return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      limit() { return b; },
      single() { return Promise.resolve(resolveRead(state)); },
      maybeSingle() { return Promise.resolve(resolveRead(state)); },
      // Thenable: update/insert chains are awaited directly.
      then(onF, onR) { return Promise.resolve({ data: null, error: null }).then(onF, onR); },
    };
    return b;
  }
  return { from: (table) => builder(table) };
}

function resolveRead(state) {
  const key = `${state.table}:${state.cols}`;
  switch (key) {
    case 'cs_ai_drafts:*':
      return { data: DRAFT, error: null };
    case 'cs_ai_drafts:draft_response':
      return { data: { draft_response: DRAFT.draft_response }, error: null };
    case 'cs_tickets:conversation_history':
      return { data: { conversation_history: [] }, error: null };
    default:
      return { data: null, error: null };
  }
}

require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: { getSupabaseClient: () => makeSupabase() },
};

require.cache[gorgiasPath] = {
  id: gorgiasPath, filename: gorgiasPath, loaded: true,
  exports: {
    createTicketReply: async (ticketId, payload) => {
      (captured.replies ||= []).push({ ticketId, payload });
      return { id: 9999 };
    },
    snoozeTicket: async (ticketId, days) => { (captured.snoozes ||= []).push({ ticketId, days }); },
    closeTicket: async (ticketId) => { (captured.closes ||= []).push({ ticketId }); },
    assignTicket: async () => {},
    addTicketTag: async () => {},
    createOutboundTicket: async () => ({ id: 1 }),
    getTicketMessages: async () => [],
  },
};

require.cache[autoLinkerPath] = {
  id: autoLinkerPath, filename: autoLinkerPath, loaded: true,
  exports: { autoLinkProducts: (html) => html },
};

const { apiSendDraft } = require('../dashboard/server');

// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const k of Object.keys(captured)) delete captured[k];
  DRAFT = {
    id: 1106,
    gorgias_ticket_id: 555,
    draft_response: 'Hi, original advisor draft text.',
    structured_output: {},
    advisor_status: 'ready',
    confidence: 'high',
    message_type: 'shipping',
    turn_number: 1,
    customer_email: 'a@b.com',
    order_number: '#30736',
    status: 'pending',
  };
});

describe('apiSendDraft — backstop guard', () => {
  it('rejects a send when the draft is no longer pending, before any Gorgias write', async () => {
    DRAFT.status = 'sent'; // a stale duplicate aimed at an already-sent draft
    await assert.rejects(
      () => apiSendDraft(1106, { response: 'Hi Brigitte, you are welcome!', after: 'snooze' }),
      /not pending/,
    );
    assert.equal(captured.replies, undefined, 'no Gorgias reply should be posted for a non-pending draft');
    assert.equal(captured.snoozes, undefined, 'no Gorgias snooze should happen for a non-pending draft');
  });
});

describe('apiSendDraft — identity binding', () => {
  it('posts the reply to the draft\'s own gorgias_ticket_id with the given body', async () => {
    const result = await apiSendDraft(1106, { response: 'Hi, splitting your shipment now.', after: 'snooze' });

    assert.equal(captured.replies.length, 1);
    assert.equal(captured.replies[0].ticketId, 555, 'reply must go to the draft\'s own ticket');
    assert.equal(captured.replies[0].payload.body_text, 'Hi, splitting your shipment now.');

    // The draft row is marked sent with the exact body that was sent.
    const draftUpdate = captured.updates.find(u => u.table === 'cs_ai_drafts' && u.payload.status === 'sent');
    assert.ok(draftUpdate, 'draft should be updated to status=sent');
    assert.equal(draftUpdate.payload.sent_response, 'Hi, splitting your shipment now.');
    assert.equal(result.success, true);
  });

  it('sends the stored draft_response when no override body is provided', async () => {
    await apiSendDraft(1106, { after: 'snooze' });
    assert.equal(captured.replies[0].payload.body_text, 'Hi, original advisor draft text.');
  });
});
