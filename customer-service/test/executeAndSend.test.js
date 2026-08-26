/**
 * Execute & Send — gate logic, AUTO_CONFIRM verdict parsing, and orchestration
 * ordering. All pure / dependency-injected: no network, no Supabase, no Anthropic.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { stripAutoConfirm } = require('../lib/operatorAgent');
const { evaluateExecuteSendGate, orchestrateExecuteAndSend } = require('../dashboard/server');

// A clean phase-1 preview: one write tool awaiting confirmation + SAFE verdict.
function safePhase1() {
  return {
    response: 'Exchange Draft Order Created — Awaiting Confirmation\n...',
    auto_confirm: { safe: true, reason: null },
    tool_results: [{ tool: 'create_exchange_order', result: 'Draft created. Awaiting confirmation.' }],
    history: [{ role: 'user', content: 'do it' }],
  };
}

// --- stripAutoConfirm ---------------------------------------------------------

test('stripAutoConfirm: lifts SAFE verdict and removes the line', () => {
  const { clean, verdict } = stripAutoConfirm('Preview...\nawaiting confirmation\n\nAUTO_CONFIRM: SAFE');
  assert.deepEqual(verdict, { safe: true, reason: null });
  assert.ok(!/AUTO_CONFIRM/.test(clean));
  assert.ok(clean.endsWith('awaiting confirmation'));
});

test('stripAutoConfirm: parses HOLD with a reason', () => {
  const { clean, verdict } = stripAutoConfirm('Refund preview ⚠️ Note: amount.\nawaiting confirmation\nAUTO_CONFIRM: HOLD — draft amount differs');
  assert.equal(verdict.safe, false);
  assert.equal(verdict.reason, 'draft amount differs');
  assert.ok(!/AUTO_CONFIRM/.test(clean));
});

test('stripAutoConfirm: no verdict returns text unchanged and null', () => {
  const { clean, verdict } = stripAutoConfirm('Just a preview, no verdict.');
  assert.equal(verdict, null);
  assert.equal(clean, 'Just a preview, no verdict.');
});

// --- evaluateExecuteSendGate --------------------------------------------------

test('gate SAFE: SAFE verdict + exactly one awaiting-confirmation write', () => {
  assert.deepEqual(evaluateExecuteSendGate(safePhase1()), { safe: true, reason: null });
});

test('gate HOLD: verdict says HOLD (divergence) even with a clean preview', () => {
  const p = safePhase1();
  p.auto_confirm = { safe: false, reason: 'draft amount differs from refund' };
  const g = evaluateExecuteSendGate(p);
  assert.equal(g.safe, false);
  assert.equal(g.reason, 'draft amount differs from refund');
});

test('gate HOLD: no verdict emitted (e.g. a clarifying question)', () => {
  const g = evaluateExecuteSendGate({ response: 'Which order did you mean?', auto_confirm: null, tool_results: [] });
  assert.equal(g.safe, false);
});

test('gate HOLD: preview duplicates a live order, even when the agent graded itself SAFE', () => {
  // The whole point of reading the marker rather than the verdict: on ticket
  // 3138 the agent was confident about the wrong tool. A self-graded SAFE must
  // not be able to auto-send a draft the tool has already identified as a
  // duplicate shipment.
  const { LIVE_ORDER_OVERLAP_MARKER } = require('../lib/orderUtils');
  const p = safePhase1();
  p.tool_results = [{
    tool: 'create_invoice_order',
    result: `⚠️ **STOP — THIS DRAFT ${LIVE_ORDER_OVERLAP_MARKER}.**\nDraft created. Awaiting confirmation.`,
  }];
  const g = evaluateExecuteSendGate(p);
  assert.equal(g.safe, false);
  assert.match(g.reason, /live unshipped order/);
});

test('gate HOLD: SAFE verdict but no awaiting-confirmation preview', () => {
  const g = evaluateExecuteSendGate({ auto_confirm: { safe: true }, tool_results: [{ tool: 'get_order_details', result: 'order info' }] });
  assert.equal(g.safe, false);
  assert.match(g.reason, /no clean action preview/i);
});

test('gate HOLD: SAFE verdict but more than one previewed write', () => {
  const g = evaluateExecuteSendGate({
    auto_confirm: { safe: true },
    tool_results: [
      { tool: 'create_exchange_order', result: 'awaiting confirmation' },
      { tool: 'refund_order', result: 'awaiting confirmation' },
    ],
  });
  assert.equal(g.safe, false);
  assert.match(g.reason, /multiple actions/i);
});

// --- orchestrateExecuteAndSend (ordering guarantees) --------------------------

function recorder() {
  const calls = [];
  return { fn: async (status, reason) => calls.push({ status, reason }), calls };
}

test('orchestration: SAFE runs phase 2 then send → sent', async () => {
  const order = [];
  const rec = recorder();
  const res = await orchestrateExecuteAndSend({
    command: 'refund order #1 for 1x Sassy',
    runPhase1: async () => { order.push('p1'); return safePhase1(); },
    runPhase2: async () => { order.push('p2'); return { response: 'Refunded.', tool_results: [{ tool: 'refund_order', result: 'Refund of $28.00 processed.' }] }; },
    sendDraft: async () => { order.push('send'); },
    recordOutcome: rec.fn,
  });
  assert.equal(res.outcome, 'sent');
  assert.deepEqual(order, ['p1', 'p2', 'send']);
  assert.equal(rec.calls.length, 0); // no badge on success
});

test('orchestration: HOLD runs NO phase 2 and NO send', async () => {
  const order = [];
  const rec = recorder();
  const held = safePhase1();
  held.auto_confirm = { safe: false, reason: 'flagged' };
  const res = await orchestrateExecuteAndSend({
    command: 'refund order #1',
    runPhase1: async () => { order.push('p1'); return held; },
    runPhase2: async () => { order.push('p2'); throw new Error('should not run'); },
    sendDraft: async () => { order.push('send'); throw new Error('should not run'); },
    recordOutcome: rec.fn,
  });
  assert.equal(res.outcome, 'hold');
  assert.deepEqual(order, ['p1']);
  assert.equal(rec.calls[0].status, 'hold');
});

test('orchestration: phase-2 failure sends NO email → error', async () => {
  const order = [];
  const rec = recorder();
  const res = await orchestrateExecuteAndSend({
    command: 'refund order #1',
    runPhase1: async () => safePhase1(),
    runPhase2: async () => { order.push('p2'); throw new Error('Shopify 500'); },
    sendDraft: async () => { order.push('send'); },
    recordOutcome: rec.fn,
  });
  assert.equal(res.outcome, 'error');
  assert.ok(!order.includes('send'));
  assert.equal(rec.calls[0].status, 'error');
});

test('orchestration: phase 2 returns no completed write → error, no send', async () => {
  const order = [];
  const rec = recorder();
  const res = await orchestrateExecuteAndSend({
    command: 'refund order #1',
    runPhase1: async () => safePhase1(),
    // Still awaiting confirmation = did not actually execute.
    runPhase2: async () => ({ response: '...', tool_results: [{ tool: 'refund_order', result: 'awaiting confirmation' }] }),
    sendDraft: async () => { order.push('send'); },
    recordOutcome: rec.fn,
  });
  assert.equal(res.outcome, 'error');
  assert.ok(!order.includes('send'));
});

test('orchestration: send failure after a completed action → half', async () => {
  const rec = recorder();
  const res = await orchestrateExecuteAndSend({
    command: 'refund order #1',
    runPhase1: async () => safePhase1(),
    runPhase2: async () => ({ response: 'Refunded.', tool_results: [{ tool: 'refund_order', result: 'Refund processed.' }] }),
    sendDraft: async () => { throw new Error('Gorgias timeout'); },
    recordOutcome: rec.fn,
  });
  assert.equal(res.outcome, 'half');
  assert.equal(rec.calls[0].status, 'half');
});

test('orchestration: empty command → error before any phase', async () => {
  let ran = false;
  const res = await orchestrateExecuteAndSend({
    command: '',
    runPhase1: async () => { ran = true; return safePhase1(); },
    runPhase2: async () => safePhase1(),
    sendDraft: async () => {},
    recordOutcome: async () => {},
  });
  assert.equal(res.outcome, 'error');
  assert.equal(ran, false);
});
