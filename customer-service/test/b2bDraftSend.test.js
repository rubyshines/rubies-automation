// sendDraftById body-override + operator_edited tracking, and the pure
// fact-verification merge. sendB2bEmail is stubbed via require.cache so no
// Gmail/flag infrastructure is touched.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const sendPath = require.resolve('../../b2b-outreach/lib/sendB2bEmail.js');
let lastSendArgs = null;
require.cache[sendPath] = {
  id: sendPath, filename: sendPath, loaded: true, path: path.dirname(sendPath),
  exports: {
    sendB2bEmail: async (args) => { lastSendArgs = args; return { phase: 'sent', sent_at: '2026-07-24T12:00:00Z', to: args.company_id }; },
    SEND_FLAG: 'b2b_send_enabled',
  },
};
const { sendDraftById, mergeFactVerification } = require('../../b2b-outreach/lib/queueService');

const DRAFT = {
  id: 9, company_id: 'uniting-pride', thread_id: 17, message_type: 'intro_outreach',
  variant_id: null, subject: 'Hello', body: 'AI original body', status: 'pending', structured: {},
};

/** Minimal chainable fake for the two query shapes sendDraftById uses. */
function fakeSb(draft = DRAFT) {
  const updates = [];
  const sb = {
    updates,
    from(table) {
      return {
        select() { return { eq() { return { maybeSingle: async () => ({ data: { ...draft }, error: null }) }; } }; },
        update(fields) { updates.push({ table, fields }); return { eq: async () => ({ error: null }) }; },
      };
    },
  };
  return sb;
}

test('unedited send uses the stored body and marks operator_edited=false', async () => {
  const sb = fakeSb();
  const res = await sendDraftById(sb, { draft_id: 9, confirmed: true });
  assert.equal(res.phase, 'sent');
  assert.equal(lastSendArgs.body, 'AI original body');
  assert.equal(sb.updates[0].fields.operator_edited, false);
  assert.equal(sb.updates[0].fields.status, 'sent');
});

test('edited body is sent verbatim, original preserved, operator_edited=true', async () => {
  const sb = fakeSb();
  await sendDraftById(sb, { draft_id: 9, confirmed: true, body: 'Jamie rewrote this' });
  assert.equal(lastSendArgs.body, 'Jamie rewrote this');
  assert.equal(sb.updates[0].fields.operator_edited, true);
  assert.equal(sb.updates[0].fields.body, undefined); // AI original never overwritten
});

test('blank/whitespace override falls back to the stored body', async () => {
  const sb = fakeSb();
  await sendDraftById(sb, { draft_id: 9, confirmed: true, body: '   ' });
  assert.equal(lastSendArgs.body, 'AI original body');
  assert.equal(sb.updates[0].fields.operator_edited, false);
});

test('unedited send uses the stored subject', async () => {
  const sb = fakeSb();
  await sendDraftById(sb, { draft_id: 9, confirmed: true });
  assert.equal(lastSendArgs.subject, 'Hello');
  assert.equal(sb.updates[0].fields.operator_edited, false);
});

test('edited subject is sent verbatim and counts as an operator edit', async () => {
  const sb = fakeSb();
  await sendDraftById(sb, {
    draft_id: 9, confirmed: true,
    subject: 'RUBIES, gender-affirming underwear and swimwear for trans girls',
  });
  assert.equal(lastSendArgs.subject, 'RUBIES, gender-affirming underwear and swimwear for trans girls');
  assert.equal(lastSendArgs.body, 'AI original body'); // body untouched
  assert.equal(sb.updates[0].fields.operator_edited, true);
  assert.equal(sb.updates[0].fields.subject, undefined); // AI original never overwritten
});

test('edited subject is trimmed', async () => {
  const sb = fakeSb();
  await sendDraftById(sb, { draft_id: 9, confirmed: true, subject: '  Referral from Searah  ' });
  assert.equal(lastSendArgs.subject, 'Referral from Searah');
});

test('blank/whitespace subject override falls back to the stored subject', async () => {
  const sb = fakeSb();
  await sendDraftById(sb, { draft_id: 9, confirmed: true, subject: '   ' });
  assert.equal(lastSendArgs.subject, 'Hello');
  assert.equal(sb.updates[0].fields.operator_edited, false);
});

// A reply draft carries no subject of its own; the panel field is empty and
// must stay empty so sendB2bEmail inherits the thread subject downstream.
test('reply draft with no subject passes undefined so the thread subject is inherited', async () => {
  const sb = fakeSb({ ...DRAFT, subject: null });
  await sendDraftById(sb, { draft_id: 9, confirmed: true, subject: '' });
  assert.equal(lastSendArgs.subject, undefined);
  assert.equal(sb.updates[0].fields.operator_edited, false);
});

// ── mergeFactVerification ───────────────────────────────────────────────────

test('verifying facts accumulates sorted unique indices', () => {
  let s = mergeFactVerification({ facts_to_verify: ['a', 'b', 'c'] }, 2, true);
  s = mergeFactVerification(s, 0, true);
  s = mergeFactVerification(s, 2, true); // duplicate
  assert.deepEqual(s.facts_verified, [0, 2]);
  assert.deepEqual(s.facts_to_verify, ['a', 'b', 'c']); // rest of structured intact
});

test('unverifying removes an index', () => {
  const s = mergeFactVerification({ facts_verified: [0, 1] }, 0, false);
  assert.deepEqual(s.facts_verified, [1]);
});

test('handles null structured', () => {
  assert.deepEqual(mergeFactVerification(null, 1, true).facts_verified, [1]);
});
