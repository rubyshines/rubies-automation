/**
 * emailVerify tests — the verdict mapping and both failure disciplines:
 * verifyEmail fails SOFT (never breaks intake), readers fail OPEN (only a
 * positive 'undeliverable' row blocks; absence, errors, and a missing table
 * all mean "unverified — proceed").
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  verifyEmail, fetchVerifications, mapKickboxResult, isUndeliverable,
  filterUndeliverable, normalizeEmail,
} = require('../../b2b-outreach/lib/emailVerify');
const { assertRecipientDeliverable } = require('../../b2b-outreach/lib/sendB2bEmail');

/** Minimal chainable Supabase stub. Records upserts; .in()/.maybeSingle() resolve canned data. */
function sbStub({ single = null, inRows = [], inError = null, upsertError = null } = {}) {
  const calls = { upserts: [] };
  const builder = (table) => {
    const b = {
      select: () => b,
      eq: () => b,
      is: () => b,
      maybeSingle: async () => ({ data: single, error: null }),
      in: async () => ({ data: inRows, error: inError }),
      upsert: async (row) => { calls.upserts.push({ table, row }); return { error: upsertError }; },
    };
    return b;
  };
  return { from: builder, calls };
}

const throwingSb = { from: () => { throw new Error('sb should not be touched'); } };
const throwingFetch = async () => { throw new Error('fetch should not be called'); };

test('mapKickboxResult stores the vendor vocabulary verbatim', () => {
  assert.equal(mapKickboxResult({ result: 'deliverable', reason: 'accepted_email', sendex: 0.9 }).status, 'deliverable');
  assert.equal(mapKickboxResult({ result: 'undeliverable', reason: 'rejected_email' }).status, 'undeliverable');
  assert.equal(mapKickboxResult({ result: 'risky' }).status, 'risky');
});

test('an unexpected vendor result maps to unknown, not a throw', () => {
  assert.equal(mapKickboxResult({ result: 'brand_new_word' }).status, 'unknown');
  assert.equal(mapKickboxResult({}).status, 'unknown');
  assert.equal(mapKickboxResult(null).status, 'unknown');
});

test('did_you_mean folds into reason; non-numeric sendex becomes null', () => {
  const m = mapKickboxResult({ result: 'undeliverable', reason: 'rejected_email', did_you_mean: 'amy@bagly.org', sendex: 'high' });
  assert.match(m.reason, /rejected_email/);
  assert.match(m.reason, /amy@bagly\.org/);
  assert.equal(m.sendex, null);
});

test('only undeliverable blocks', () => {
  assert.equal(isUndeliverable({ status: 'undeliverable' }), true);
  for (const status of ['deliverable', 'risky', 'unknown']) {
    assert.equal(isUndeliverable({ status }), false, status);
  }
  assert.equal(isUndeliverable(null), false, 'no row = unverified = sendable');
});

test('filterUndeliverable drops bounced and verified-dead, keeps unverified', () => {
  const contacts = [
    { email: 'Dead@Org.org' },
    { email: 'bounced@org.org', bounced_at: '2026-08-19' },
    { email: 'fine@org.org' },
    { email: 'never-checked@org.org' },
  ];
  const byEmail = new Map([
    ['dead@org.org', { status: 'undeliverable' }],
    ['fine@org.org', { status: 'deliverable' }],
  ]);
  assert.deepEqual(filterUndeliverable(contacts, byEmail).map(c => c.email),
    ['fine@org.org', 'never-checked@org.org']);
  // No verification data at all → everything non-bounced survives (fail open).
  assert.equal(filterUndeliverable(contacts, undefined).length, 3);
});

test('verifyEmail without an API key skips without touching network or DB', async () => {
  const res = await verifyEmail(throwingSb, 'someone@org.org', { apiKey: null, fetchImpl: throwingFetch });
  assert.equal(res.status, null);
  assert.match(res.skipped, /KICKBOX_API_KEY/);
});

test('verifyEmail rejects a non-address without spending a probe', async () => {
  const res = await verifyEmail(throwingSb, 'not an email', { apiKey: 'k', fetchImpl: throwingFetch });
  assert.equal(res.status, null);
  assert.match(res.skipped, /not an email/);
});

test('verifyEmail returns the stored row when it is still fresh', async () => {
  const sb = sbStub({ single: { email: 'a@b.org', status: 'deliverable', verified_at: new Date(Date.now() - 86400000).toISOString() } });
  const res = await verifyEmail(sb, 'a@b.org', { apiKey: 'k', fetchImpl: throwingFetch });
  assert.equal(res.status, 'deliverable');
  assert.match(res.skipped, /fresh/);
  assert.equal(sb.calls.upserts.length, 0);
});

test('verifyEmail probes, maps, and records on the happy path', async () => {
  const sb = sbStub();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: true, result: 'undeliverable', reason: 'rejected_email', sendex: 0.1 }) });
  const res = await verifyEmail(sb, ' LFlynn@BAGLY.org ', { apiKey: 'k', fetchImpl, ifOlderThanDays: 0 });
  assert.equal(res.status, 'undeliverable');
  assert.equal(res.email, 'lflynn@bagly.org', 'normalized before storing');
  assert.equal(sb.calls.upserts.length, 1);
  assert.equal(sb.calls.upserts[0].row.status, 'undeliverable');
  assert.equal(sb.calls.upserts[0].row.source, 'intake');
});

test('verifyEmail fails soft on vendor errors — no row written, skip reason returned', async () => {
  const sb = sbStub();
  const res = await verifyEmail(sb, 'a@b.org', { apiKey: 'k', ifOlderThanDays: 0, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(res.status, null);
  assert.match(res.skipped, /ECONNRESET/);
  assert.equal(sb.calls.upserts.length, 0, 'a failed probe must not masquerade as a verdict');
});

test('verifyEmail treats kickbox success:false (bad key / no balance) as a skip, not unknown', async () => {
  const sb = sbStub();
  const res = await verifyEmail(sb, 'a@b.org', { apiKey: 'k', ifOlderThanDays: 0, fetchImpl: async () => ({ ok: true, json: async () => ({ success: false, message: 'Insufficient balance' }) }) });
  assert.equal(res.status, null);
  assert.match(res.skipped, /Insufficient balance/);
  assert.equal(sb.calls.upserts.length, 0);
});

test('verifyEmail survives the table not existing — verdict returned, write_error noted', async () => {
  const sb = sbStub({ upsertError: { message: 'relation "b2b_email_verifications" does not exist' } });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: true, result: 'deliverable' }) });
  const res = await verifyEmail(sb, 'a@b.org', { apiKey: 'k', fetchImpl, ifOlderThanDays: 0 });
  assert.equal(res.status, 'deliverable');
  assert.match(res.write_error, /does not exist/);
});

test('fetchVerifications fails open: lookup error yields an empty map, flagged', async () => {
  const sb = sbStub({ inError: { message: 'relation does not exist' } });
  const { byEmail, error } = await fetchVerifications(sb, ['a@b.org']);
  assert.equal(byEmail.size, 0);
  assert.match(error, /does not exist/);
});

test('fetchVerifications fails open even when the client THROWS (e.g. a stub without .in)', async () => {
  const sb = { from: () => ({ select: () => ({}) }) }; // no .in at all
  const { byEmail, error } = await fetchVerifications(sb, ['a@b.org']);
  assert.equal(byEmail.size, 0);
  assert.match(error, /in is not a function/);
});

test('assertRecipientDeliverable blocks only on a recorded undeliverable, naming it', async () => {
  const dead = { email: 'gone@org.org', status: 'undeliverable', reason: 'rejected_email', verified_at: '2026-08-28' };
  const block = await assertRecipientDeliverable(sbStub({ inRows: [dead] }), 'Gone@Org.org');
  assert.equal(block.ok, false);
  assert.equal(block.phase, 'undeliverable_address');
  assert.match(block.error, /gone@org\.org/);
  assert.match(block.error, /allow_undeliverable/);
});

test('assertRecipientDeliverable passes unverified addresses and failed lookups', async () => {
  assert.equal(await assertRecipientDeliverable(sbStub({ inRows: [] }), 'new@org.org'), null);
  assert.equal(await assertRecipientDeliverable(sbStub({ inError: { message: 'boom' } }), 'new@org.org'), null,
    'a verification-infrastructure failure must never block real mail');
  assert.equal(await assertRecipientDeliverable(sbStub(), ''), null);
});

test('assertRecipientDeliverable checks every address in a multi-recipient To', async () => {
  const dead = { email: 'b@org.org', status: 'undeliverable', reason: 'rejected_email', verified_at: '2026-08-28' };
  const block = await assertRecipientDeliverable(sbStub({ inRows: [dead] }), 'a@org.org, b@org.org');
  assert.match(block.error, /b@org\.org/);
});

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  A@B.Org '), 'a@b.org');
  assert.equal(normalizeEmail(null), '');
});
