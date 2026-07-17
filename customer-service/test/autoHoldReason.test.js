const { test } = require('node:test');
const assert = require('node:assert');

const { autoHoldReason } = require('../intake/processGorgiasTickets');

// The auto-hold note text is keyed off the advisor's inquiry classification.
// Cancellations read as a cancel-hold; every other modify (item add/swap/remove,
// or an address change with no new address given) reads as a generic order edit.
// It must NOT claim "address change" for 'shipping' — add-item requests also
// classify as shipping, and genuine address-change holds get their accurate
// reason from fallbackToHold, not this path.

test('autoHoldReason: cancellation message_type', () => {
  assert.match(autoHoldReason('cancellation'), /asked to cancel/i);
});

test('autoHoldReason: cancellation action_type (protective hold on a clear cancel — message_type is often general_inquiry)', () => {
  assert.match(autoHoldReason('general_inquiry', 'cancellation'), /asked to cancel/i);
});

test('autoHoldReason: shipping does NOT mislabel as an address change', () => {
  const reason = autoHoldReason('shipping');
  assert.doesNotMatch(reason, /address change/i);
  assert.match(reason, /modify the order/i);
});

test('autoHoldReason: any other type falls back to generic order modification', () => {
  assert.match(autoHoldReason('exchange'), /modify the order/i);
  assert.match(autoHoldReason(undefined), /modify the order/i);
});
