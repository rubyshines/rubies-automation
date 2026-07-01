/**
 * Operator agent ticket-level action context — unionTicketActions (cross-draft
 * aggregation) and buildSystemPrompt's completed-actions / warehouse-hold
 * signals. All pure: no network, no Supabase, no Anthropic.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { unionTicketActions, executedActionTypes, resolveChatPendingPreview, actionTypeFromTool } = require('../dashboard/server');
const { buildSystemPrompt } = require('../lib/operatorAgent');

// --- actionTypeFromTool: create_invoice_order is dual-purpose --------------------
test('create_invoice_order on an exchange draft labels as exchange, not invoice_kept_items', () => {
  assert.equal(actionTypeFromTool('create_invoice_order', 'exchange'), 'exchange');
  assert.equal(actionTypeFromTool('create_invoice_order', 'exchange+refund'), 'exchange+refund');
});
test('create_invoice_order with no exchange context stays invoice_kept_items', () => {
  assert.equal(actionTypeFromTool('create_invoice_order', 'invoice_kept_items'), 'invoice_kept_items');
  assert.equal(actionTypeFromTool('create_invoice_order', undefined), 'invoice_kept_items');
});

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

// --- executedActionTypes (send-gate: has this draft's proposal happened?) ------

test('executedActionTypes: combined exchange+refund filed as a single "exchange" entry counts as both when the draft is executed', () => {
  // Real shape from ticket #106100788: the operator agent did both actions but
  // filed one actions[] entry labelled "exchange"; action_executed_at is stamped.
  const drafts = [{
    action_type: 'exchange+refund',
    action_executed_at: '2026-06-30T23:57:32.237Z',
    actions: [{ action_type: 'exchange', executed_at: '2026-06-30T23:57:32.237Z' }],
  }];
  const executed = executedActionTypes(drafts);
  assert.ok(executed.has('exchange') && executed.has('refund'),
    'both halves of the executed proposal must count, so the send gate does not force a spurious confirm');
});

test('executedActionTypes: an unexecuted proposal (no action_executed_at, no filed action) stays missing', () => {
  const executed = executedActionTypes([{ action_type: 'refund', action_executed_at: null, actions: [] }]);
  assert.equal(executed.has('refund'), false, 'a proposal that never executed must still be gated');
});

test('executedActionTypes: filed actions across sibling drafts are unioned', () => {
  const executed = executedActionTypes([
    { action_type: null, actions: [{ action_type: 'exchange', executed_at: '2026-06-07T10:00:00Z' }] },
    { action_type: null, actions: [{ action_type: 'warehouse_hold', executed_at: '2026-06-08T10:00:00Z' }] },
  ]);
  assert.ok(executed.has('exchange') && executed.has('warehouse_hold'));
});

test('executedActionTypes: tolerates empty/null input', () => {
  assert.equal(executedActionTypes([]).size, 0);
  assert.equal(executedActionTypes(null).size, 0);
});

// --- resolveChatPendingPreview (Yes/No confirm-button state) -------------------

const previewResult = { tool: 'create_exchange_order', result: 'Draft created — Awaiting Confirmation' };
const noteResult = { tool: 'add_order_note', result: 'Note added to order #12345.' };
const lookupResult = { tool: 'lookup_customer', result: 'Found customer.' };

test('pending: a write-tool preview this turn sets pending', () => {
  assert.equal(resolveChatPendingPreview({
    toolResults: [previewResult], completing: false, userMessage: 'exchange the AJ', prevPending: false,
  }), true);
});

test('pending: completion + simultaneous new preview stays pending (mid-flow note)', () => {
  assert.equal(resolveChatPendingPreview({
    toolResults: [noteResult, previewResult], completing: true, userMessage: 'note it and exchange', prevPending: false,
  }), true);
});

test('pending: a completing write with no new preview settles it', () => {
  assert.equal(resolveChatPendingPreview({
    toolResults: [{ tool: 'create_exchange_order', result: 'Exchange order #54321 created.' }],
    completing: true, userMessage: 'yes confirm', prevPending: true,
  }), false);
});

test('pending: prose-only Q&A turn carries the previous pending state', () => {
  assert.equal(resolveChatPendingPreview({
    toolResults: [], completing: false, userMessage: 'does that keep her address?', prevPending: true,
  }), true);
  assert.equal(resolveChatPendingPreview({
    toolResults: [lookupResult], completing: false, userMessage: 'what is her LTV?', prevPending: false,
  }), false);
});

test('pending: the quick-reply cancel click settles it', () => {
  assert.equal(resolveChatPendingPreview({
    toolResults: [], completing: false, userMessage: 'no, cancel', prevPending: true,
  }), false);
  assert.equal(resolveChatPendingPreview({
    toolResults: [], completing: false, userMessage: 'No cancel', prevPending: true,
  }), false);
});

test('pending: awaiting-confirmation phrase on a read-only tool does not count', () => {
  assert.equal(resolveChatPendingPreview({
    toolResults: [{ tool: 'lookup_customer', result: 'order is awaiting confirmation from carrier' }],
    completing: false, userMessage: 'check the order', prevPending: false,
  }), false);
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

// --- buildSystemPrompt: divergence is graded against the supplied draft --------
// The agent's "⚠️ Note" + AUTO_CONFIRM HOLD compare the action to the draft body
// it's handed via context.draft.draft_response. apiActionChat substitutes the
// operator's in-flight edited box (body.current_draft) for the stored draft so the
// flag reflects what the operator actually has, not a stale original. These guard
// that contract: whatever draft_response is passed is what the prompt grades on.

test('prompt embeds the supplied draft_response as the reference reply', () => {
  const prompt = buildSystemPrompt(ctx({
    draft: { draft_response: 'I have sent an invoice for the difference.', actions: [] },
  }));
  assert.match(prompt, /AI Draft Reply \(reference/);
  assert.match(prompt, /I have sent an invoice for the difference\./);
});

test('edited draft is graded, stale original phrasing is absent', () => {
  // Simulates apiActionChat overriding draft_response with the operator's edit:
  // only the edited text reaches the prompt, so the stale "free exchange" copy
  // the agent would otherwise flag against is gone.
  const edited = 'I have sent an invoice for the $30 difference.';
  const prompt = buildSystemPrompt(ctx({ draft: { draft_response: edited, actions: [] } }));
  assert.match(prompt, /invoice for the \$30 difference/);
  assert.ok(!/nothing more owed/i.test(prompt), 'stale original copy must not appear');
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

// --- buildSystemPrompt: differing-items exchange routing -----------------------
// Regression guard for ticket #29649 (Eitan). The decision matrix Jamie set:
//   straight swap → free; different items → exchange_difference first;
//   invoice ONLY if explicitly asked; refund ALWAYS when net<0 (no asking).

test('prompt routes differing-items exchanges through exchange_difference first', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /exchange_difference/);
  assert.match(prompt, /recommended_action/);
});

test('prompt: invoice only when the operator explicitly asked to charge the difference', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /invoice_requested: true.+ONLY if the operator explicitly/);
});

test('prompt: refund is automatic when the customer is owed money (no asking)', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /ALWAYS happens when the customer is owed money/);
});

test('prompt: upcharge with no invoice instruction defaults to free exchange', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /upcharge but the operator did NOT ask to invoice it \(we absorb it\)/);
});

test('prompt: straight swap is never invoiced, never calls exchange_difference', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /Straight swap.+Do NOT call exchange_difference/s);
  assert.match(prompt, /never invoiced even if the new size has a different list price/);
});

test('prompt forbids splitting or self-estimating the difference', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /never split into a separate exchange order plus a separate invoice order/);
  assert.match(prompt, /Never estimate prices or the difference yourself/);
});
