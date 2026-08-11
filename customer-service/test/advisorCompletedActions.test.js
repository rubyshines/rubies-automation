/**
 * The advisor's view of work the OPERATOR already executed on the ticket.
 *
 * Completed actions are filed in cs_ai_drafts.actions[] on whichever draft row
 * was active at the time. Until 2026-08-11 the advisor's intake context read
 * only `action_type` (its own proposal — null when the operator acted alone)
 * and `action_result` (cleared on completion), so an executed invoice was
 * invisible to the next turn and got staged a second time.
 *
 * All pure: the Supabase client is a stub, no network.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { unionTicketActions, formatCompletedActions } = require('../lib/draftActions');
const { buildPreviousDraftContext } = require('../intake/processGorgiasTickets');

// --- formatCompletedActions ---------------------------------------------------

test('formatCompletedActions: null when there is nothing to show', () => {
  assert.equal(formatCompletedActions([]), null);
  assert.equal(formatCompletedActions(null), null);
  assert.equal(formatCompletedActions(undefined), null);
});

test('formatCompletedActions: one line per action, dated, chronological', () => {
  const out = formatCompletedActions([
    { action_type: 'refund', executed_at: '2026-08-09T10:00:00Z', summary: 'Refund done' },
    { action_type: 'exchange', executed_at: '2026-08-07T10:00:00Z', summary: 'Exchange done' },
  ]);
  assert.deepEqual(out.split('\n'), [
    '  - exchange (2026-08-07): Exchange done',
    '  - refund (2026-08-09): Refund done',
  ]);
});

test('formatCompletedActions: keeps only the summary first line', () => {
  // `summary` is the executing agent's whole turn narrative — the tail is links
  // and markdown the reader does not need.
  const out = formatCompletedActions([
    { action_type: 'exchange', executed_at: '2026-08-07T10:00:00Z', summary: 'Exchange done\n- item one\n- item two' },
  ]);
  assert.equal(out, '  - exchange (2026-08-07): Exchange done');
});

test('formatCompletedActions: truncates a long first line', () => {
  const out = formatCompletedActions([
    { action_type: 'exchange', executed_at: '2026-08-07T10:00:00Z', summary: 'x'.repeat(500) },
  ]);
  assert.ok(out.length < 200, `expected truncation, got ${out.length} chars`);
});

test('formatCompletedActions: tolerates a missing executed_at and a missing summary', () => {
  const out = formatCompletedActions([{ action_type: 'warehouse_hold' }]);
  assert.equal(out, '  - warehouse_hold');
});

// --- buildPreviousDraftContext ------------------------------------------------

// Strict-ish stub: PostgREST requires .select() before filters, and a
// permissive stub has previously hidden a query that threw in production.
function stubSupabase(rows, { onSelect } = {}) {
  const calls = [];
  const chain = {
    select(cols) { calls.push(['select', cols]); if (onSelect) onSelect(cols); return chain; },
    eq(col, val) {
      assert.ok(calls.some(c => c[0] === 'select'), '.eq() called before .select()');
      calls.push(['eq', col, val]);
      return chain;
    },
    order(col, opts) { calls.push(['order', col, opts]); return Promise.resolve({ data: rows }); },
  };
  return {
    calls,
    from(table) { calls.push(['from', table]); return chain; },
  };
}

const HOLD_TURN = {
  status: 'sent',
  advisor_status: 'needs_info',
  action_type: 'warehouse_hold',
  action_result: null,
  structured_output: {},
  sent_response: "I've put a hold on the order so it won't ship until we've sorted this out.",
  actions: [{ action_type: 'warehouse_hold', executed_at: '2026-08-11T02:19:54Z', summary: 'Warehouse hold placed on order #32992' }],
};

// The defect's exact shape: the operator sent the invoice through the action
// panel, so the advisor never proposed it (action_type null) and the scratchpad
// was cleared (action_result null) — the only record is actions[]. Our reply
// promised it in the FUTURE tense, so with actions[] hidden the only available
// reading is that the invoice is still outstanding.
const INVOICE_TURN = {
  status: 'sent',
  advisor_status: 'ready',
  action_type: null,
  action_result: null,
  structured_output: {},
  sent_response: "I'll have added the Magical Chest Pads in medium and send an invoice for the difference.",
  actions: [{ action_type: 'invoice_kept_items', executed_at: '2026-08-11T11:47:52Z', summary: 'Invoice sent — Draft #D7000\n- 1x MAGICAL SHAPING GEL CHEST PADS (M) — $27.00' }],
};

test('buildPreviousDraftContext: surfaces an operator-executed action the advisor never proposed', async () => {
  const ctx = await buildPreviousDraftContext(stubSupabase([HOLD_TURN, INVOICE_TURN]), 112152156);
  assert.match(ctx, /ACTION LOG — operator actions already attempted/);
  assert.match(ctx, /invoice_kept_items \(2026-08-11\): Invoice sent — Draft #D7000/);
  assert.doesNotMatch(ctx, /1x MAGICAL SHAPING GEL CHEST PADS/, 'only the summary first line belongs here');
});

test('buildPreviousDraftContext: tells the advisor not to stage or re-promise the work', async () => {
  const ctx = await buildPreviousDraftContext(stubSupabase([HOLD_TURN, INVOICE_TURN]), 1);
  assert.match(ctx, /Do not stage work that already succeeded/i);
  assert.match(ctx, /do not promise it to the customer as still to come/i);
});

test('buildPreviousDraftContext: the log is framed as attempts, so a failed call is not called done', async () => {
  // `summary` is the whole turn narrative: a turn that completed one write
  // while previewing another files the preview text, and failed tool calls are
  // filed too. The block must not assert success over lines that record none.
  const failed = {
    ...INVOICE_TURN,
    actions: [{ action_type: 'create_order', executed_at: '2026-06-01T14:52:53Z', summary: 'Tool `create_order` failed with what looks like a bug: "No customer found"' }],
  };
  const ctx = await buildPreviousDraftContext(stubSupabase([failed]), 1);
  assert.match(ctx, /create_order \(2026-06-01\): Tool `create_order` failed/);
  assert.doesNotMatch(ctx, /this work is done/i);
  assert.match(ctx, /already attempted/i);
});

test('buildPreviousDraftContext: no block at all when nothing has executed', async () => {
  const ctx = await buildPreviousDraftContext(stubSupabase([
    { ...INVOICE_TURN, actions: [] },
    { ...HOLD_TURN, actions: null },
  ]), 1);
  assert.doesNotMatch(ctx, /ACTION LOG/);
  assert.match(ctx, /Agent sent:/, 'the per-turn narrative is unaffected');
});

test('buildPreviousDraftContext: a superseded draft keeps its executed action but loses its prose', async () => {
  // A regen supersedes the draft row; an action filed before that really ran.
  const superseded = {
    ...INVOICE_TURN,
    status: 'superseded',
    sent_response: null,
    draft_response: 'SUPERSEDED PROSE, must not appear',
  };
  const ctx = await buildPreviousDraftContext(stubSupabase([HOLD_TURN, superseded]), 1);
  assert.match(ctx, /invoice_kept_items/, 'the executed action survives the supersede');
  assert.doesNotMatch(ctx, /SUPERSEDED PROSE/);
});

test('buildPreviousDraftContext: null when the ticket has no drafts at all', async () => {
  assert.equal(await buildPreviousDraftContext(stubSupabase([]), 1), null);
  assert.equal(await buildPreviousDraftContext(stubSupabase(null), 1), null);
});

test('buildPreviousDraftContext: reads actions[] from the query', async () => {
  // Guards the root cause: the column was simply not selected, so no amount of
  // downstream logic could have seen it.
  let cols = '';
  await buildPreviousDraftContext(stubSupabase([HOLD_TURN], { onSelect: c => { cols = c; } }), 1);
  assert.match(cols, /\bactions\b/);
});

// --- DRY: one union helper, three consumers -----------------------------------

test('unionTicketActions and formatCompletedActions agree on ordering', () => {
  const drafts = [
    { actions: [{ action_type: 'refund', executed_at: '2026-08-09T10:00:00Z' }] },
    { actions: [{ action_type: 'exchange', executed_at: '2026-08-07T10:00:00Z' }] },
  ];
  const union = unionTicketActions(drafts);
  const formatted = formatCompletedActions(union);
  assert.deepEqual(union.map(a => a.action_type), ['exchange', 'refund']);
  assert.deepEqual(
    formatted.split('\n').map(l => l.trim().replace(/^- /, '').split(' ')[0]),
    ['exchange', 'refund'],
  );
});
