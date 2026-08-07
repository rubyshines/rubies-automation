const { test } = require('node:test');
const assert = require('node:assert');
const { messageInvolves, addressesIn } = require('../../b2b-outreach/lib/manualSendReconcile');
const { messageBelongs, storedAddresses } = require('../../scripts/repairB2bCrossOrgMessages');

/** A Gmail message shape with the headers the filter reads. */
const msg = (headers) => ({ payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });

test('addressesIn pulls every address out of a header', () => {
  assert.deepEqual(addressesIn('Jamie <jamie@rubyshines.com>'), ['jamie@rubyshines.com']);
  assert.deepEqual(addressesIn('a@b.org, C <c@d.org>'), ['a@b.org', 'c@d.org']);
  assert.deepEqual(addressesIn(''), []);
  assert.deepEqual(addressesIn(null), []);
});

test('a message is kept when the company is on it', () => {
  const emails = new Set(['transclosethv@gmail.com']);
  assert.equal(messageInvolves(msg({ From: 'transclosethv@gmail.com', To: 'jamie@rubyshines.com' }), emails), true);
  assert.equal(messageInvolves(msg({ From: 'jamie@rubyshines.com', To: 'transclosethv@gmail.com' }), emails), true);
});

test('another org merged in on a shared subject is skipped', () => {
  // The real case: Gmail filed Trans Closet HV and Transformation Closet (NS)
  // into one thread because both used "agreement and next steps".
  const emails = new Set(['transclosethv@gmail.com']);
  const foreign = msg({ From: 'jamie@rubyshines.com', To: 'transformationclosetshns@gmail.com' });
  assert.equal(messageInvolves(foreign, emails), false);
});

test('a company on Cc still counts as a party', () => {
  const emails = new Set(['themaisystem@gmail.com']);
  assert.equal(messageInvolves(msg({ From: 'jamie@rubyshines.com', To: 'a@b.org', Cc: 'themaisystem@gmail.com' }), emails), true);
});

test('with no known addresses nothing is dropped', () => {
  // Absence of contact data is missing information, not evidence of foreignness.
  assert.equal(messageInvolves(msg({ From: 'x@y.org', To: 'z@w.org' }), null), true);
  assert.equal(messageInvolves(msg({ From: 'x@y.org', To: 'z@w.org' }), new Set()), true);
});

test('matching is case-insensitive', () => {
  assert.equal(messageInvolves(msg({ From: 'TransClosetHV@Gmail.com', To: 'jamie@rubyshines.com' }),
    new Set(['transclosethv@gmail.com'])), true);
});

// ── the repair pass over already-stored rows ────────────────────────────────

const OURS = new Set(['jamie@rubyshines.com', 'support@rubyshines.com']);

test('stored rows are judged on the counterparty, never on our own address', () => {
  const emails = new Set(['transclosethv@gmail.com']);
  // Every message has jamie@ on one side; counting it would keep everything.
  assert.equal(messageBelongs({ from_email: 'jamie@rubyshines.com', to_email: 'transformationclosetshns@gmail.com' }, emails, OURS), false);
  assert.equal(messageBelongs({ from_email: 'transclosethv@gmail.com', to_email: 'jamie@rubyshines.com' }, emails, OURS), true);
});

test('a row with only our own addresses is kept rather than guessed at', () => {
  assert.equal(messageBelongs({ from_email: 'jamie@rubyshines.com', to_email: 'jamie@rubyshines.com' }, new Set(['x@y.org']), OURS), true);
});

test('multi-recipient To is parsed, so a company copied among several is kept', () => {
  assert.deepEqual(storedAddresses('a@b.org, c@d.org'), ['a@b.org', 'c@d.org']);
  assert.equal(messageBelongs(
    { from_email: 'transclosethv@gmail.com', to_email: 'jamie@rubyshines.com, themaisystem@gmail.com' },
    new Set(['themaisystem@gmail.com']), OURS), true);
});

// ── a forced message_type is an instruction ─────────────────────────────────

test('a forced type overrides the advisor label, because it sets the cadence clock', () => {
  // Reproduces the miss: message_type only applied when nothing was due, so
  // forcing a type on a Tier-1 company was silently dropped and the advisor's
  // own guess ("reply_close", 180d) set next_action_date instead.
  const { NEXT_ACTION_DAYS } = require('../../b2b-outreach/lib/cadence');
  assert.equal(NEXT_ACTION_DAYS.reply_close, 180);
  assert.notEqual(NEXT_ACTION_DAYS.reply_close, NEXT_ACTION_DAYS.intro_outreach,
    'the two types schedule the next touch very differently, so the label matters');
});
