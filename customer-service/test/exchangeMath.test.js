/**
 * exchangeMath — price-difference calc for exchanges with differing items.
 * Pure: no network, no Supabase, no Anthropic.
 *
 * Fixtures mirror the live managed_discounts registry (volume tiers) and a
 * store-wide flat sale. The scenario numbers here are the ones Jamie verified.
 *
 * NOTE: routing (straight swap → free exchange; "make this exchange" without an
 * explicit invoice instruction → free; net<0 → always refund) is operator-prompt
 * logic, asserted in operatorAgentContext.test.js — not in this pure calc.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  computeExchangeDifference,
  recommendExchangeAction,
  settleExchange,
  EXCHANGE_WAIVE_THRESHOLD_USD,
  itemSetsIdentical,
  volumePctForQuantity,
  salePctForSubtotal,
} = require('../lib/exchangeMath');

// --- live-registry fixtures ---------------------------------------------------
const VOLUME = [
  { name: 'AJ Volume Discount', sku_prefixes: ['AJ'], tiers: [{ threshold: 3, percentage: 10 }, { threshold: 5, percentage: 15 }] },
  { name: 'Ruby Volume Discount', sku_prefixes: ['RUBY'], tiers: [{ threshold: 2, percentage: 10 }] },
  { name: 'Charlie Volume Discount', sku_prefixes: ['UNW'], tiers: [{ threshold: 3, percentage: 10 }, { threshold: 5, percentage: 15 }] },
];
const SALE_15 = { name: 'Pride Sale', tiers: [{ threshold: 0, percentage: 15 }] }; // store-wide flat 15%
const SALE_5 = { name: 'Weak Sale', tiers: [{ threshold: 0, percentage: 5 }] };

// Eitan's new items (real catalog prices)
const EITAN_NEW = [
  { sku: 'RUBY-BLK-10', unitPrice: 44, quantity: 1 },
  { sku: 'RUBY-BLK-11', unitPrice: 44, quantity: 2 },
  { sku: 'AJ-BLK-10', unitPrice: 28, quantity: 1 },
];
const EITAN_CREDIT = 98.15; // 1x Flo 12 ($28.79) + 3x AJ 12 ($23.12), actual paid

// --- helper-level unit tests --------------------------------------------------

test('volumePctForQuantity: tier thresholds', () => {
  const aj = [{ threshold: 3, percentage: 10 }, { threshold: 5, percentage: 15 }];
  assert.equal(volumePctForQuantity(1, aj), 0);
  assert.equal(volumePctForQuantity(3, aj), 10);
  assert.equal(volumePctForQuantity(5, aj), 15);
  assert.equal(volumePctForQuantity(2, [{ threshold: 2, percentage: 10 }]), 10);
});

test('salePctForSubtotal: flat and subtotal tiers', () => {
  assert.equal(salePctForSubtotal(SALE_15, 50), 15); // flat applies at any subtotal
  assert.equal(salePctForSubtotal(null, 999), 0);
  const tiered = { tiers: [{ threshold: 100, percentage: 15 }, { threshold: 200, percentage: 20 }] };
  assert.equal(salePctForSubtotal(tiered, 90), 0);
  assert.equal(salePctForSubtotal(tiered, 150), 15);
  assert.equal(salePctForSubtotal(tiered, 250), 20);
});

// --- Scenario 2: different items, volume only (no active sale) — Eitan today ---
test('#2 invoice: Ruby 2+ volume applies, lone AJ does not', () => {
  const r = computeExchangeDifference({ newItems: EITAN_NEW, returnCredit: EITAN_CREDIT, volumeDiscounts: VOLUME, sale: null });
  const ruby = r.lines.filter((l) => l.sku.startsWith('RUBY'));
  assert.ok(ruby.every((l) => l.effectivePct === 10), 'Ruby qty 3 ≥ 2 → 10%');
  assert.equal(r.lines.find((l) => l.sku.startsWith('AJ')).effectivePct, 0, 'AJ qty 1 < 3 → none');
  assert.equal(r.newSubtotal, 146.80);
  assert.equal(r.net, 48.65);
  assert.equal(r.direction, 'invoice');
});

// --- Scenario 3: same items + store-wide 15% sale, highest-wins per line -------
test('#3 invoice: sale 15% beats Ruby 10% and applies to the AJ', () => {
  const r = computeExchangeDifference({ newItems: EITAN_NEW, returnCredit: EITAN_CREDIT, volumeDiscounts: VOLUME, sale: SALE_15 });
  assert.ok(r.lines.every((l) => l.effectivePct === 15), 'every line max(vol,15) = 15');
  assert.equal(r.newSubtotal, 136.00);
  assert.equal(r.net, 37.85);
  assert.equal(r.direction, 'invoice');
});

// --- Scenario 4: weak 5% sale — volume wins on Ruby, sale wins on AJ -----------
test('#4 invoice: volume 10% beats 5% sale on Ruby; 5% applies to AJ', () => {
  const r = computeExchangeDifference({ newItems: EITAN_NEW, returnCredit: EITAN_CREDIT, volumeDiscounts: VOLUME, sale: SALE_5 });
  assert.ok(r.lines.filter((l) => l.sku.startsWith('RUBY')).every((l) => l.effectivePct === 10));
  assert.equal(r.lines.find((l) => l.sku.startsWith('AJ')).effectivePct, 5);
  assert.equal(r.newSubtotal, 145.40);
  assert.equal(r.net, 47.25);
  assert.equal(r.direction, 'invoice');
});

// --- Scenario 5 (corrected): different items, exercises AJ 3+ tier ------------
test('#5 invoice: 3x AJ hits the AJ 3+ tier (10%)', () => {
  const r = computeExchangeDifference({
    newItems: [{ sku: 'AJ-BLK-10', unitPrice: 28, quantity: 3 }],
    returnCredit: 60.00,
    volumeDiscounts: VOLUME,
    sale: null,
  });
  assert.equal(r.lines[0].effectivePct, 10);
  assert.equal(r.newSubtotal, 75.60);
  assert.equal(r.net, 15.60);
  assert.equal(r.direction, 'invoice');
});

// --- Scenario 7 (reverse): cheaper exchange → refund --------------------------
test('#7 refund: new items cheaper than returned → negative net, refund', () => {
  const r = computeExchangeDifference({
    newItems: [{ sku: 'AJ-BLK-10', unitPrice: 28, quantity: 1 }],
    returnCredit: 79.20, // 2x Ruby paid at the 2+ volume price
    volumeDiscounts: VOLUME,
    sale: null,
  });
  assert.equal(r.newSubtotal, 28.00);
  assert.equal(r.net, -51.20);
  assert.equal(r.direction, 'refund');
});

// --- Scenario 8 (reverse): refund still applies discount to the new items -----
test('#8 refund: new Ruby 2+ discounted, still nets negative → refund', () => {
  const r = computeExchangeDifference({
    newItems: [{ sku: 'RUBY-BLK-11', unitPrice: 44, quantity: 2 }],
    returnCredit: 98.15,
    volumeDiscounts: VOLUME,
    sale: null,
  });
  assert.ok(r.lines[0].effectivePct === 10, 'Ruby qty 2 → 10% even in the refund direction');
  assert.equal(r.newSubtotal, 79.20);
  assert.equal(r.net, -18.95);
  assert.equal(r.direction, 'refund');
});

// --- routing decision (the charge / no-charge / refund policy) ----------------
// This is the decision matrix Jamie set. The agent only supplies
// operatorRequestedInvoice (its reading of the message); everything else is math.

test('routing: straight swap (identical items) → free exchange, even if "invoice" said', () => {
  assert.equal(recommendExchangeAction({ net: 6.24, itemsIdentical: true, operatorRequestedInvoice: true }), 'free_exchange');
});

test('routing: different items, net>0, operator did NOT ask to invoice → free exchange (absorb)', () => {
  assert.equal(recommendExchangeAction({ net: 48.65, itemsIdentical: false, operatorRequestedInvoice: false }), 'free_exchange');
});

test('routing: different items, net>0, operator asked to invoice → invoice', () => {
  assert.equal(recommendExchangeAction({ net: 48.65, itemsIdentical: false, operatorRequestedInvoice: true }), 'invoice');
});

test('routing: different items, net<0 → always refund (no instruction needed)', () => {
  assert.equal(recommendExchangeAction({ net: -51.20, itemsIdentical: false, operatorRequestedInvoice: false }), 'refund');
});

test('routing: net==0 → free exchange', () => {
  assert.equal(recommendExchangeAction({ net: 0, itemsIdentical: false, operatorRequestedInvoice: true }), 'free_exchange');
});

test('itemSetsIdentical: same SKUs+qty true; size swap false', () => {
  assert.equal(itemSetsIdentical([{ sku: 'AJ-BLK-12', quantity: 3 }], [{ sku: 'AJ-BLK-12', quantity: 3 }]), true);
  assert.equal(itemSetsIdentical([{ sku: 'AJ-BLK-12', quantity: 3 }], [{ sku: 'AJ-BLK-10', quantity: 3 }]), false);
  assert.equal(itemSetsIdentical([{ sku: 'AJ-BLK-12', quantity: 3 }], [{ sku: 'AJ-BLK-12', quantity: 2 }]), false);
});

// --- settleExchange: the advisor's view of the same policy --------------------
// Jamie, 2026-08-11: small upcharges slide, the customer is always refunded,
// and adding to an order is invoiced. The threshold lives here rather than in
// the prompt because the advisor has no prices and must not judge money.
test('settle: customer owed money is always refunded, however large or small', () => {
  assert.equal(settleExchange({ net: -0.01 }), 'refund');
  assert.equal(settleExchange({ net: -120 }), 'refund');
});

test('settle: upcharge at or under the threshold is waived, above it is invoiced', () => {
  assert.equal(EXCHANGE_WAIVE_THRESHOLD_USD, 15);
  assert.equal(settleExchange({ net: 0.01 }), 'waive');
  assert.equal(settleExchange({ net: 14.99 }), 'waive');
  // Boundary is inclusive on the waive side — exactly $15 is still "small".
  assert.equal(settleExchange({ net: 15 }), 'waive');
  assert.equal(settleExchange({ net: 15.01 }), 'invoice');
  assert.equal(settleExchange({ net: 85 }), 'invoice');
});

test('settle: an even swap and a straight swap both say nothing about money', () => {
  assert.equal(settleExchange({ net: 0 }), 'even');
  // itemsIdentical short-circuits before the threshold — a same-SKU swap is
  // free by policy even if the catalog price moved since they bought.
  assert.equal(settleExchange({ net: 85, itemsIdentical: true }), 'even');
  assert.equal(settleExchange({ net: -85, itemsIdentical: true }), 'even');
});

test('settle: a customer who asks to pay is invoiced even under the threshold', () => {
  assert.equal(settleExchange({ net: 5 }), 'waive');
  assert.equal(settleExchange({ net: 5, customerAskedToPay: true }), 'invoice');
  // But asking to pay never overrides money owed BACK to them, and never
  // turns a straight swap into a charge.
  assert.equal(settleExchange({ net: -30, customerAskedToPay: true }), 'refund');
  assert.equal(settleExchange({ net: 0, customerAskedToPay: true }), 'even');
  assert.equal(settleExchange({ net: 40, itemsIdentical: true, customerAskedToPay: true }), 'even');
});

test('settle: threshold is overridable for testing but defaults to the policy', () => {
  assert.equal(settleExchange({ net: 20, thresholdUsd: 25 }), 'waive');
  assert.equal(settleExchange({ net: 20 }), 'invoice');
});

// --- even-swap value guard ----------------------------------------------------
test('even: new subtotal equals credit → direction "even"', () => {
  const r = computeExchangeDifference({
    newItems: [{ sku: 'AJ-BLK-10', unitPrice: 28, quantity: 1 }],
    returnCredit: 28.00,
    volumeDiscounts: VOLUME,
    sale: null,
  });
  assert.equal(r.net, 0);
  assert.equal(r.direction, 'even');
});
