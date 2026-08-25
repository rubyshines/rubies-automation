/**
 * Unit tests for dashboard handlers acting on an outreach draft that has no
 * Gorgias ticket yet.
 *
 * Outreach drafts stage with `gorgias_ticket_id: null` and the Gorgias ticket
 * is created lazily on send. Every handler reachable from the draft's button
 * row therefore has to treat a null id as "there is nothing there", not as an
 * id to interpolate — otherwise it builds /tickets/null/... and Gorgias
 * answers with a 404 HTML page that surfaces to the operator as a wall of
 * markup. apiCloseDraft was fixed for this once (see apiCloseDraft.test.js);
 * refresh, release and reopen had the same hole, so these assert the class
 * rather than the one instance.
 *
 * The Gorgias stub throws on a null id exactly like the live API does, so a
 * regression fails here as a thrown error rather than a silent extra call.
 *
 * Run: node --test customer-service/test/outreachDraftNoGorgias.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const gorgiasPath = require.resolve('../import/gorgiasClient');
const contextBuilderPath = require.resolve('../lib/contextBuilder');
const composeOutboundPath = require.resolve('../lib/composeOutboundDraft');
const autoLinkerPath = require.resolve('../lib/autoLinker');

let DRAFT;    // row returned for the cs_ai_drafts select
let TICKET;   // row returned for the cs_tickets select
const captured = {};

function makeSupabase() {
  function builder(table) {
    const state = { table, cols: '' };
    const b = {
      select(cols) { state.cols = cols || ''; return b; },
      insert(payload) { (captured.inserts ||= []).push({ table, payload }); return b; },
      update(payload) { (captured.updates ||= []).push({ table, payload }); return b; },
      eq(col, val) { (state.eqs ||= []).push([col, val]); return b; },
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
  if (state.table === 'cs_ai_drafts') return { data: DRAFT, error: null };
  if (state.table === 'cs_tickets') return { data: TICKET, error: null };
  return { data: null, error: null };
}

// Mirrors the live client: a null id builds /tickets/null/... and 404s.
function requireId(name) {
  return async (ticketId, ...rest) => {
    if (!ticketId) throw new Error(`Gorgias API error 404 on /tickets/${ticketId} (${name})`);
    (captured[name] ||= []).push({ ticketId, rest });
    return name === 'getTicketMessages' ? [] : { id: 1 };
  };
}

require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: { getSupabaseClient: () => makeSupabase() },
};

require.cache[gorgiasPath] = {
  id: gorgiasPath, filename: gorgiasPath, loaded: true,
  exports: {
    getTicketMessages: requireId('getTicketMessages'),
    getTicket: requireId('getTicket'),
    assignTicket: requireId('assignTicket'),
    reopenTicket: requireId('reopenTicket'),
    closeTicket: requireId('closeTicket'),
    snoozeTicket: requireId('snoozeTicket'),
    addTicketTag: async () => {},
    createTicketReply: async () => ({ id: 9999 }),
    createOutboundTicket: async () => ({ id: 1 }),
  },
};

require.cache[contextBuilderPath] = {
  id: contextBuilderPath, filename: contextBuilderPath, loaded: true,
  exports: {
    buildContext: async (args) => { captured.contextArgs = args; return { customer: {} }; },
    normalizeEmail: (e) => (e || '').toLowerCase(),
  },
};

require.cache[composeOutboundPath] = {
  id: composeOutboundPath, filename: composeOutboundPath, loaded: true,
  exports: {
    composeOutboundDraft: async (args) => {
      captured.composeArgs = args;
      return { subject: 'About your order', plain_body: 'Recomposed body.' };
    },
  },
};

require.cache[autoLinkerPath] = {
  id: autoLinkerPath, filename: autoLinkerPath, loaded: true,
  exports: { autoLinkProducts: (html) => html },
};

const { apiRefreshDraft, apiReleaseDraft, apiReopenTicket } = require('../dashboard/server');

beforeEach(() => {
  for (const k of Object.keys(captured)) delete captured[k];
  DRAFT = null;
  TICKET = null;
});

describe('apiRefreshDraft — outreach draft with no Gorgias ticket', () => {
  it('recomposes from the steer without touching Gorgias', async () => {
    DRAFT = {
      id: 3540, ticket_id: 3302, gorgias_ticket_id: null,
      customer_email: 'buyer@example.com', order_number: '33009',
      draft_response: 'Original body.', operator_steer: null,
      audit_trail: [], structured_output: {},
    };

    const result = await apiRefreshDraft(3540, { steer: 'offer to split the shipment' });

    assert.equal(result.draft_response, 'Recomposed body.');
    assert.equal(result.draft_id, 3540);
    assert.equal(captured.getTicketMessages, undefined, 'no message fetch for a ticket that does not exist in Gorgias');
    assert.equal(captured.getTicket, undefined, 'no ticket fetch either');
    assert.equal(captured.composeArgs.steer, 'offer to split the shipment');
    assert.equal(captured.composeArgs.orderNumber, '33009');
  });

  it('keeps the prior body in draft_history so the pre-steer draft survives', async () => {
    DRAFT = {
      id: 3540, ticket_id: 3302, gorgias_ticket_id: null,
      customer_email: 'buyer@example.com', order_number: '33009',
      draft_response: 'Original body.', operator_steer: null,
      audit_trail: [], structured_output: {}, draft_history: [],
    };

    await apiRefreshDraft(3540, { steer: 'shorten it' });

    const update = captured.updates.find(u => u.table === 'cs_ai_drafts');
    assert.equal(update.payload.draft_history.length, 1);
    assert.equal(update.payload.draft_history[0].draft_response, 'Original body.');
  });

  it('asks for a steer rather than reporting a Gorgias 404', async () => {
    DRAFT = {
      id: 3540, ticket_id: 3302, gorgias_ticket_id: null,
      customer_email: 'buyer@example.com', order_number: '33009',
      draft_response: 'Original body.', audit_trail: [], structured_output: {},
    };

    await assert.rejects(
      () => apiRefreshDraft(3540, {}),
      (err) => {
        assert.match(err.message, /steer/i);
        assert.doesNotMatch(err.message, /404|gorgias/i, 'the operator must never see a raw API error here');
        return true;
      },
    );
  });
});

describe('apiReleaseDraft — outreach draft with no Gorgias ticket', () => {
  it('releases locally with no Gorgias unassign', async () => {
    DRAFT = { gorgias_ticket_id: null, ticket_id: 3302 };

    const result = await apiReleaseDraft(3540, {});

    assert.equal(result.success, true);
    assert.equal(captured.assignTicket, undefined, 'nothing to unassign in Gorgias');
    const update = captured.updates.find(u => u.table === 'cs_ai_drafts');
    assert.equal(update.payload.status, 'released');
  });

  it('still unassigns for an ordinary inbound draft', async () => {
    DRAFT = { gorgias_ticket_id: 555, ticket_id: 77 };

    await apiReleaseDraft(41, {});

    assert.deepEqual(captured.assignTicket, [{ ticketId: 555, rest: [null] }]);
  });
});

describe('apiReopenTicket — outreach ticket closed before it was ever sent', () => {
  it('flips status locally instead of throwing "Ticket not found"', async () => {
    TICKET = { gorgias_ticket_id: null };

    const result = await apiReopenTicket(3302);

    assert.equal(result.success, true);
    assert.equal(captured.reopenTicket, undefined, 'nothing to reopen in Gorgias');
    const update = captured.updates.find(u => u.table === 'cs_tickets');
    assert.equal(update.payload.status, 'open');
    assert.equal(update.payload.closed_at, null);
  });

  it('still reopens in Gorgias for an ordinary ticket', async () => {
    TICKET = { gorgias_ticket_id: 555 };

    await apiReopenTicket(77);

    assert.deepEqual(captured.reopenTicket, [{ ticketId: 555, rest: [] }]);
  });

  it('reports a genuinely missing ticket as not found', async () => {
    TICKET = null;
    await assert.rejects(() => apiReopenTicket(999), /Ticket not found/);
  });
});
