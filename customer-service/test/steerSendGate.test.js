const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateSteerSendPure } = require('../lib/steerSendGate');

const cleanSteered = {
  steer: 'shorter, drop the explanation',
  structured: { status: 'ready' },
  prevStructured: { status: 'ready' },
  draftResponse: 'Hi, size 16 is the right fit here. Take care, Jamie',
  messageType: 'sizing_inquiry',
};

test('clean prose-only steered draft passes pure checks', () => {
  const v = evaluateSteerSendPure(cleanSteered);
  assert.equal(v.eligible, true);
  assert.equal(v.action_changed, false);
});

test('missing steer text blocks', () => {
  for (const steer of [null, undefined, '', '   ']) {
    const v = evaluateSteerSendPure({ ...cleanSteered, steer });
    assert.equal(v.eligible, false, JSON.stringify(steer));
  }
});

test('never-list categories are blocked', () => {
  for (const t of ['exchange', 'refund', 'free_order', 'discount_request', 'defect']) {
    const v = evaluateSteerSendPure({ ...cleanSteered, messageType: t });
    assert.equal(v.eligible, false, t);
    assert.match(v.reason, /never-list/);
  }
});

test('any action_type on the steered draft blocks', () => {
  const v = evaluateSteerSendPure({
    ...cleanSteered,
    structured: { status: 'ready', action_type: 'warehouse_hold' },
    prevStructured: { status: 'ready', action_type: 'warehouse_hold' },
  });
  assert.equal(v.eligible, false);
  assert.match(v.reason, /action_type/);
});

test('steer that changes the action blocks and records action_changed', () => {
  // Action removed by the steer: prev had one, new does not.
  const removed = evaluateSteerSendPure({
    ...cleanSteered,
    prevStructured: { status: 'ready', action_type: 'refund' },
  });
  assert.equal(removed.eligible, false);
  assert.equal(removed.action_changed, true);
  assert.match(removed.reason, /changed action_type/);

  // Action added by the steer: caught by the carries-action check first,
  // but action_changed must still be true for the recorded row.
  const added = evaluateSteerSendPure({
    ...cleanSteered,
    structured: { status: 'ready', action_type: 'refund' },
  });
  assert.equal(added.eligible, false);
  assert.equal(added.action_changed, true);
});

test('operator_action_summary blocks', () => {
  const v = evaluateSteerSendPure({
    ...cleanSteered,
    structured: { status: 'ready', operator_action_summary: 'swap to size M' },
  });
  assert.equal(v.eligible, false);
});

test('discount code blocks', () => {
  const v = evaluateSteerSendPure({
    ...cleanSteered,
    structured: { status: 'ready', discount_code: 'THANKYOU10' },
  });
  assert.equal(v.eligible, false);
});

test('non-ready status blocks', () => {
  for (const s of ['needs_info', 'gathering', 'route_to_human']) {
    const v = evaluateSteerSendPure({ ...cleanSteered, structured: { status: s } });
    assert.equal(v.eligible, false, s);
  }
});

test('placeholder and empty drafts block', () => {
  assert.equal(evaluateSteerSendPure({ ...cleanSteered, draftResponse: '' }).eligible, false);
  assert.equal(evaluateSteerSendPure({ ...cleanSteered, draftResponse: '[AI could not draft a response]' }).eligible, false);
  assert.equal(evaluateSteerSendPure({ ...cleanSteered, draftResponse: 'Use code [CODE] at checkout' }).eligible, false);
});

test('missing structured or message_type blocks', () => {
  assert.equal(evaluateSteerSendPure({ ...cleanSteered, structured: null }).eligible, false);
  assert.equal(evaluateSteerSendPure({ ...cleanSteered, messageType: null }).eligible, false);
});
