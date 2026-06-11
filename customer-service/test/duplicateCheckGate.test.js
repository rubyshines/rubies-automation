/**
 * Unit tests for the checkForDuplicateTicket first-contact gate.
 *
 * Regression pin for the 2026-06-10 incident: a customer replied to an
 * answered ticket, intake re-ran the duplicate check against a sibling
 * snoozed ticket, Opus said close_new, and the ticket was auto-closed with
 * the customer's reply unprocessed (surfaced as "missing messages" drift in
 * the daily sync). The duplicate check must only run when the ticket's
 * latest customer message is its FIRST customer message.
 *
 * Run: node --test customer-service/test/duplicateCheckGate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Env required by upstream requires; values don't matter for these tests.
process.env.SUPABASE_URL ||= 'http://test';
process.env.SUPABASE_SERVICE_KEY ||= 'test';
process.env.GORGIAS_DOMAIN ||= 'test';
process.env.GORGIAS_API_KEY ||= 'test';
process.env.GORGIAS_EMAIL ||= 'test@test.com';

// Stub the AI client before requiring the module under test so we can both
// assert the dup check never reaches Opus on established conversations and
// script its verdict for first-contact cases.
const aiClientPath = require.resolve('../../shared/aiClient');
const aiCalls = [];
let nextVerdict = { action: 'close_new', reason: 'same issue, existing has reply' };
require.cache[aiClientPath] = {
  id: aiClientPath,
  filename: aiClientPath,
  loaded: true,
  exports: {
    callClaude: async (params) => {
      aiCalls.push(params);
      return { content: [{ text: JSON.stringify(nextVerdict) }] };
    },
  },
};

const { checkForDuplicateTicket } = require('../intake/processGorgiasTickets');

// Minimal supabase stub: records whether the existing-tickets query ran and
// returns a scripted result set.
function makeSupabase(existingTickets) {
  const state = { queried: false };
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    neq: () => {
      state.queried = true;
      return Promise.resolve({ data: existingTickets });
    },
  };
  return { client: { from: () => builder }, state };
}

const EXISTING_SNOOZED_TICKET = {
  id: 1697,
  gorgias_ticket_id: 102793209,
  order_number: '#30831',
  status: 'snoozed',
  message_type: 'exchange',
  conversation_history: [
    { sender: 'customer', body: 'How do I exchange?' },
    { sender: 'agent', body: 'Let me know which item you would like to exchange.' },
  ],
  created_at: '2026-06-10T17:33:54Z',
};

const FIRST_CONTACT_MESSAGES = [
  { id: 1, from_agent: false, channel: 'chat', body_text: 'I want to return order #30831' },
];

const ESTABLISHED_CONVERSATION_MESSAGES = [
  { id: 1, from_agent: false, channel: 'chat', body_text: 'I want to return order #30831' },
  { id: 2, from_agent: true, channel: 'email', via: 'rule', body_text: 'Our team will get back to you soon' },
  { id: 3, from_agent: true, channel: 'email', via: 'api', body_text: 'What did not work out with the Ava?' },
  { id: 4, from_agent: false, channel: 'email', body_text: 'Yes, we would like to exchange for the next size up.' },
];

describe('checkForDuplicateTicket first-contact gate', () => {
  it('returns null without querying or calling AI when the ticket has multiple customer messages', async () => {
    const { client, state } = makeSupabase([EXISTING_SNOOZED_TICKET]);
    aiCalls.length = 0;

    const result = await checkForDuplicateTicket(
      client, 'abigail@example.com', 102792991, ESTABLISHED_CONVERSATION_MESSAGES,
    );

    assert.equal(result, null);
    assert.equal(state.queried, false, 'existing-tickets query must not run for established conversations');
    assert.equal(aiCalls.length, 0, 'duplicate check must never reach the AI for established conversations');
  });

  it('still runs the duplicate check on first contact when a sibling ticket exists', async () => {
    const { client } = makeSupabase([EXISTING_SNOOZED_TICKET]);
    aiCalls.length = 0;
    nextVerdict = { action: 'close_new', reason: 'same issue, existing has reply' };

    const result = await checkForDuplicateTicket(
      client, 'abigail@example.com', 102792991, FIRST_CONTACT_MESSAGES,
    );

    assert.equal(result, 'close_new');
    assert.equal(aiCalls.length, 1, 'first-contact duplicate check should consult the AI');
  });

  it('returns null on first contact when the customer has no other open tickets', async () => {
    const { client } = makeSupabase([]);
    aiCalls.length = 0;

    const result = await checkForDuplicateTicket(
      client, 'abigail@example.com', 102792991, FIRST_CONTACT_MESSAGES,
    );

    assert.equal(result, null);
    assert.equal(aiCalls.length, 0);
  });

  it('agent replies and internal notes do not count toward the customer message gate', async () => {
    const { client } = makeSupabase([EXISTING_SNOOZED_TICKET]);
    aiCalls.length = 0;
    nextVerdict = { action: 'keep_both', reason: 'different issues' };

    // One customer message buried under agent traffic is still first contact.
    const messages = [
      { id: 1, from_agent: false, channel: 'chat', body_text: 'Where is my order?' },
      { id: 2, from_agent: true, channel: 'email', via: 'rule', body_text: 'Auto-reply' },
      { id: 3, from_agent: true, channel: 'internal-note', via: 'api', body_text: 'note' },
    ];
    const result = await checkForDuplicateTicket(
      client, 'abigail@example.com', 102792991, messages,
    );

    assert.equal(result, 'keep_both');
    assert.equal(aiCalls.length, 1);
  });
});
