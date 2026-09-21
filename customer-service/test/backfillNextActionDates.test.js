const { test } = require('node:test');
const assert = require('node:assert');
const { planCompany } = require('../../b2b-outreach/sync/backfillNextActionDates');
const { nextActionDateAfterSend } = require('../../b2b-outreach/lib/cadence');

// The 2026-09-21 repair: a send with no NEXT_ACTION_DAYS entry stamped the blind
// 30-day default over a date the conversation's own cadence had set. These
// assert the pass can only ever push a date outwards — it must never surface a
// company, and never touch one where the date was set on purpose.

const co = (over = {}) => ({ id: 'org', name: 'Org', relationship_type: 'lgbtq_org', ...over });
const sent = (message_type, day) => ({ message_type, sent_at: `${day}T18:51:00Z` });

test('restores the date a hand-written reply overwrote (the five partners)', () => {
  const p = planCompany(co({ next_action_date: '2026-09-19' }), [
    sent('community_checkin', '2026-08-19'),
    sent('operator_message', '2026-08-20'),
  ]);
  assert.equal(p.verdict, 'fix');
  assert.equal(p.from, '2026-09-19');
  assert.equal(p.to, nextActionDateAfterSend('community_checkin', new Date('2026-08-19T18:51:00Z')));
  assert.equal(p.to, '2027-08-19');
});

test('leaves a company whose last send sets its own cadence', () => {
  const p = planCompany(co({ next_action_date: '2026-09-19' }), [
    sent('operator_message', '2026-08-19'),
    sent('community_checkin', '2026-08-20'),
  ]);
  assert.equal(p.verdict, 'skip');
  assert.match(p.why, /sets its own cadence/);
});

test('leaves a date somebody set deliberately — only an exactly-30-day gap is provably blind', () => {
  for (const nad of ['2026-09-02', '2026-10-07', '2026-09-20']) {
    const p = planCompany(co({ next_action_date: nad }), [
      sent('community_checkin', '2026-08-19'),
      sent('operator_message', '2026-08-20'),
    ]);
    assert.equal(p.verdict, 'skip', `${nad} is not a blind stamp`);
    assert.match(p.why, /set deliberately/);
  }
});

test('leaves a company with nothing to restore from — no cadence date was ever lost', () => {
  const p = planCompany(co({ next_action_date: '2026-09-18' }), [
    sent('inbound_inquiry_response', '2026-08-10'),
    sent('operator_message', '2026-08-19'),
  ]);
  assert.equal(p.verdict, 'skip');
  assert.match(p.why, /no cadence-meaningful send/);
});

test('never pulls a date inwards: a restored date in the past is refused, so nothing is surfaced', () => {
  const p = planCompany(co({ next_action_date: '2026-09-19' }), [
    sent('intro_outreach', '2026-01-04'),   // +7d, long past
    sent('operator_message', '2026-08-20'),
  ]);
  assert.equal(p.verdict, 'skip');
  assert.match(p.why, /nothing was lost/);
});

test('a chain of hand-written replies restores from the last send that carried timing', () => {
  const p = planCompany(co({ next_action_date: '2026-10-16' }), [
    sent('community_checkin', '2026-09-08'),
    sent('operator_message', '2026-09-10'),
    sent('operator_message', '2026-09-16'),
  ]);
  assert.equal(p.verdict, 'fix');
  assert.equal(p.to, '2027-09-08');
});

test('empty and absent inputs are skipped, never thrown on', () => {
  assert.equal(planCompany(co({ next_action_date: null }), []).verdict, 'skip');
  assert.equal(planCompany(co({ next_action_date: '2026-09-19' }), []).verdict, 'skip');
});
