/**
 * Operator agent ticket-level action context — unionTicketActions (cross-draft
 * aggregation) and buildSystemPrompt's completed-actions / warehouse-hold
 * signals. All pure: no network, no Supabase, no Anthropic.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { unionTicketActions } = require('../dashboard/server');
const { buildSystemPrompt } = require('../lib/operatorAgent');

function ctx(overrides = {}) {
  return {
    customer_email: 'customer@example.com',
    order_number: '12345',
    order_items: [],
    fulfillment_status: 'unfulfilled',
    intake: null,
    draft: { draft_response: 'Hi there', actions: [] },
    ...overrides,
  };
}

// --- unionTicketActions -------------------------------------------------------

test('unionTicketActions: merges actions across drafts in chronological order', () => {
  const drafts = [
    { actions: [{ action_type: 'refund', executed_at: '2026-06-09T10:00:00Z' }] },
    { actions: [{ action_type: 'exchange', executed_at: '2026-06-07T10:00:00Z' }] },
    { actions: [] },
  ];
  const union = unionTicketActions(drafts);
  assert.deepEqual(union.map(a => a.action_type), ['exchange', 'refund']);
});

test('unionTicketActions: tolerates missing/null actions arrays and empty input', () => {
  assert.deepEqual(unionTicketActions([{ actions: null }, {}, null]), []);
  assert.deepEqual(unionTicketActions([]), []);
  assert.deepEqual(unionTicketActions(null), []);
});

test('unionTicketActions: entries without executed_at sort first, not dropped', () => {
  const union = unionTicketActions([
    { actions: [{ action_type: 'exchange', executed_at: '2026-06-08T10:00:00Z' }] },
    { actions: [{ action_type: 'warehouse_hold' }] },
  ]);
  assert.deepEqual(union.map(a => a.action_type), ['warehouse_hold', 'exchange']);
});

// --- buildSystemPrompt: completed actions across turns -------------------------

test('prompt lists completed_actions from prior turns (not just current draft)', () => {
  const prompt = buildSystemPrompt(ctx({
    completed_actions: [
      { action_type: 'exchange', executed_at: '2026-06-07T15:30:00Z', summary: 'Exchanged AJ M → L\nDetails...' },
    ],
    draft: { draft_response: 'Hi', actions: [] }, // current turn has none
  }));
  assert.match(prompt, /Already Completed This Ticket/);
  assert.match(prompt, /exchange \(2026-06-07\): Exchanged AJ M → L/);
});

test('prompt falls back to draft.actions when completed_actions is absent', () => {
  const prompt = buildSystemPrompt(ctx({
    draft: { draft_response: 'Hi', actions: [{ action_type: 'refund', executed_at: '2026-06-09T01:00:00Z', summary: 'Refunded' }] },
  }));
  assert.match(prompt, /Already Completed This Ticket/);
  assert.match(prompt, /refund \(2026-06-09\): Refunded/);
});

test('prompt omits the completed block when nothing has executed', () => {
  const prompt = buildSystemPrompt(ctx({ completed_actions: [] }));
  assert.ok(!/Already Completed This Ticket/.test(prompt));
});

// --- buildSystemPrompt: warehouse hold signal ----------------------------------

test('hold placed in a PRIOR turn reads as ALREADY PLACED', () => {
  const prompt = buildSystemPrompt(ctx({
    completed_actions: [{ action_type: 'warehouse_hold', executed_at: '2026-06-07T10:00:00Z' }],
  }));
  assert.match(prompt, /Warehouse hold: ALREADY PLACED/);
});

test('hold followed by a later release reads as not placed', () => {
  const prompt = buildSystemPrompt(ctx({
    completed_actions: [
      { action_type: 'warehouse_hold', executed_at: '2026-06-07T10:00:00Z' },
      { action_type: 'release_warehouse_hold', executed_at: '2026-06-08T10:00:00Z' },
    ],
  }));
  assert.match(prompt, /Warehouse hold: not placed/);
});

test('advisor hold PROPOSAL (action_type on draft) does not count as placed', () => {
  const prompt = buildSystemPrompt(ctx({
    draft: { draft_response: 'Hi', action_type: 'warehouse_hold', actions: [] },
  }));
  assert.match(prompt, /Warehouse hold: not placed/);
});
