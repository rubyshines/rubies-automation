const { test } = require('node:test');
const assert = require('node:assert');

const { autoHoldReason } = require('../intake/processGorgiasTickets');

// The auto-hold note text is keyed off the advisor's inquiry classification.
// An address change with no new address yet is proposed as a bare warehouse_hold
// (the address auto-apply path needs an extracted address), so it falls through
// to this generic hold path and must still read as an address change.

test('autoHoldReason: cancellation', () => {
  assert.match(autoHoldReason('cancellation'), /asked to cancel/i);
});

test('autoHoldReason: shipping reads as an address change, not an item modification', () => {
  const reason = autoHoldReason('shipping');
  assert.match(reason, /address change/i);
  assert.doesNotMatch(reason, /modify the order/i);
});

test('autoHoldReason: any other type falls back to generic order modification', () => {
  assert.match(autoHoldReason('exchange'), /modify the order/i);
  assert.match(autoHoldReason(undefined), /modify the order/i);
});
