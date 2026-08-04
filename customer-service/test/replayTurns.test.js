const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTurns, buildConversationContext } = require('../../scripts/replayTurns');

const ticket = {
  conversation_history: [
    { id: 1, sender: 'customer', body: 'Too big', is_bot: false, created_at: '2026-08-01T10:00:00Z' },
    { id: 2, sender: 'agent', body: 'DRAFT text that was never sent', is_bot: false, created_at: '2026-08-01T11:00:00Z' },
    { id: 3, sender: 'customer', body: 'Her waist is 34", medium please', is_bot: false, created_at: '2026-08-02T09:00:00Z' },
  ],
};

const drafts = [
  {
    id: 10, created_at: '2026-08-01T10:30:00Z',
    draft_response: 'Draft one', sent_response: 'EDITED reply Jamie actually sent',
    intake_state: { message_type: 'exchange', items: [{ product: 'AJ' }] },
    operator_steer: null, draft_history: null,
  },
  {
    id: 11, created_at: '2026-08-02T09:30:00Z',
    draft_response: 'Post-steer draft', sent_response: 'Final sent',
    intake_state: { message_type: 'exchange' },
    operator_steer: 'just do it',
    draft_history: [{ draft_response: 'Unprompted draft that asked a needless question' }],
  },
];

describe('buildTurns', () => {
  it('anchors each turn on the customer message that triggered the draft', () => {
    const turns = buildTurns(ticket, drafts);
    assert.equal(turns.length, 2);
    assert.match(turns[0].issue_description, /\[LATEST CUSTOMER MESSAGE\]\nToo big/);
    assert.match(turns[1].issue_description, /\[LATEST CUSTOMER MESSAGE\]\nHer waist is 34", medium please/);
  });

  it('teacher-forces history to what Jamie SENT, not what was drafted', () => {
    // Feeding the model its own prior output compounds one early divergence
    // into every later turn, which measures drift rather than per-turn quality.
    const turns = buildTurns(ticket, drafts);
    assert.match(turns[1].issue_description, /Agent: EDITED reply Jamie actually sent/);
    assert.doesNotMatch(turns[1].issue_description, /DRAFT text that was never sent/);
  });

  it('feeds the PREVIOUS turn intake back, as apiRefreshDraft does', () => {
    const turns = buildTurns(ticket, drafts);
    assert.equal(turns[0].intake, null, 'first pass carries no intake');
    assert.equal(turns[0].is_regen, false);
    assert.deepEqual(turns[1].intake, drafts[0].intake_state);
    assert.equal(turns[1].is_regen, true, 'a regen is the shape production usually sends');
  });

  it('baselines against the unprompted draft, not the steered one', () => {
    // On a steered turn draft_response is the model following Jamie's
    // instruction. Scoring that would hide the defect the steer corrected.
    const turns = buildTurns(ticket, drafts);
    assert.equal(turns[1].reference.advisor_first_draft, 'Unprompted draft that asked a needless question');
    assert.equal(turns[1].reference.advisor_after_steer, 'Post-steer draft');
    assert.equal(turns[1].reference.needed_a_steer, true);
  });

  it('falls back to draft_response when there is no regen history', () => {
    const turns = buildTurns(ticket, drafts);
    assert.equal(turns[0].reference.advisor_first_draft, 'Draft one');
    assert.equal(turns[0].reference.advisor_after_steer, null);
  });

  it('skips a draft with no preceding customer message', () => {
    const orphan = [{ id: 99, created_at: '2026-07-01T00:00:00Z', draft_response: 'x', sent_response: 'x' }];
    assert.equal(buildTurns(ticket, orphan).length, 0);
  });
});

describe('buildConversationContext', () => {
  it('drops bot messages and excludes the latest message itself', () => {
    const msgs = [
      { id: 1, sender: 'customer', body: 'first', is_bot: false },
      { id: 2, sender: 'agent', body: 'What would you like to do?', is_bot: true },
      { id: 3, sender: 'customer', body: 'latest', is_bot: false },
    ];
    const ctx = buildConversationContext(msgs, 3);
    assert.equal(ctx, 'Customer: first');
  });

  it('returns null when nothing precedes the latest message', () => {
    assert.equal(buildConversationContext([{ id: 1, sender: 'customer', body: 'hi' }], 1), null);
  });
});
