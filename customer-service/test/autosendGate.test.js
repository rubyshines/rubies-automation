const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateAutosend, NEVER_TYPES } = require('../lib/autosendGate');

const cleanClosing = {
  structured: { status: 'ready' },
  draftResponse: 'So glad everything worked out! Let me know if you need anything else. Jamie',
  messageType: 'closing',
};

test('clean closing draft passes pure checks', () => {
  const v = evaluateAutosend(cleanClosing);
  assert.equal(v.eligible, true);
});

test('never-list categories are blocked even with clean drafts', () => {
  for (const t of ['exchange', 'refund', 'free_order', 'discount_request', 'defect']) {
    const v = evaluateAutosend({ ...cleanClosing, messageType: t });
    assert.equal(v.eligible, false, t);
    assert.match(v.reason, /never-list/);
  }
});

test('any action_type blocks, regardless of category', () => {
  const v = evaluateAutosend({ ...cleanClosing, structured: { status: 'ready', action_type: 'warehouse_hold' } });
  assert.equal(v.eligible, false);
  assert.match(v.reason, /action_type/);
});

test('operator_action_summary blocks', () => {
  const v = evaluateAutosend({ ...cleanClosing, structured: { status: 'ready', operator_action_summary: 'create exchange' } });
  assert.equal(v.eligible, false);
});

test('non-ready status blocks', () => {
  for (const s of ['needs_info', 'gathering', 'route_to_human']) {
    const v = evaluateAutosend({ ...cleanClosing, structured: { status: s } });
    assert.equal(v.eligible, false, s);
  }
});

test('placeholder drafts block', () => {
  const v = evaluateAutosend({ ...cleanClosing, draftResponse: 'Here is your code: [CODE]' });
  assert.equal(v.eligible, false);
  const v2 = evaluateAutosend({ ...cleanClosing, draftResponse: '[AI could not draft a response — needs manual reply]' });
  assert.equal(v2.eligible, false);
});

test('empty draft blocks', () => {
  const v = evaluateAutosend({ ...cleanClosing, draftResponse: '   ' });
  assert.equal(v.eligible, false);
});

test('uncategorized/unknown are on the never-list', () => {
  assert.ok(NEVER_TYPES.has('uncategorized'));
  assert.ok(NEVER_TYPES.has('unknown'));
});
