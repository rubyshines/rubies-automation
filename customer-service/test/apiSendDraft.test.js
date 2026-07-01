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
let SIBLING_DRAFTS;   // rows returned for the cs_ai_drafts ticket-union select (actions + action_type + action_executed_at)
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
      // Thenable: update/insert chains and multi-row selects are awaited
      // directly; reads resolve through resolveRead (default {data: null}).
      then(onF, onR) { return Promise.resolve(resolveRead(state)).then(onF, onR); },
    };
    return b;
  }
  return { from: (table) => builder(table) };
}

// Match on table + which columns are requested, tolerant of column-list changes
// (the ticket-union select grew from 'actions' to 'actions, action_type,
// action_executed_at' — matching on inclusion keeps the stub from breaking when
// the real query adds columns).
function resolveRead(state) {
  const { table, cols } = state;
  if (table === 'cs_ai_drafts') {
    if (cols === '*') return { data: DRAFT, error: null };
    if (cols.includes('draft_response')) return { data: { draft_response: DRAFT.draft_response }, error: null };
    if (cols.includes('actions')) return { data: SIBLING_DRAFTS, error: null };
  }
  if (table === 'cs_tickets' && cols.includes('conversation_history')) {
    return { data: { conversation_history: [] }, error: null };
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

const { apiSendDraft, actionTypeFromTool, WRITE_TOOLS } = require('../dashboard/server');

// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const k of Object.keys(captured)) delete captured[k];
  SIBLING_DRAFTS = null;
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

describe('apiSendDraft — unexecuted-action guard', () => {
  it('blocks a send whose proposed action_type has no executed action filed', async () => {
    DRAFT.action_type = 'order_modification';
    DRAFT.actions = [];
    await assert.rejects(
      () => apiSendDraft(1106, { response: 'I have updated your shipping address.', after: 'snooze' }),
      (err) => err.code === 'unexecuted_action' && err.statusCode === 409,
    );
    assert.equal(captured.replies, undefined, 'no Gorgias reply should be posted while the proposal is unexecuted');
  });

  it('a non-matching executed action (e.g. warehouse_hold) does not satisfy the proposal', async () => {
    DRAFT.action_type = 'order_modification';
    DRAFT.actions = [{ action_type: 'warehouse_hold', executed_at: '2026-06-05T02:52:39Z', summary: 'hold placed' }];
    await assert.rejects(
      () => apiSendDraft(1106, { response: 'I have updated your shipping address.', after: 'snooze' }),
      (err) => err.code === 'unexecuted_action',
    );
    assert.equal(captured.replies, undefined);
  });

  it('allows the send once a matching action is filed in actions[]', async () => {
    DRAFT.action_type = 'order_modification';
    DRAFT.actions = [{ action_type: 'order_modification', executed_at: '2026-06-10T17:48:28Z', summary: 'address updated' }];
    const result = await apiSendDraft(1106, { response: 'I have updated your shipping address.', after: 'snooze' });
    assert.equal(result.success, true);
    assert.equal(captured.replies.length, 1);
  });

  it('unions executed actions across the ticket\'s sibling drafts', async () => {
    DRAFT.action_type = 'refund';
    DRAFT.actions = [];
    DRAFT.ticket_id = 42;
    SIBLING_DRAFTS = [
      { actions: [] },
      { actions: [{ action_type: 'refund', executed_at: '2026-06-09T12:00:00Z', summary: 'refunded' }] },
    ];
    const result = await apiSendDraft(1106, { response: 'Your refund is on its way.', after: 'snooze' });
    assert.equal(result.success, true);
  });

  it('compound proposals require every component (exchange+refund with only exchange executed blocks)', async () => {
    DRAFT.action_type = 'exchange+refund';
    DRAFT.actions = [{ action_type: 'exchange', executed_at: '2026-06-09T12:00:00Z', summary: 'exchange created' }];
    await assert.rejects(
      () => apiSendDraft(1106, { response: 'Exchange created and refund issued.', after: 'snooze' }),
      (err) => err.code === 'unexecuted_action',
    );
  });

  // Regression for ticket #106100788: the operator agent did BOTH the exchange
  // and the refund and stamped action_executed_at, but filed a single actions[]
  // entry labelled just "exchange" (its summary said "Both done"). The gate must
  // treat the executed compound proposal as satisfied — no spurious "send
  // anyway?" confirm, which was bouncing the ticket back into New.
  it('a compound proposal whose action_executed_at is stamped sends even if actions[] filed only one label', async () => {
    DRAFT.action_type = 'exchange+refund';
    DRAFT.action_executed_at = '2026-06-30T23:57:32Z';
    DRAFT.actions = [{ action_type: 'exchange', executed_at: '2026-06-30T23:57:32Z', summary: 'Both done: exchange + refund' }];
    const result = await apiSendDraft(1106, { response: 'Exchange created and refund issued.', after: 'close' });
    assert.equal(result.success, true);
    assert.equal(captured.replies.length, 1);
  });

  it('force_unexecuted_action overrides the guard after operator confirmation', async () => {
    DRAFT.action_type = 'order_modification';
    DRAFT.actions = [];
    const result = await apiSendDraft(1106, {
      response: 'Sending without the edit, on purpose.',
      after: 'snooze',
      force_unexecuted_action: true,
    });
    assert.equal(result.success, true);
    assert.equal(captured.replies.length, 1);
  });

  // Regression for #31584: the advisor proposed order_modification and the
  // operator agent expedited the order via update_shipping_speed. The expedite
  // committed to Warehance but was filed onto the draft as order_modification
  // (see actionTypeFromTool), so the guard must treat it as satisfied — no
  // spurious "send anyway?" prompt for a legit expedite.
  it('an executed update_shipping_speed (filed as order_modification) satisfies the proposal', async () => {
    DRAFT.action_type = 'order_modification';
    DRAFT.actions = [{ action_type: 'order_modification', executed_at: '2026-06-15T12:07:56Z', summary: 'Shipping updated to US Expedited Shipping' }];
    const result = await apiSendDraft(1106, { response: "I've expedited your package, no extra charge.", after: 'snooze' });
    assert.equal(result.success, true);
    assert.equal(captured.replies.length, 1);
  });
});

describe('action ledger — update_shipping_speed registration', () => {
  it('update_shipping_speed is a recognized write tool (so its execution gets filed)', () => {
    assert.ok(WRITE_TOOLS.has('update_shipping_speed'),
      'update_shipping_speed must be in WRITE_TOOLS or its execution is never filed to actions[]');
  });

  it('update_shipping_speed files under the order_modification action_type', () => {
    // The advisor proposes order_modification for a shipping upgrade; the
    // executed tool must file under the same type or the send guard misfires.
    assert.equal(actionTypeFromTool('update_shipping_speed', null), 'order_modification');
    assert.equal(actionTypeFromTool('update_shipping_speed', 'order_modification'), 'order_modification');
  });
});
