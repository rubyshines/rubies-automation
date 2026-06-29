/**
 * Unit tests for lib/freeSwimwearRepeats.js — the pure repeat/duplicate decision
 * and the AI recipient-match (callClaude stubbed).
 *
 * Run: node --test customer-service/test/freeSwimwearRepeats.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// --- Stub the AI client BEFORE requiring the module under test ---
const aiPath = require.resolve('../../shared/aiClient');
let aiResponse = { content: [{ text: '{"same_recipient":[],"reasoning":"x"}' }] };
let aiShouldThrow = false;
const aiCalls = [];
require.cache[aiPath] = {
  id: aiPath, filename: aiPath, loaded: true,
  exports: {
    callClaude: async (params) => {
      aiCalls.push(params);
      if (aiShouldThrow) throw new Error('AI down');
      return aiResponse;
    },
  },
};

const { decideRepeat, classifySameRecipient, isCountablePrior } = require('../lib/freeSwimwearRepeats');

const DAY = 24 * 60 * 60 * 1000;
const newAt = '2026-06-28T12:00:00.000Z';
const now = new Date(newAt);
const newRow = { submitted_at: newAt, applicant_name: 'Ruby', recipient_age: '9' };
function prior(overrides) {
  return { id: 1, submitted_at: '2026-01-01T12:00:00.000Z', status: 'expired', discount_code: null, ...overrides };
}

describe('decideRepeat — no same-recipient prior', () => {
  it('clean new applicant (no priors at all)', () => {
    const d = decideRepeat({ newRow, samePriorRows: [], hadAnyPrior: false, now });
    assert.equal(d.disposition, 'new');
    assert.deepEqual(d.patch, {});
    assert.equal(d.supersede, null);
  });

  it('flags a possible second child when the email had other applications', () => {
    const d = decideRepeat({ newRow, samePriorRows: [], hadAnyPrior: true, now });
    assert.equal(d.disposition, 'new');
    assert.equal(d.patch.possible_second_child, true);
  });
});

describe('decideRepeat — same-day collapse', () => {
  it('supersedes an open, unissued same-day prior and keeps the new row active', () => {
    const p = prior({ id: 7, submitted_at: '2026-06-28T10:00:00.000Z', status: 'new', discount_code: null });
    const d = decideRepeat({ newRow, samePriorRows: [p], hadAnyPrior: true, now });
    assert.equal(d.disposition, 'new');
    assert.equal(d.supersede, p);
  });

  it('closes THIS row as duplicate when the same-day prior already has a code', () => {
    const p = prior({ id: 7, submitted_at: '2026-06-28T10:00:00.000Z', status: 'accepted', discount_code: 'RUBY-XYZ' });
    const d = decideRepeat({ newRow, samePriorRows: [p], hadAnyPrior: true, now });
    assert.equal(d.disposition, 'duplicate');
    assert.equal(d.supersede, null);
  });
});

describe('decideRepeat — too-soon repeat (within a year)', () => {
  it('closes as repeat and sets reapply_after = last application + 1 year', () => {
    const lastAt = '2026-03-01T12:00:00.000Z'; // ~119 days before
    const p = prior({ submitted_at: lastAt, status: 'expired' });
    const d = decideRepeat({ newRow, samePriorRows: [p], hadAnyPrior: true, now });
    assert.equal(d.disposition, 'repeat');
    assert.equal(d.patch.reapply_after, new Date(new Date(lastAt).getTime() + 365 * DAY).toISOString());
    assert.equal(d.reapplyAfter, d.patch.reapply_after);
    assert.equal(d.patch.prior_application_at, lastAt);
  });

  it('uses the MOST RECENT same-recipient prior for the window', () => {
    const older = prior({ id: 1, submitted_at: '2025-12-01T12:00:00.000Z' });
    const lastAt = '2026-05-01T12:00:00.000Z';
    const recent = prior({ id: 2, submitted_at: lastAt });
    const d = decideRepeat({ newRow, samePriorRows: [older, recent], hadAnyPrior: true, now });
    assert.equal(d.disposition, 'repeat');
    assert.equal(d.patch.prior_application_at, lastAt);
  });
});

describe('decideRepeat — returning after more than a year', () => {
  it('allows a new active application, badged with the prior date/outcome', () => {
    const lastAt = '2025-05-01T12:00:00.000Z'; // > 365 days before
    const p = prior({ submitted_at: lastAt, status: 'ordered' });
    const d = decideRepeat({ newRow, samePriorRows: [p], hadAnyPrior: true, now });
    assert.equal(d.disposition, 'new');
    assert.equal(d.patch.prior_application_at, lastAt);
    assert.equal(d.patch.prior_status, 'ordered'); // already received
    assert.equal(d.reapplyAfter, null);
  });

  it("reports prior_status 'ordered' if ANY same-recipient prior reached ordered", () => {
    const lastAt = '2025-05-01T12:00:00.000Z';
    const a = prior({ id: 1, submitted_at: '2024-05-01T12:00:00.000Z', status: 'ordered' });
    const b = prior({ id: 2, submitted_at: lastAt, status: 'expired' });
    const d = decideRepeat({ newRow, samePriorRows: [a, b], hadAnyPrior: true, now });
    assert.equal(d.patch.prior_status, 'ordered');
  });
});

describe('classifySameRecipient', () => {
  it('returns the priors the AI judged same-recipient', async () => {
    aiShouldThrow = false;
    aiResponse = { content: [{ text: 'sure: {"same_recipient":[2],"reasoning":"same child, age drifted"}' }] };
    const p1 = prior({ id: 1, applicant_name: 'Zoe' });
    const p2 = prior({ id: 2, applicant_name: 'Ruby' });
    const { same } = await classifySameRecipient(newRow, [p1, p2]);
    assert.deepEqual(same, [p2]);
  });

  it('fails conservative (treats all as different) when the AI errors', async () => {
    aiShouldThrow = true;
    const { same } = await classifySameRecipient(newRow, [prior({ id: 1 })]);
    assert.deepEqual(same, []);
  });

  it('fails conservative on unparseable output', async () => {
    aiShouldThrow = false;
    aiResponse = { content: [{ text: 'no json here' }] };
    const { same } = await classifySameRecipient(newRow, [prior({ id: 1 })]);
    assert.deepEqual(same, []);
  });

  it('skips the AI call entirely when there are no priors', async () => {
    aiCalls.length = 0;
    const { same } = await classifySameRecipient(newRow, []);
    assert.deepEqual(same, []);
    assert.equal(aiCalls.length, 0);
  });
});

describe('isCountablePrior', () => {
  it('counts real applications, excludes silent rejects and duplicates', () => {
    assert.equal(isCountablePrior({ status: 'ordered' }), true);
    assert.equal(isCountablePrior({ status: 'repeat' }), true);
    assert.equal(isCountablePrior({ status: 'rejected' }), false);
    assert.equal(isCountablePrior({ status: 'brazil-rejected' }), false);
    assert.equal(isCountablePrior({ status: 'duplicate' }), false);
  });
});
