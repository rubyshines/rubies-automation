/**
 * edit_order — targeting one line when a SKU appears on several.
 *
 * Regression cover for a live block on #32310 (2026-08-17), a Simple Bundles order
 * that carried AJ-BLK-L / AJ-SND-L / AJ-PNK-L twice each: once at the bundle price
 * and once at full price. `remove_sku` resolved with `.find()` in two independent
 * places (plan build and edit staging), so both entries for a SKU targeted the first
 * line; the second then computed a negative quantity that clamped to 0, silently
 * under-removing instead of erroring. A size swap across the order was unexpressible.
 *
 * The fix: remove_line_item_id addresses one line, and an ambiguous remove_sku is a
 * loud error listing the candidates rather than a guess.
 *
 * Stubbing follows the resolveLineItems.test.js pattern: seed require.cache
 * before requiring the module under test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };

const money = (amount) => ({ shopMoney: { amount, currencyCode: 'USD' } });

// Two lines share AJ-BLK-L: the bundle line at $22.40 and the full-price line at $32.00.
const LINE_BUNDLE = 'gid://shopify/LineItem/17874555863318';
const LINE_FULL = 'gid://shopify/LineItem/17874556059926';
const LINE_UNIQUE = 'gid://shopify/LineItem/17874555961622';

const orderLineItems = () => ([
  {
    id: LINE_BUNDLE, sku: 'AJ-BLK-L', title: 'AJ NO-TUCK SHAPING UNDERWEAR',
    variantTitle: 'Black / L', quantity: 1,
    originalUnitPriceSet: money('22.40'), discountAllocations: [],
    variant: { id: 'gid://shopify/ProductVariant/39428866441301' },
  },
  {
    id: LINE_FULL, sku: 'AJ-BLK-L', title: 'AJ NO-TUCK SHAPING UNDERWEAR',
    variantTitle: 'Black / L', quantity: 2,
    originalUnitPriceSet: money('32.00'), discountAllocations: [],
    variant: { id: 'gid://shopify/ProductVariant/39428866441301' },
  },
  {
    id: LINE_UNIQUE, sku: 'RUBY-BLK-L', title: 'RUBY NO-TUCK SHAPING BIKINI BOTTOM',
    variantTitle: 'Black / L', quantity: 1,
    originalUnitPriceSet: money('48.00'), discountAllocations: [],
    variant: { id: 'gid://shopify/ProductVariant/32134472237141' },
  },
]);

// Shopify mints CalculatedLineItem ids with the same numeric suffix as their LineItem.
const calcLineItems = () => orderLineItems().map(li => ({
  id: li.id.replace('LineItem', 'CalculatedLineItem'),
  sku: li.sku, title: li.title, variantTitle: li.variantTitle,
  quantity: li.quantity, variant: li.variant, calculatedDiscountAllocations: [],
}));

const state = { setQuantityCalls: [], addVariantCalls: [] };

stub(path.join(LIB, 'shopify.js'), {
  getOrderForEdit: async () => ({
    id: 'gid://shopify/Order/7350439182614',
    name: '#32310',
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    cancelledAt: null,
    customer: { email: 'buyer@example.com' },
    shippingAddress: { countryCodeV2: 'US' },
    shippingLines: [{ title: 'Free US Standard Shipping' }],
    totalPriceSet: money('403.92'),
    currentTotalPriceSet: money('403.92'),
    lineItems: orderLineItems(),
  }),
  orderEditBegin: async () => ({ id: 'gid://shopify/CalculatedOrder/1', lineItems: calcLineItems() }),
  orderEditSetQuantity: async (_calcId, lineId, qty) => {
    state.setQuantityCalls.push({ lineId, qty });
    return {};
  },
  orderEditAddVariant: async (_calcId, variantId, quantity) => {
    state.addVariantCalls.push({ variantId, quantity });
    return {
      calculatedLineItem: {
        id: `gid://shopify/CalculatedLineItem/added-${state.addVariantCalls.length}`,
        title: 'AJ NO-TUCK SHAPING UNDERWEAR', variantTitle: 'Black / M',
        quantity, originalUnitPriceSet: money('32.00'), calculatedDiscountAllocations: [],
      },
    };
  },
  orderEditAddLineItemDiscount: async () => ({}),
  orderEditCommit: async () => ({}),
  sendOrderInvoice: async () => ({}),
  calculateRefund: async () => ({}),
  createRefund: async () => ({}),
  getAdminUrl: () => 'https://admin.example/orders/1',
  normalizeGid: (x) => x,
  updateOrderShippingAddress: async () => ({}),
  shopifyGraphQL: async () => ({
    node: {
      id: 'gid://shopify/CalculatedOrder/1',
      originalOrder: {
        id: 'gid://shopify/Order/7350439182614', name: '#32310',
        totalPriceSet: money('403.92'), currentTotalPriceSet: money('403.92'),
      },
      addedLineItems: { edges: [] },
    },
  }),
});
stub(path.join(LIB, 'productCache.js'), { searchProducts: () => [] });
stub(path.join(__dirname, '..', '..', 'reports', 'lib', 'warehanceClient.js'), {
  fetchOrderByNumber: async () => null,
  setWarehouseHold: async () => ({}), releaseWarehouseHold: async () => ({}),
  releaseAddressHold: async () => ({}), getHoldReasons: () => [],
  warehanceOrderUrl: () => '', resolveShippingMethod: async () => null,
  updateShippingMethod: async () => ({}),
});
stub(path.join(LIB, 'addressValidation.js'), { validateShippingAddress: async () => ({ ok: true }) });
stub(path.join(LIB, 'tools', 'shippingLookup.js'), { getShippingZone: async () => null });
stub(path.join(LIB, 'tools', 'adminTools.js'), { writeAuditEntry: async () => ({}) });
stub(path.join(LIB, 'addressUtils.js'), { toCountryCode: (c) => c });

const editOrder = require(path.join(LIB, 'tools', 'editOrder.js'));
const { handleEditOrder, lineItemNumericId } = editOrder;

const reset = () => { state.setQuantityCalls = []; state.addVariantCalls = []; };
const textOf = (res) => res.content.map(c => c.text).join('\n');

const AJ_BLK_M = 'gid://shopify/ProductVariant/46767822373142';

test('lineItemNumericId joins LineItem and CalculatedLineItem gids', () => {
  assert.strictEqual(lineItemNumericId(LINE_BUNDLE), '17874555863318');
  assert.strictEqual(
    lineItemNumericId('gid://shopify/CalculatedLineItem/17874555863318'),
    '17874555863318',
  );
  // A bare numeric id is accepted so an operator can paste either form.
  assert.strictEqual(lineItemNumericId('17874555863318'), '17874555863318');
});

test('lineItemNumericId returns null for empty input so it never matches a real line', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.strictEqual(lineItemNumericId(empty), null);
  }
  // Two absent ids must not be treated as the same line.
  assert.notStrictEqual(lineItemNumericId(null), lineItemNumericId(LINE_BUNDLE));
});

test('ambiguous remove_sku errors and stages nothing', async () => {
  reset();
  const res = await handleEditOrder({
    order_number: '32310',
    swap_items: [{ remove_sku: 'AJ-BLK-L', add_variant_id: AJ_BLK_M }],
  });
  const text = textOf(res);
  assert.match(text, /appears on 2 lines/);
  assert.match(text, /remove_line_item_id/);
  // Both candidate lines are named so the operator can disambiguate without another lookup.
  assert.ok(text.includes(LINE_BUNDLE), 'lists the bundle line');
  assert.ok(text.includes(LINE_FULL), 'lists the full-price line');
  // The old behaviour silently edited the first line; nothing may be staged now.
  assert.deepStrictEqual(state.setQuantityCalls, []);
  assert.deepStrictEqual(state.addVariantCalls, []);
});

test('remove_line_item_id targets the exact line, not the first SKU match', async () => {
  reset();
  const res = await handleEditOrder({
    order_number: '32310',
    swap_items: [{ remove_line_item_id: LINE_FULL, add_variant_id: AJ_BLK_M, even_swap: true }],
  });
  assert.doesNotMatch(textOf(res), /^Error:/m);
  assert.strictEqual(state.setQuantityCalls.length, 1);
  // Zeroing the FULL-price line (qty 2), leaving the bundle line untouched.
  assert.strictEqual(
    state.setQuantityCalls[0].lineId,
    'gid://shopify/CalculatedLineItem/17874556059926',
  );
  assert.strictEqual(state.setQuantityCalls[0].qty, 0);
  assert.strictEqual(state.addVariantCalls[0].quantity, 2);
});

test('both lines of a duplicated SKU can be swapped in one pass', async () => {
  reset();
  const res = await handleEditOrder({
    order_number: '32310',
    swap_items: [
      { remove_line_item_id: LINE_BUNDLE, add_variant_id: AJ_BLK_M, even_swap: true },
      { remove_line_item_id: LINE_FULL, add_variant_id: AJ_BLK_M, even_swap: true },
    ],
  });
  assert.doesNotMatch(textOf(res), /^Error:/m);
  // Two distinct lines zeroed — the defect zeroed one line twice and clamped to 0.
  const zeroed = state.setQuantityCalls.map(c => c.lineId);
  assert.strictEqual(new Set(zeroed).size, 2, 'two distinct lines targeted');
  assert.deepStrictEqual(state.setQuantityCalls.map(c => c.qty), [0, 0]);
  // All 3 units come back: 1 from the bundle line, 2 from the full-price line.
  assert.deepStrictEqual(state.addVariantCalls.map(c => c.quantity), [1, 2]);
});

test('remove_line_item_id contradicting remove_sku is refused', async () => {
  reset();
  const res = await handleEditOrder({
    order_number: '32310',
    swap_items: [{ remove_line_item_id: LINE_UNIQUE, remove_sku: 'AJ-BLK-L', add_variant_id: AJ_BLK_M }],
  });
  assert.match(textOf(res), /Refusing to guess/);
  assert.deepStrictEqual(state.setQuantityCalls, []);
});

test('unambiguous remove_sku still resolves without a line item id', async () => {
  reset();
  const res = await handleEditOrder({
    order_number: '32310',
    swap_items: [{ remove_sku: 'RUBY-BLK-L', add_variant_id: AJ_BLK_M }],
  });
  assert.doesNotMatch(textOf(res), /^Error:/m);
  assert.strictEqual(
    state.setQuantityCalls[0].lineId,
    'gid://shopify/CalculatedLineItem/17874555961622',
  );
});

test('unknown remove_line_item_id errors instead of falling back to SKU', async () => {
  reset();
  const res = await handleEditOrder({
    order_number: '32310',
    swap_items: [{ remove_line_item_id: 'gid://shopify/LineItem/999', remove_sku: 'AJ-BLK-L', add_variant_id: AJ_BLK_M }],
  });
  assert.match(textOf(res), /not found in order/);
  assert.deepStrictEqual(state.setQuantityCalls, []);
});

/**
 * Order-level discount codes are re-applied by Shopify to lines added during an edit.
 * Live miss on #32310 (2026-08-17): every replacement line was priced against the
 * post-code effective price AND then received the 15% code again, leaving the order at
 * $343.34 against $403.92 paid — a $60.58 undercharge across 11 lines.
 */
const { getLineItemDiscountPercent } = editOrder;

const alloc = (typename, amount) => ({
  allocatedAmountSet: { shopMoney: { amount: String(amount), currencyCode: 'USD' } },
  discountApplication: { __typename: typename },
});

test('a discount code is excluded from the replacement-line base; a manual one is not', () => {
  // Sassy L: $32.00 list, 15% code = $27.20 paid. The code returns on its own, so the
  // replacement must be priced off $32.00 — i.e. no even-swap discount at all.
  const codeOnly = {
    quantity: 1,
    originalUnitPriceSet: { shopMoney: { amount: '32.00', currencyCode: 'USD' } },
    discountAllocations: [alloc('DiscountCodeApplication', '4.80')],
  };
  assert.strictEqual(getLineItemDiscountPercent(codeOnly, { excludeReapplied: true }), 0);
  // Without the flag the full 15% is still reported, which is what the preview shows.
  assert.strictEqual(getLineItemDiscountPercent(codeOnly), 15);

  // A manual/bundle line discount does NOT carry over, so it stays in the base.
  const manual = {
    quantity: 1,
    originalUnitPriceSet: { shopMoney: { amount: '32.00', currencyCode: 'USD' } },
    discountAllocations: [alloc('ManualDiscountApplication', '9.60')],
  };
  assert.strictEqual(getLineItemDiscountPercent(manual, { excludeReapplied: true }), 30);
});

test('mixed allocations keep only the discount that will not be re-applied', () => {
  // AJ bundle line as it actually stood on #32310: $22.40 line price, 15% code on top.
  const mixed = {
    quantity: 1,
    originalUnitPriceSet: { shopMoney: { amount: '32.00', currencyCode: 'USD' } },
    discountAllocations: [
      alloc('ManualDiscountApplication', '9.60'),      // bundle price, does not carry over
      alloc('DiscountCodeApplication', '3.36'),        // KL-WELCOME…, comes back by itself
      alloc('AutomaticDiscountApplication', '1.00'),   // also re-applied by Shopify
    ],
  };
  // Only the manual 9.60 of 32.00 survives → 30%, so the replacement is priced off $22.40
  // and the code then brings it to the $19.04 the customer actually paid.
  assert.strictEqual(getLineItemDiscountPercent(mixed, { excludeReapplied: true }), 30);
});
