/**
 * Unit tests for import/normalizer.js sender classification.
 *
 * Regression guard for the bug where every customer message was classified as
 * 'agent' because it keyed off source.type (which is the channel, never
 * 'customer') instead of Gorgias's from_agent boolean.
 *
 * Run: node --test customer-service/test/normalizer.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGorgiasTicket } = require('../import/normalizer');

const ticket = { id: 42, channel: 'email', customer: { email: 'c@example.com' }, created_datetime: '2026-07-01T00:00:00Z' };

function msg(overrides) {
  return {
    id: 1,
    from_agent: false,
    source: { type: 'email', from: { name: 'Cust', address: 'c@example.com' } },
    body_html: '<p>hello</p>',
    created_datetime: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

describe('normalizeGorgiasTicket sender classification', () => {
  it('classifies a customer message (from_agent=false) as customer', () => {
    const out = normalizeGorgiasTicket(ticket, [msg({ from_agent: false })]);
    assert.equal(out.messages[0].sender_type, 'customer');
    assert.equal(out.messages[0].is_internal, false);
  });

  it('classifies an agent message (from_agent=true) as agent', () => {
    const out = normalizeGorgiasTicket(ticket, [msg({ id: 2, from_agent: true })]);
    assert.equal(out.messages[0].sender_type, 'agent');
  });

  it('classifies an internal note as system/internal', () => {
    const out = normalizeGorgiasTicket(ticket, [msg({ id: 3, from_agent: true, channel: 'internal-note' })]);
    assert.equal(out.messages[0].sender_type, 'system');
    assert.equal(out.messages[0].is_internal, true);
  });

  it('does NOT misclassify a customer message as agent (the regression)', () => {
    // source.type is 'email' (the channel), never 'customer' — the old code
    // fell through to 'agent' for every real customer message.
    const out = normalizeGorgiasTicket(ticket, [msg({ from_agent: false, source: { type: 'email' } })]);
    assert.equal(out.messages[0].sender_type, 'customer');
  });

  it('handles a mixed thread', () => {
    const out = normalizeGorgiasTicket(ticket, [
      msg({ id: 1, from_agent: false }),
      msg({ id: 2, from_agent: true }),
      msg({ id: 3, from_agent: true, channel: 'internal-note' }),
    ]);
    assert.deepEqual(out.messages.map(m => m.sender_type), ['customer', 'agent', 'system']);
  });
});

// --- classifyGorgiasSender (2026-07 message-hygiene fix) ---
const { classifyGorgiasSender } = require('../import/normalizer');

it('classifyGorgiasSender: customer and agent basics', () => {
  assert.strictEqual(classifyGorgiasSender({ from_agent: false }, 'Hi, my order has not arrived', false), 'customer');
  assert.strictEqual(classifyGorgiasSender({ from_agent: true }, 'Hi, No problem. I went ahead and created a new order for you.', false), 'agent');
});

it('classifyGorgiasSender: internal notes and flow containers are system', () => {
  assert.strictEqual(classifyGorgiasSender({ from_agent: true }, 'note text', true), 'system');
  assert.strictEqual(classifyGorgiasSender({ from_agent: true, meta: { origin: 'flow' } }, 'flow transcript with > customer text', false), 'system');
});

it('classifyGorgiasSender: auto-ack template at body start is system', () => {
  const ack = 'Hello, Thanks for reaching out, our team will get back to you soon regarding the following request: Subject: sizing question';
  assert.strictEqual(classifyGorgiasSender({ from_agent: true }, ack, false), 'system');
});

it('classifyGorgiasSender: real reply QUOTING the auto-ack stays agent', () => {
  const reply = 'Hi, It should arrive on your porch. Take care, Jamie On Tue, Mar 10 2026, at 11:53 PM, RUBIES Customer Care wrote: Hello, Thanks for reaching out, our team will get back to you soon regarding the following request';
  assert.strictEqual(classifyGorgiasSender({ from_agent: true }, reply, false), 'agent');
});

it('classifyGorgiasSender: AI-bot marker in head is system; quoted marker stays agent', () => {
  const bot = 'Hi, Just following up on your exchange. This message was created with AI by the RUBIES Customer Care Bot.';
  assert.strictEqual(classifyGorgiasSender({ from_agent: true }, bot, false), 'system');
  const humanQuotingBot = 'Hi, Jumping in personally here to sort this out. On Mon, Jul 6 2026, at 9:00 AM, RUBIES wrote: created with AI by the RUBIES Customer Care Bot';
  assert.strictEqual(classifyGorgiasSender({ from_agent: true }, humanQuotingBot, false), 'agent');
});
