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
// Dynamic stub: classifyVendorSpam tests set the response text and inspect the
// args the classifier sent (system prompt, metadata).
let claudeResponse = 'CUSTOMER | shopper';
let claudeError = null;
let lastClaudeArgs = null;
stub('../../shared/aiClient', {
  callClaude: async (args) => {
    lastClaudeArgs = args;
    if (claudeError) throw claudeError;
    return { content: [{ text: claudeResponse }] };
  },
});

const { triageDriftTicket, isReactionMessage, classifyVendorSpam } = require('../lib/driftTriage');

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

// --- classifyVendorSpam -----------------------------------------------------
//
// The regression these pin: the spam gate (2026-08-30) reused this classifier
// on the Gorgias-flagged population with the drift tie-break ("uncertain →
// CUSTOMER") and a two-category taxonomy, so phishing blasts and generic bot
// probes — neither shopper nor sales pitch — defaulted to CUSTOMER and were
// drafted into the operator queue. The flag must flip the tie-break, and JUNK
// must exist as a verdict.

test('classifyVendorSpam: JUNK verdict is parsed', async () => {
  claudeResponse = 'JUNK | phishing email impersonating SendGrid';
  claudeError = null;
  const res = await classifyVendorSpam({ subject: 'Verify your account', body: 'click here', ticketId: 1 });
  assert.equal(res.verdict, 'JUNK');
  assert.equal(res.isVendorSpam, false);
  assert.match(res.reason, /phishing/);
});

test('classifyVendorSpam: VENDOR and CUSTOMER verdicts still parse', async () => {
  claudeError = null;
  claudeResponse = 'VENDOR | SEO cold pitch';
  assert.equal((await classifyVendorSpam({ subject: 's', body: 'b' })).verdict, 'VENDOR');
  claudeResponse = 'CUSTOMER | sizing question';
  assert.equal((await classifyVendorSpam({ subject: 's', body: 'b' })).verdict, 'CUSTOMER');
});

test('classifyVendorSpam: spamFlagged flips the tie-break in the prompt', async () => {
  claudeError = null;
  claudeResponse = 'JUNK | generic probe';
  await classifyVendorSpam({ subject: 's', body: 'b', spamFlagged: true });
  assert.match(lastClaudeArgs.system, /already flagged this message/);
  assert.match(lastClaudeArgs.system, /answer JUNK/);
  assert.equal(lastClaudeArgs.metadata.spam_flagged, true);

  claudeResponse = 'CUSTOMER | shopper';
  await classifyVendorSpam({ subject: 's', body: 'b' });
  assert.match(lastClaudeArgs.system, /When uncertain, answer CUSTOMER/);
  assert.equal(lastClaudeArgs.metadata.spam_flagged, false);
});

test('classifyVendorSpam: error fails soft to CUSTOMER on drift, rethrows when spamFlagged', async () => {
  claudeError = new Error('api down');
  const res = await classifyVendorSpam({ subject: 's', body: 'b' });
  assert.equal(res.verdict, 'CUSTOMER');
  assert.match(res.reason, /classifier error/);

  // Flagged population: CUSTOMER-on-error would DRAFT the junk; the sweep's
  // per-ticket catch retries next run instead.
  await assert.rejects(() => classifyVendorSpam({ subject: 's', body: 'b', spamFlagged: true }), /api down/);
  claudeError = null;
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
    _checkDuplicate: async () => ({ action: 'close_new', survivor: { id: 10, gorgias_ticket_id: 999 } }),
  });
  assert.equal(res.disposition, 'duplicate');
  assert.ok(calls.some(c => c[0] === 'close' && c[1] === 1));
  assert.ok(!calls.some(c => c[0] === 'tag'));
});

test('triage: continuation → transplanted, NOT closed as duplicate', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const transplants = [];
  const res = await triageDriftTicket({
    supabase, gorgias,
    ticket: { id: 6, customer: { email: 'a@b.com', name: 'Nancy' }, subject: 'Re: Order #30748' },
    messages: customerMsg('Yes, the youth size 11 please!'),
    _checkDuplicate: async () => ({ action: 'continuation', survivor: { id: 10, gorgias_ticket_id: 999 } }),
    _transplant: async (args) => transplants.push(args),
  });
  assert.equal(res.disposition, 'continuation');
  assert.equal(transplants.length, 1);
  assert.equal(transplants[0].newTicketId, 6);
  assert.equal(transplants[0].survivor.gorgias_ticket_id, 999);
  assert.equal(transplants[0].customerMessages[0].text, 'Yes, the youth size 11 please!');
  // triage itself must not close the stray — the transplant owns the writes
  assert.ok(!calls.some(c => c[0] === 'close'));
});

test('triage: continuation dryRun classifies without transplanting', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const transplants = [];
  const res = await triageDriftTicket({
    supabase, gorgias, dryRun: true,
    ticket: { id: 7, customer: { email: 'a@b.com' }, subject: 'Re: Order #30748' },
    messages: customerMsg('Following up on my exchange'),
    _checkDuplicate: async () => ({ action: 'continuation', survivor: { id: 10, gorgias_ticket_id: 999 } }),
    _transplant: async (args) => transplants.push(args),
  });
  assert.equal(res.disposition, 'continuation');
  assert.equal(transplants.length, 0);
  assert.equal(calls.length, 0);
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

test('triage: JUNK verdict → tagged + closed with junk note, disposition spam', async () => {
  const { calls, gorgias, supabase } = makeHarness();
  const res = await triageDriftTicket({
    supabase, gorgias, spamFlagged: true,
    ticket: { id: 8, customer: { email: 'support@azimut-treks.example' }, subject: 'SendGrid: verify your sender' },
    messages: customerMsg('Your account will be suspended, click here'),
    _checkDuplicate: async () => null,
    _classifyVendorSpam: async () => ({ verdict: 'JUNK', isVendorSpam: false, reason: 'phishing impersonating SendGrid' }),
  });
  assert.equal(res.disposition, 'spam');
  assert.ok(calls.some(c => c[0] === 'tag' && c[2] === 'spam'));
  assert.ok(calls.some(c => c[0] === 'close' && c[1] === 8));
  const note = calls.find(c => c[0] === 'note');
  assert.match(note[2], /junk\/phishing/);
});

test('triage: spamFlagged is forwarded to the classifier', async () => {
  const { gorgias, supabase } = makeHarness();
  const seen = [];
  await triageDriftTicket({
    supabase, gorgias, spamFlagged: true,
    ticket: { id: 9, customer: { email: 'x@y.example' }, subject: 'hello' },
    messages: customerMsg('is your store open'),
    _checkDuplicate: async () => null,
    _classifyVendorSpam: async (args) => { seen.push(args); return { verdict: 'JUNK', reason: 'generic probe' }; },
  });
  assert.equal(seen[0].spamFlagged, true);
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

// --- mailbox probes (2026-09-03) ---------------------------------------------
//
// The regression these pin: after the JUNK verdict shipped (09-02), the flagged
// tie-break still listed "shipping" as shopper content that overrides the flag,
// so "Hi Rubyshines, do you ship internationally?" from lucyjames01v@gmail.com
// was drafted into the queue 3/3 on replay. Two things had to change: the prompt
// names the probe class and stops treating a bare footer question as shopper
// content, and the classifier is shown the sender header — the body alone
// cannot carry "a sales052 handle under the display name MR ABDUL".

test('classifyVendorSpam: sender identity reaches the model in the user turn', async () => {
  claudeResponse = 'JUNK | mailbox probe';
  await classifyVendorSpam({
    subject: 'Delivery location inquiry', body: 'Hi Rubyshines, do you ship internationally?',
    spamFlagged: true, senderEmail: 'lucyjames01v@gmail.com', senderName: 'Victor Ben',
  });
  const user = lastClaudeArgs.messages[0].content;
  assert.match(user, /From: Victor Ben <lucyjames01v@gmail\.com>/);
  assert.match(user, /Subject: Delivery location inquiry/);
  assert.match(user, /do you ship internationally/);
});

test('classifyVendorSpam: missing sender fields render as unknown, never "undefined"', async () => {
  claudeResponse = 'CUSTOMER | shopper';
  await classifyVendorSpam({ subject: 's', body: 'b' });
  const user = lastClaudeArgs.messages[0].content;
  assert.doesNotMatch(user, /undefined|null/);
  assert.match(user, /From: \(no display name\) <unknown address>/);
});

test('classifyVendorSpam: the prompt names mailbox probes and no longer treats a bare shipping question as shopper content', async () => {
  claudeResponse = 'JUNK | probe';
  await classifyVendorSpam({ subject: 's', body: 'b', spamFlagged: true });
  assert.match(lastClaudeArgs.system, /MAILBOX PROBE/);
  assert.match(lastClaudeArgs.system, /Hi Rubyshines/);
  assert.match(lastClaudeArgs.system, /bare "do you ship to X \/ internationally\?"[^.]*is a probe/);
});

test('triage: the Gorgias ticket customer is forwarded to the classifier as the sender', async () => {
  const { gorgias, supabase } = makeHarness();
  const seen = [];
  await triageDriftTicket({
    supabase, gorgias, spamFlagged: true,
    ticket: { id: 108041910, subject: 'Delivery location inquiry', customer: { email: 'lucyjames01v@gmail.com', name: 'Victor Ben' } },
    messages: [{ from_agent: false, channel: 'email', body_text: 'Hi Rubyshines, do you ship internationally?' }],
    _checkDuplicate: async () => null,
    _classifyVendorSpam: async (args) => { seen.push(args); return { verdict: 'JUNK', reason: 'mailbox probe' }; },
  });
  assert.equal(seen[0].senderEmail, 'lucyjames01v@gmail.com');
  assert.equal(seen[0].senderName, 'Victor Ben');
});
