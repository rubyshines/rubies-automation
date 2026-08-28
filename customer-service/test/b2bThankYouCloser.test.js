/**
 * Tests for the B2B thank-you closer — the deterministic gate and formatting.
 * The classifier prompt itself is Sonnet's job and is not exercised here; the
 * gate is what guarantees no model call is ever spent on a message that could
 * not close, and that a failure of any kind leaves the thread open.
 *
 * Run: node --test customer-service/test/b2bThankYouCloser.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { thankYouGate, formatThreadForCloser } = require('../../b2b-outreach/lib/thankYouCloser');

const OUT = (body = 'Hi! Here is everything you asked about.') =>
  ({ direction: 'outbound', body_text: body, sent_at: '2026-08-01T10:00:00Z' });
const IN = (body = 'Thanks so much!') =>
  ({ direction: 'inbound', body_text: body, sent_at: '2026-08-02T10:00:00Z' });

test('a human reply after our outbound in an open thread is a candidate', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [OUT(), IN()] });
  assert.equal(g.eligible, true);
});

// The classifier costs money; every gate below is a message shape that must
// never reach it.

test('machine mail never reaches the classifier', () => {
  for (const t of ['auto_reply', 'calendar_notice', 'bounce']) {
    const g = thankYouGate({ inboundType: t, threadWasNew: false, threadStatus: 'open', messages: [OUT(), IN()] });
    assert.equal(g.eligible, false, t);
    assert.equal(g.reason, 'machine_generated');
  }
});

test('a brand-new thread cannot be a thank-you — there is nothing of ours to thank', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: true, threadStatus: 'open', messages: [IN()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'thread_born_of_this_message');
});

test('an already-closed thread is left alone', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'closed', messages: [OUT(), IN()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'thread_not_open');
});

test('no prior outbound → an unanswered inquiry must not be swallowed', () => {
  // e.g. an org writes in twice before we ever reply; the second message says
  // "thanks for considering!" — closing here would silence a real inquiry.
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [IN('Hello! Would you include us?'), IN('Thanks for considering!')] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'no_prior_outbound');
});

test('a bounced outbound does not count as a prior message of ours', () => {
  // The whole point of the bounce path is that they never received it.
  const bounced = { ...OUT(), undelivered_at: '2026-08-01T10:05:00Z' };
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [bounced, IN()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'no_prior_outbound');
});

test('latest message must be the inbound in question', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [IN(), OUT()] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'latest_not_inbound');
});

test('an empty body is not a thank-you', () => {
  const g = thankYouGate({ inboundType: null, threadWasNew: false, threadStatus: 'open', messages: [OUT(), IN('   ')] });
  assert.equal(g.eligible, false);
  assert.equal(g.reason, 'empty_body');
});

test('formatThreadForCloser tags directions and trims to the last 6', () => {
  const messages = [
    OUT('one'), IN('two'), OUT('three'), IN('four'), OUT('five'), IN('six'), OUT('seven'), IN('eight'),
  ];
  const text = formatThreadForCloser(messages);
  assert.ok(!text.includes('one'), 'older than 6 dropped');
  assert.ok(!text.includes('two'), 'older than 6 dropped');
  assert.ok(text.includes('[US] three'));
  assert.ok(text.includes('[THEM] eight'));
});

test('formatThreadForCloser drops empty bodies rather than emitting bare tags', () => {
  const text = formatThreadForCloser([OUT(''), IN('thanks!')]);
  assert.equal(text, '[THEM] thanks!');
});
