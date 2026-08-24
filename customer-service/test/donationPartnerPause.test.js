/**
 * Pausing a donation partner. The invariant under test: an org cannot leave
 * return routing without a recorded reason, through any path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computePause, formatPauseState } = require('../lib/donationPartnerPause');

const NOW = new Date('2026-08-20T20:46:00Z');

describe('computePause', () => {
  test('pause stops routing and stamps the reason', () => {
    assert.deepEqual(computePause('pause', { reason: 'Oversupplied', now: NOW }), {
      active: false,
      paused_at: '2026-08-20T20:46:00.000Z',
      paused_reason: 'Oversupplied',
    });
  });

  test('pause refuses without a reason', () => {
    for (const reason of [undefined, null, '', '   ']) {
      assert.throws(() => computePause('pause', { reason, now: NOW }), /requires a reason/,
        `reason ${JSON.stringify(reason)} should be rejected`);
    }
  });

  test('reason is trimmed, so whitespace cannot smuggle past the guard', () => {
    assert.equal(computePause('pause', { reason: '  Asked to stop  ', now: NOW }).paused_reason, 'Asked to stop');
  });

  test('resume clears the reason as well as the timestamp', () => {
    // A stale "they were oversupplied in 2026" on a partner actively receiving
    // boxes is worse than no note at all.
    assert.deepEqual(computePause('resume', { now: NOW }), {
      active: true, paused_at: null, paused_reason: null,
    });
  });

  test('resume needs no reason', () => {
    assert.doesNotThrow(() => computePause('resume', { now: NOW }));
  });

  test('an unknown action is refused rather than silently ignored', () => {
    assert.throws(() => computePause('snooze', { reason: 'x', now: NOW }), /unknown action/);
    assert.throws(() => computePause(undefined, { reason: 'x', now: NOW }), /unknown action/);
  });
});

describe('formatPauseState', () => {
  test('an active partner renders nothing, so the common case stays quiet', () => {
    assert.equal(formatPauseState({ active: true, paused_reason: null }), '');
    assert.equal(formatPauseState({ active: true, paused_reason: 'stale' }), '');
  });

  test('a paused partner shows the date and the reason', () => {
    assert.equal(
      formatPauseState({ active: false, paused_at: '2026-08-20T20:46:00.000Z', paused_reason: 'Oversupplied' }),
      'PAUSED (2026-08-20) — Oversupplied');
  });

  test('a legacy inactive row says so instead of implying a reason exists', () => {
    assert.equal(formatPauseState({ active: false }), 'PAUSED — no reason recorded');
  });

  test('tolerates a null partner', () => {
    assert.equal(formatPauseState(null), '');
  });
});

describe('the pause axis is not the outreach axis', () => {
  test('pause touches only donation columns, never outreach ones', () => {
    // Both orgs paused on 2026-08-20 asked to keep buying. A pause that also
    // wrote outreach fields would suppress a live sales conversation.
    const patch = computePause('pause', { reason: 'Asked to stop', now: NOW });
    for (const k of ['outreach_paused_at', 'outreach_paused_reason', 'snoozed_until', 'relationship_state']) {
      assert.equal(k in patch, false, `pause must not write ${k}`);
    }
  });
});
