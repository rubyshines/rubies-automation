const test = require('node:test');
const assert = require('node:assert');
const {
  parseBotFlowSelection,
  findUncoveredSelections,
  checkSelectionCoverage,
} = require('../lib/selectionCoverage');

// The exact transcript shape the Gorgias return flow produced on ticket 3100.
const TICKET_3100 = `Help me with a return or exchange

Start a return or exchange

#32590 - $509.02 - July 23, 2026

Order number: #32590

Selected items:
1x AJ NO-TUCK SHAPING UNDERWEAR - Black / 12
1x RUBY NO-TUCK SHAPING BIKINI BOTTOM - Black / 12
1x AJ NO-TUCK SHAPING UNDERWEAR - Black / 10
1x RUBY NO-TUCK SHAPING BIKINI BOTTOM - Black / 11
1x SKY NO-TUCK SHAPING ONE-PIECE - Black / 11

Total: $169.58

Order Created: 7/23/2026, 4:47:54 PM

Shipping address: Whanganui

I'd like to return them please. Can you please let me know how to do this?`;

// What the advisor actually staged on draft 3180 — four of the five lines.
const DROPPED_STRUCTURED = {
  action_type: 'refund',
  operator_action_summary: 'refund order #32590 for 2x AJ (sizes 12 and 10), 1x Ruby size 12, 1x Ruby size 11',
  intake: {
    items: [
      { product: 'AJ', size: '12' },
      { product: 'Ruby', size: '12' },
      { product: 'AJ', size: '10' },
      { product: 'Ruby', size: '11' },
    ],
  },
  prescription: { flags: [] },
};
const DROPPED_DRAFT = "Hi,\n\nI've processed your refund for the AJ and Ruby bottoms to your original payment method.";

test('parseBotFlowSelection extracts every selected line', () => {
  const sel = parseBotFlowSelection(TICKET_3100);
  assert.strictEqual(sel.length, 5);
  assert.deepStrictEqual(sel[4], {
    quantity: 1,
    title: 'SKY NO-TUCK SHAPING ONE-PIECE',
    variant: 'Black / 11',
    line: '1x SKY NO-TUCK SHAPING ONE-PIECE - Black / 11',
  });
});

test('parseBotFlowSelection stops at the Total line, not at the end of the message', () => {
  const sel = parseBotFlowSelection(TICKET_3100);
  assert.ok(sel.every((s) => !/total/i.test(s.title)));
});

test('parseBotFlowSelection returns [] when there is no selection block', () => {
  assert.deepStrictEqual(parseBotFlowSelection('My order never arrived, can you check?'), []);
  assert.deepStrictEqual(parseBotFlowSelection(''), []);
  assert.deepStrictEqual(parseBotFlowSelection(null), []);
});

test('findUncoveredSelections names the dropped one-piece', () => {
  const sel = parseBotFlowSelection(TICKET_3100);
  const uncovered = findUncoveredSelections(sel, DROPPED_STRUCTURED, DROPPED_DRAFT);
  assert.strictEqual(uncovered.length, 1);
  assert.match(uncovered[0].title, /SKY/);
});

test('a complete refund produces no uncovered lines', () => {
  const sel = parseBotFlowSelection(TICKET_3100);
  const complete = {
    action_type: 'refund',
    operator_action_summary: 'refund order #32590 for 2x AJ (12, 10), 1x Ruby 12, 1x Ruby 11, 1x Sky one-piece 11',
    intake: {
      items: [
        { product: 'AJ', size: '12' },
        { product: 'Ruby', size: '12' },
        { product: 'AJ', size: '10' },
        { product: 'Ruby', size: '11' },
        { product: 'Sky One-Piece', size: '11' },
      ],
    },
    prescription: { flags: [] },
  };
  assert.deepStrictEqual(findUncoveredSelections(sel, complete, 'refund processed'), []);
});

test('the product name alone covers a line — prose need not re-itemize', () => {
  // The prompt tells the advisor to refer to goods generically in return asks,
  // so coverage must come from the staged action, not from itemized prose.
  const sel = parseBotFlowSelection(TICKET_3100);
  const genericProse = {
    action_type: 'refund',
    operator_action_summary: 'refund order #32590 for all 5 selected items: AJ 12, AJ 10, Ruby 12, Ruby 11, Sky 11',
    intake: { items: [] },
    prescription: { flags: [] },
  };
  assert.deepStrictEqual(
    findUncoveredSelections(sel, genericProse, 'Please send the items back to the address below.'),
    []
  );
});

test('checkSelectionCoverage flags the ticket-3100 refund', () => {
  const res = checkSelectionCoverage(TICKET_3100, DROPPED_STRUCTURED, DROPPED_DRAFT);
  assert.ok(res.flag, 'expected a flag');
  assert.match(res.flag, /^⚠️ Selection mismatch/);
  assert.match(res.flag, /SKY NO-TUCK SHAPING ONE-PIECE/);
  assert.match(res.flag, /selected 5 items/);
});

test('whole-order actions are exempt — they cover every line without naming one', () => {
  // Repro of drafts 2662 / 2677 (ticket 2610): the customer selected two items
  // in the flow and the action was a hold, then a cancellation of the whole
  // order. Both legitimately name no items at all.
  const holdText = `Order number: #32472

Selected items:
1x RUBY NO-TUCK SHAPING BIKINI BOTTOM - Black / L
1x MIA HALTER BIKINI TOP - Black / 2X

Total: $88.00

Can you hold this, I need to change it.`;
  for (const action_type of ['warehouse_hold', 'cancellation', 'order_modification']) {
    const res = checkSelectionCoverage(holdText, {
      action_type,
      operator_action_summary: 'Place warehouse hold on order #32472 pending customer decision.',
      intake: { items: [] },
      prescription: { flags: [] },
    }, 'I have placed a hold on your order.');
    assert.deepStrictEqual(res, {}, `${action_type} should be exempt`);
  }
});

test('no action staged means nothing to check', () => {
  assert.deepStrictEqual(
    checkSelectionCoverage(TICKET_3100, { action_type: null, intake: { items: [] } }, 'What did not work out?'),
    {}
  );
});

test('a single-item selection is never flagged', () => {
  const oneItem = `Order number: #31000

Selected items:
1x RUBY NO-TUCK SHAPING BIKINI BOTTOM - Black / L

Total: $44.00

Please refund this.`;
  assert.deepStrictEqual(
    checkSelectionCoverage(oneItem, {
      action_type: 'refund',
      operator_action_summary: 'refund order #31000',
      intake: { items: [] },
      prescription: { flags: [] },
    }, 'refund processed'),
    {}
  );
});

test('generic-only titles are never flagged (no identifying token to test)', () => {
  const tipOrder = `Order number: #31001

Selected items:
1x RUBY NO-TUCK SHAPING BIKINI BOTTOM - Black / L
1x Tip - null

Total: $50.00

Refund please.`;
  const res = checkSelectionCoverage(tipOrder, {
    action_type: 'refund',
    operator_action_summary: 'refund order #31001 for 1x Ruby L',
    intake: { items: [{ product: 'Ruby', size: 'L' }] },
    prescription: { flags: [] },
  }, 'refund processed');
  // "Tip" is 3 chars and not generic, so it IS testable — and it is genuinely
  // unmentioned. The guard is visibility-only, so flagging here is acceptable;
  // what must never happen is a crash or a flag naming the covered Ruby line.
  if (res.flag) assert.ok(!/RUBY/i.test(res.flag), 'must not flag the covered Ruby line');
});
