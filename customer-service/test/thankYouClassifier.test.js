/**
 * Tests for the thank-you auto-close fast path.
 *
 * Covers deterministic gating in tryAutoCloseThankYou — Supabase + classifier
 * are stubbed so no network or API calls happen. The classifier prompt itself
 * is validated separately via the holdout/scenario harness, not here.
 *
 * Run: node --test customer-service/test/thankYouClassifier.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub external modules BEFORE requiring the modules under test ----------------

const classifierPath = require.resolve('../lib/thankYouClassifier');
const gorgiasPath = require.resolve('../import/gorgiasClient');
const supabasePath = require.resolve('../../shared/supabaseClient');
const contextBuilderPath = require.resolve('../lib/contextBuilder');

// Reusable mutable hooks the tests poke
let classifierResult = { auto_close: false, reason: 'default_stub' };
let lastClassifierInput = null;
let lastSentDraftRow = null;
let gorgiasCalls = [];
let supabaseInserts = [];
let supabaseUpdates = [];
let supabaseUpserts = [];

function resetMocks() {
  classifierResult = { auto_close: false, reason: 'default_stub' };
  lastClassifierInput = null;
  lastSentDraftRow = null;
  gorgiasCalls = [];
  supabaseInserts = [];
  supabaseUpdates = [];
  supabaseUpserts = [];
}

require.cache[classifierPath] = {
  id: classifierPath,
  filename: classifierPath,
  loaded: true,
  exports: {
    classifyThankYou: async (input) => {
      lastClassifierInput = input;
      return { ...classifierResult, _usage: { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 20 } };
    },
    formatMessagesForClassifier: (messages, limit = 6) => {
      const recent = (messages || []).slice(-limit);
      return recent
        .map(m => `[${m.from_agent === false ? 'CUSTOMER' : 'AGENT'}] ${m.stripped_text || m.body_text || ''}`)
        .join('\n\n');
    },
    MODEL: 'claude-sonnet-4-6',
  },
};

require.cache[gorgiasPath] = {
  id: gorgiasPath,
  filename: gorgiasPath,
  loaded: true,
  exports: {
    createTicketReply: async (ticketId, body) => {
      gorgiasCalls.push({ fn: 'createTicketReply', ticketId, body });
      return { id: 999 };
    },
    closeTicket: async (ticketId) => { gorgiasCalls.push({ fn: 'closeTicket', ticketId }); return {}; },
    assignTicket: async (ticketId, userId) => { gorgiasCalls.push({ fn: 'assignTicket', ticketId, userId }); return {}; },
    addTicketTag: async (ticketId, tag) => { gorgiasCalls.push({ fn: 'addTicketTag', ticketId, tag }); return {}; },
    stripHtml: (s) => s || '',
    getTicketMessages: async () => [],
    findUser: async () => null,
    addInternalNote: async () => ({}),
  },
};

// Build a chainable Supabase mock that supports the query patterns used by the
// gate: from(table).select(...).eq(...).eq(...).order(...).limit(...).maybeSingle()
// plus insert / upsert / update / select-after-insert.
function makeSupabaseMock() {
  const handler = {
    nextSelectResult: { data: null, error: null }, // controlled per-test
    nextInsertResult: { data: { id: 555 }, error: null },
    nextUpsertResult: { data: { id: 777 }, error: null },
    nextUpdateResult: { data: { id: 555 }, error: null },
  };

  function chain(table) {
    const state = { table, op: 'select' };
    const api = {};
    api.select = () => api;
    api.eq = () => api;
    api.neq = () => api;
    api.in = () => api;
    api.is = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.maybeSingle = async () => handler.nextSelectResult;
    api.single = async () => {
      if (state.op === 'insert') return handler.nextInsertResult;
      if (state.op === 'upsert') return handler.nextUpsertResult;
      if (state.op === 'update') return handler.nextUpdateResult;
      return handler.nextSelectResult;
    };
    api.delete = () => {
      state.op = 'delete';
      supabaseUpdates.push({ table, row: null, op: 'delete' });
      return api;
    };
    api.insert = (row) => {
      state.op = 'insert';
      supabaseInserts.push({ table, row });
      return api;
    };
    api.upsert = (row) => {
      state.op = 'upsert';
      supabaseUpserts.push({ table, row });
      return api;
    };
    api.update = (row) => {
      state.op = 'update';
      supabaseUpdates.push({ table, row });
      return api;
    };
    return api;
  }

  return {
    handler,
    client: { from: chain },
  };
}

let supabaseMock;
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    getSupabaseClient: () => supabaseMock.client,
  },
};

require.cache[contextBuilderPath] = {
  id: contextBuilderPath,
  filename: contextBuilderPath,
  loaded: true,
  exports: { buildContext: async () => null },
};

// Now require module under test -----------------------------------------------

const { tryAutoCloseThankYou } = require('../intake/processGorgiasTickets');
const { formatMessagesForClassifier } = require('../lib/thankYouClassifier');

// Helpers ---------------------------------------------------------------------

function makeMessages(latestText) {
  return [
    {
      id: 1,
      from_agent: false,
      stripped_text: 'hey, when is my order arriving?',
      body_text: 'hey, when is my order arriving?',
      created_datetime: '2026-04-26T10:00:00Z',
    },
    {
      id: 2,
      from_agent: true,
      stripped_text: 'It shipped yesterday — should be there by Tuesday.',
      body_text: 'It shipped yesterday — should be there by Tuesday.',
      created_datetime: '2026-04-26T11:00:00Z',
    },
    {
      id: 3,
      from_agent: false,
      stripped_text: latestText,
      body_text: latestText,
      created_datetime: '2026-04-26T12:00:00Z',
    },
  ];
}

function setLastSentDraft(row) {
  supabaseMock.handler.nextSelectResult = { data: row, error: null };
}

function makeOpts(overrides = {}) {
  return {
    supabase: supabaseMock.client,
    ticketId: 12345,
    messages: makeMessages('thanks!'),
    latestCustomerMsg: { id: 3, stripped_text: 'thanks!', body_text: 'thanks!' },
    ...overrides,
  };
}

// Tests -----------------------------------------------------------------------

describe('tryAutoCloseThankYou — preconditions', () => {
  beforeEach(() => {
    resetMocks();
    supabaseMock = makeSupabaseMock();
  });

  it('returns no_prior_sent_reply when there is no prior sent draft', async () => {
    setLastSentDraft(null);
    const result = await tryAutoCloseThankYou(makeOpts());
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'no_prior_sent_reply');
    assert.equal(lastClassifierInput, null, 'classifier should not be called');
  });

  it('returns prior_was_follow_up_care when last draft was a follow-up nudge', async () => {
    setLastSentDraft({
      id: 100, sent_response: 'just checking in', draft_response: 'just checking in',
      action_type: null, action_executed_at: null, draft_kind: 'follow_up_care',
    });
    const result = await tryAutoCloseThankYou(makeOpts());
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'prior_was_follow_up_care');
    assert.equal(lastClassifierInput, null);
  });

  it('returns open_action_in_flight when prior draft has unexecuted action', async () => {
    setLastSentDraft({
      id: 101, sent_response: 'here is your exchange draft order', draft_response: 'here is your exchange draft order',
      action_type: 'exchange', action_executed_at: null, draft_kind: 'advisor_draft',
    });
    const result = await tryAutoCloseThankYou(makeOpts());
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'open_action_in_flight');
    assert.equal(lastClassifierInput, null);
  });

  it('proceeds past action guard when action_executed_at is set', async () => {
    setLastSentDraft({
      id: 102, sent_response: 'all done!', draft_response: 'all done!',
      action_type: 'refund', action_executed_at: '2026-04-26T11:30:00Z', draft_kind: 'advisor_draft',
    });
    classifierResult = { auto_close: false, reason: 'classifier_said_no' };
    const result = await tryAutoCloseThankYou(makeOpts());
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'classifier_negative');
    assert.ok(lastClassifierInput, 'classifier should be called');
  });

  it('returns empty_message when latest customer message is empty', async () => {
    setLastSentDraft({
      id: 103, sent_response: 'hi', draft_response: 'hi',
      action_type: null, action_executed_at: null, draft_kind: 'advisor_draft',
    });
    const result = await tryAutoCloseThankYou(makeOpts({
      latestCustomerMsg: { id: 3, stripped_text: '   ', body_text: '   ' },
    }));
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'empty_message');
    assert.equal(lastClassifierInput, null);
  });

});

describe('tryAutoCloseThankYou — classifier outcomes', () => {
  beforeEach(() => {
    resetMocks();
    supabaseMock = makeSupabaseMock();
    setLastSentDraft({
      id: 200, sent_response: 'shipped yesterday, arriving Tuesday', draft_response: 'shipped yesterday, arriving Tuesday',
      action_type: null, action_executed_at: null, draft_kind: 'advisor_draft',
    });
  });

  it('does not act when classifier returns auto_close=false', async () => {
    classifierResult = { auto_close: false, reason: 'has_new_question' };
    const result = await tryAutoCloseThankYou(makeOpts());
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'classifier_negative');
    assert.equal(gorgiasCalls.length, 0);
  });

  it('sends + closes when classifier positive', async () => {
    classifierResult = { auto_close: true, reason: 'pure_thanks' };
    supabaseMock.handler.nextUpsertResult = { data: { id: 777 }, error: null };
    supabaseMock.handler.nextInsertResult = { data: { id: 555 }, error: null };

    const result = await tryAutoCloseThankYou(makeOpts());

    assert.equal(result.handled, true);
    assert.equal(result.classifier.auto_close, true);

    // Gorgias write order: reply, close, unassign, two tags
    const fns = gorgiasCalls.map(c => c.fn);
    assert.deepEqual(fns, ['createTicketReply', 'closeTicket', 'assignTicket', 'addTicketTag', 'addTicketTag']);
    const replyCall = gorgiasCalls[0];
    assert.equal(replyCall.ticketId, 12345);
    assert.ok(replyCall.body.body_text.length > 0);

    // cs_tickets upsert with closed status + closing message_type
    const ticketUpsert = supabaseUpserts.find(u => u.table === 'cs_tickets');
    assert.ok(ticketUpsert);
    assert.equal(ticketUpsert.row.status, 'closed');
    assert.equal(ticketUpsert.row.message_type, 'closing');
    assert.equal(ticketUpsert.row.customer_sentiment, 'positive');
    assert.equal(ticketUpsert.row.active_draft_id, null);

    // Atomic claim: cs_ai_drafts insert BEFORE the Gorgias reply, marked as a
    // claim and kept out of dashboard queues (status 'superseded').
    const claimInsert = supabaseInserts.find(i => i.table === 'cs_ai_drafts');
    assert.ok(claimInsert);
    assert.equal(claimInsert.row.structured_output.claim, true);
    assert.equal(claimInsert.row.status, 'superseded');
    assert.equal(claimInsert.row.gorgias_message_id, 3);

    // The claim row is then fleshed out into the real sent draft via update
    const draftUpdate = supabaseUpdates.find(u => u.table === 'cs_ai_drafts' && u.row);
    assert.ok(draftUpdate);
    assert.equal(draftUpdate.row.auto_close_path, 'thank_you');
    assert.equal(draftUpdate.row.status, 'sent');
    assert.equal(draftUpdate.row.message_type, 'closing');
    assert.equal(draftUpdate.row.previous_draft_id, 200);

    // feedback log
    const fbInsert = supabaseInserts.find(i => i.table === 'cs_ai_feedback_log');
    assert.ok(fbInsert);
    assert.equal(fbInsert.row.action, 'auto_close_thank_you');
  });

  it('bails without any Gorgias write when another worker owns the claim', async () => {
    classifierResult = { auto_close: true, reason: 'pure_thanks' };
    // Unique-violation on the claim insert = a concurrent processTicket
    // (webhook vs reconcile vs resync) already owns this message.
    supabaseMock.handler.nextInsertResult = { data: null, error: { code: '23505', message: 'duplicate key' } };

    const result = await tryAutoCloseThankYou(makeOpts());

    assert.equal(result.handled, true);
    assert.equal(result.claimedElsewhere, true);
    assert.equal(gorgiasCalls.length, 0, 'no customer-facing write may happen without the claim');
    assert.equal(supabaseUpserts.length, 0);
  });
});

describe('formatMessagesForClassifier', () => {
  it('tags each message with sender role and trims to limit', () => {
    const msgs = [
      { from_agent: false, stripped_text: 'm1' },
      { from_agent: true, stripped_text: 'm2' },
      { from_agent: false, stripped_text: 'm3' },
    ];
    const out = formatMessagesForClassifier(msgs, 2);
    assert.ok(out.includes('[AGENT] m2'));
    assert.ok(out.includes('[CUSTOMER] m3'));
    assert.ok(!out.includes('m1'), 'should be trimmed by limit');
  });

  it('handles empty array', () => {
    assert.equal(formatMessagesForClassifier([], 6), '');
  });
});
