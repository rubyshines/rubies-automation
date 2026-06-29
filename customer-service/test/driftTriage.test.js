'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Stub the heavy intake module so driftTriage loads in isolation. driftTriage
// destructures { extractCleanBody, checkForDuplicateTicket } at load; provide
// light versions. The triage routing tests inject their own seams anyway.
const stub = (relPath, exports) => {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub('../intake/processGorgiasTickets', {
  extractCleanBody: (m) => ({ text: m.body_text || m.body || '' }),
  checkForDuplicateTicket: async () => null,
});
stub('../../shared/aiClient', { callClaude: async () => ({ content: [{ text: 'CUSTOMER | shopper' }] }) });

const { triageDriftTicket, isReactionMessage } = require('../lib/driftTriage');

// --- isReactionMessage ------------------------------------------------------

test('isReactionMessage: Gmail reaction marker', () => {
  assert.equal(isReactionMessage({ body_text: '💖 Ceri reacted via Gmail (https://mail.google.com/...)' }), true);
});

test('isReactionMessage: bare emoji', () => {
  assert.equal(isReactionMessage({ body_text: '💖' }), true);
  assert.equal(isReactionMessage({ body_text: '  👍 ' }), true);
});

test('isReactionMessage: emoji + real words is NOT a reaction', () => {
  assert.equal(isReactionMessage({ body_text: '👍 thanks for the help!' }), false);
});

test('isReactionMessage: plain short text is NOT a reaction', () => {
  assert.equal(isReactionMessage({ body_text: 'ok thanks' }), false);
  assert.equal(isReactionMessage({ body_text: 'Can we please return this?' }), false);
});

test('isReactionMessage: empty is NOT a reaction', () => {
  assert.equal(isReactionMessage({ body_text: '' }), false);
  assert.equal(isReactionMessage({}), false);
});

// --- triageDriftTicket routing ---------------------------------------------

function makeHarness() {
  const calls = [];
  const gorgias = {
    addInternalNote: async (id, note) => calls.push(['note', id, note]),
    closeTicket: async (id) => calls.push(['close', id]),
    addTicketTag: async (id, tag) => calls.push(['tag', id, tag]),
  };
  const supabase = { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) };
  return { calls, gorgias, supabase };
}

const customerMsg = (text) => [{ from_agent: false, channel: 'email', body_text: text }];

test('triage: duplicate → closed, disposition duplicate', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const res = await triageDriftTicket({
    supabase, gorgias,
    ticket: { id: 1, customer: { email: 'a@b.com' }, subject: 'Order #1' },
    messages: customerMsg('same issue again'),
    _checkDuplicate: async () => 'close_new',
  });
  assert.equal(res.disposition, 'duplicate');
  assert.ok(calls.some(c => c[0] === 'close' && c[1] === 1));
  assert.ok(!calls.some(c => c[0] === 'tag'));
});

test('triage: emoji reaction → closed, disposition reaction', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const res = await triageDriftTicket({
    supabase, gorgias,
    ticket: { id: 2, customer: { email: 'a@b.com' }, subject: 'Re: name update' },
    messages: customerMsg('💖 reacted via Gmail'),
    _checkDuplicate: async () => null,
  });
  assert.equal(res.disposition, 'reaction');
  assert.ok(calls.some(c => c[0] === 'close' && c[1] === 2));
});

test('triage: vendor spam → tagged + closed, disposition spam', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const res = await triageDriftTicket({
    supabase, gorgias,
    ticket: { id: 3, customer: { email: 'sales@redo.com' }, subject: 'Why brands switch to Redo' },
    messages: customerMsg('One reason brands move to Redo is consolidation...'),
    _checkDuplicate: async () => null,
    _classifyVendorSpam: async () => ({ isVendorSpam: true, reason: 'SaaS cold pitch' }),
  });
  assert.equal(res.disposition, 'spam');
  assert.ok(calls.some(c => c[0] === 'tag' && c[2] === 'spam'));
  assert.ok(calls.some(c => c[0] === 'close' && c[1] === 3));
});

test('triage: genuine inquiry → real_miss, NOT closed', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const res = await triageDriftTicket({
    supabase, gorgias,
    ticket: { id: 4, customer: { email: 'shopper@gmail.com' }, subject: 'Order #31419' },
    messages: customerMsg('We received our order but it did not conceal. Can we return?'),
    _checkDuplicate: async () => null,
    _classifyVendorSpam: async () => ({ isVendorSpam: false, reason: 'real shopper' }),
  });
  assert.equal(res.disposition, 'real_miss');
  assert.equal(calls.length, 0);
});

test('triage: dryRun classifies without any writes', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const res = await triageDriftTicket({
    supabase, gorgias, dryRun: true,
    ticket: { id: 5, customer: { email: 'a@b.com' }, subject: 'x' },
    messages: customerMsg('💖 reacted via Gmail'),
    _checkDuplicate: async () => null,
  });
  assert.equal(res.disposition, 'reaction');
  assert.equal(calls.length, 0);
});
