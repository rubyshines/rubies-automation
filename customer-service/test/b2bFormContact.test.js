const { test } = require('node:test');
const assert = require('node:assert');
const { deliveryMode } = require('../../b2b-outreach/lib/sendB2bEmail');
const { assembleQueue } = require('../../b2b-outreach/lib/queue');

// ── deliveryMode ────────────────────────────────────────────────────────────

test('an email on file always wins over a form', () => {
  assert.equal(deliveryMode({ hasContact: true, contactFormUrl: 'https://x.org/contact' }), 'email');
  assert.equal(deliveryMode({ generalEmail: 'hi@x.org', contactFormUrl: 'https://x.org/contact' }), 'email');
});

test('form only when there is no address at all', () => {
  assert.equal(deliveryMode({ contactFormUrl: 'https://genderswap.org/contact-us' }), 'form');
  assert.equal(deliveryMode({ hasContact: false, generalEmail: null, contactFormUrl: 'https://x.org/c' }), 'form');
});

test('no address and no form is unreachable, never a guess', () => {
  assert.equal(deliveryMode({}), 'none');
  assert.equal(deliveryMode({ hasContact: false, generalEmail: null, contactFormUrl: null }), 'none');
});

test('adding a contact later upgrades a form company with nothing to un-flag', () => {
  const before = { contactFormUrl: 'https://x.org/contact' };
  assert.equal(deliveryMode(before), 'form');
  assert.equal(deliveryMode({ ...before, hasContact: true }), 'email');
});

// ── queue ordering ──────────────────────────────────────────────────────────

const item = (id, tier, delivery, over = {}) => ({
  company: { id, name: id, relationship_type: 'lgbtq_org', relationship_state: 'prospect', vetted_at: '2026-06-01T00:00:00Z', program_flags: {}, ...over },
  ctx: { sentTypes: new Set(), lastTypeSentAt: () => null, delivery },
});
const NOW = new Date('2026-08-05T12:00:00Z');

test('delivery channel never changes tier — priority stays signal-based', () => {
  const q = assembleQueue([item('form-org', 4, 'form'), item('email-org', 4, 'email')], NOW);
  assert.deepEqual(q.map(e => e.tier), [4, 4], 'a form company is not demoted out of its tier');
});

test('within a tier, one-click sends come before form submissions', () => {
  const q = assembleQueue([item('form-org', 4, 'form'), item('email-org', 4, 'email')], NOW);
  assert.deepEqual(q.map(e => e.company_id), ['email-org', 'form-org']);
});

test('Tier 1 keeps oldest-waiting-first — a person waiting outranks tidiness', () => {
  const waiting = (id, since, delivery) => ({
    company: { id, name: id, relationship_type: 'lgbtq_org', relationship_state: 'in_contact', program_flags: {} },
    ctx: { sentTypes: new Set(), lastTypeSentAt: () => null, delivery, lastInboundAt: since, lastOutboundAt: null },
  });
  const q = assembleQueue([
    waiting('recent-email', '2026-08-04T00:00:00Z', 'email'),
    waiting('old-form', '2026-08-01T00:00:00Z', 'form'),
  ], NOW);
  assert.deepEqual(q.map(e => e.company_id), ['old-form', 'recent-email'],
    'the form company waited longer, so it still comes first');
});

test('entries carry delivery so the panel can pick its controls', () => {
  const [entry] = assembleQueue([item('form-org', 4, 'form')], NOW);
  assert.equal(entry.delivery, 'form');
});

test('delivery defaults to email when context omits it', () => {
  const [entry] = assembleQueue([{
    company: { id: 'x', name: 'x', relationship_type: 'lgbtq_org', relationship_state: 'prospect', vetted_at: '2026-06-01T00:00:00Z', program_flags: {} },
    ctx: { sentTypes: new Set(), lastTypeSentAt: () => null },
  }], NOW);
  assert.equal(entry.delivery, 'email');
});

// ── operator-composed drafts ────────────────────────────────────────────────

const { composeDraftRow } = require('../../b2b-outreach/lib/queueService');

test('a hand-written email is stored with advisor null — the signal it was not AI', () => {
  const row = composeDraftRow({ company_id: 'transactual', body: '  Hi AJ,\n\nThanks.  ', subject: ' Re: hello ' });
  assert.equal(row.advisor, null, 'distinguishes "Jamie wrote this" from "Jamie edited the AI"');
  assert.equal(row.body, 'Hi AJ,\n\nThanks.', 'trimmed');
  assert.equal(row.subject, 'Re: hello');
  assert.deepEqual(row.structured, {}, 'no AI metadata to claim');
});

test('composing refuses an empty body rather than storing a blank draft', () => {
  assert.throws(() => composeDraftRow({ company_id: 'x', body: '   ' }), /body required/);
  assert.throws(() => composeDraftRow({ body: 'hi' }), /company_id required/);
});

test('a blank subject stores null so the thread subject is inherited at send', () => {
  assert.equal(composeDraftRow({ company_id: 'x', body: 'hi', subject: '   ' }).subject, null);
});

test('a hand-written message adopts the due cadence type, so timing still books', () => {
  const entry = { tier: 4, message_type: 'intro_outreach', reason: 'vetted prospect', thread_id: 12 };
  const row = composeDraftRow({ company_id: 'x', body: 'hi', entry });
  assert.equal(row.message_type, 'intro_outreach');
  assert.equal(row.queue_tier, 4);
  assert.equal(row.thread_id, 12, 'replies land in the existing thread');
});

test('nothing due still composes, under a neutral type', () => {
  const row = composeDraftRow({ company_id: 'x', body: 'hi' });
  assert.equal(row.message_type, 'operator_message');
  assert.equal(row.queue_tier, null);
  assert.equal(row.queue_reason, 'written by the operator');
});

test('an explicit message_type overrides what is due', () => {
  const entry = { tier: 4, message_type: 'intro_outreach', reason: 'x' };
  assert.equal(composeDraftRow({ company_id: 'x', body: 'hi', message_type: 'reply_close', entry }).message_type, 'reply_close');
});
