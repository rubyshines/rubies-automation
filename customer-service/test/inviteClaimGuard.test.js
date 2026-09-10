/**
 * A message claiming a booked call must be backed by a booked call.
 *
 * The failure this pins (2026-08-20): clicking a slot writes "Ok, I just sent an
 * invite for…" into the draft, but only Book & Send creates the event. Plain
 * Send sat right beside it, so a partner was told about an invite that did not
 * exist and nothing anywhere noticed.
 */
const test = require('node:test');
const assert = require('node:assert');
const { assertInviteClaimIsBacked, INVITE_CLAIM } = require('../../b2b-outreach/lib/sendB2bEmail');

/** Minimal Supabase stub: one chainable builder resolving to `rows`. */
function stubSb(rows, error = null) {
  const chain = {
    select: () => chain, eq: () => chain, gte: () => chain,
    limit: () => Promise.resolve({ data: rows, error }),
  };
  return { from: () => chain };
}

const CLAIM = 'Hi Laura,\n\nOk, I just sent an invite for Wed Aug 26 at 10:00 AM ET.\n\nJamie';

test('a body with no invite claim is never blocked', async () => {
  const res = await assertInviteClaimIsBacked(stubSb([]), {
    company_id: 'x', body: 'Hi there, sending the agreement over now.',
  });
  assert.strictEqual(res, null);
});

test('an invite claim with no booked meeting is BLOCKED', async () => {
  const res = await assertInviteClaimIsBacked(stubSb([]), { company_id: 'lumenus-foundation', body: CLAIM });
  assert.ok(res);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.phase, 'unbacked_invite_claim');
  assert.match(res.error, /no meeting is booked/);
  assert.match(res.error, /Book & Send/);
});

test('an invite claim WITH a booked meeting passes', async () => {
  const res = await assertInviteClaimIsBacked(
    stubSb([{ id: 1, starts_at: '2026-08-26T14:00:00Z' }]),
    { company_id: 'lumenus-foundation', body: CLAIM },
  );
  assert.strictEqual(res, null);
});

test('a failed lookup never blocks a send', async () => {
  // Failing closed here would stop legitimate mail over an unrelated DB blip.
  const res = await assertInviteClaimIsBacked(stubSb(null, { message: 'boom' }), {
    company_id: 'x', body: CLAIM,
  });
  assert.strictEqual(res, null);
});

test('the claim pattern matches the sentence the panel writes, and little else', async () => {
  const { renderConfirmationLine } = require('../../b2b-outreach/lib/scheduleMeeting');
  const line = renderConfirmationLine({ start: new Date('2026-08-26T14:00:00Z') });
  assert.ok(INVITE_CLAIM.test(line), 'must match the real generated sentence');
  assert.ok(INVITE_CLAIM.test(line.toLowerCase()));
  // Ordinary scheduling talk must not trip it.
  for (const benign of [
    'Shall I send you an invite once we agree a time?',
    'I will send an invite after you confirm.',
    'I just sent the agreement over for you to sign.',
    'Thanks for the invite to your event!',
  ]) assert.ok(!INVITE_CLAIM.test(benign), `should not match: ${benign}`);
});

test('a moved-call claim is guarded exactly like an invite claim', () => {
  const { INVITE_CLAIM } = require('../../b2b-outreach/lib/sendB2bEmail');
  assert.ok(INVITE_CLAIM.test('Ok, I moved our call to Thu Sept 17 at 1:00 PM ET (10:00 AM your time).'));
  assert.ok(INVITE_CLAIM.test('Ok, I just sent an invite for Thu Sept 17 at 1:00 PM ET.'));
  assert.ok(!INVITE_CLAIM.test('Happy to move things around if that helps.'));
});
