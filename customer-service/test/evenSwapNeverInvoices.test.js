/**
 * edit_order — a swap declared even never bills the customer.
 *
 * Live failure on #33295 (2026-08-25). An auto-staged pre-order swap (6x AJ Black/M →
 * Black/16) was committed as an even swap on a CAD order. Three things went wrong in
 * sequence and each one is covered here:
 *
 *   1. even_swap applied its cost-neutralising discount as a FIXED AMOUNT denominated in
 *      the shop currency (USD). Shopify applies fixed-amount discounts in the order's
 *      PRESENTMENT currency, so $5.01 USD landed as CAD 5.01 ≈ USD 3.62 and the customer
 *      was left $8.35 short on a swap our email had just told them was free.
 *   2. orderEditCommit ran with Shopify's notifyCustomer defaulting to true, and Shopify's
 *      edit notification IS an invoice when the edit leaves a balance — so the customer was
 *      billed at commit, before any settlement logic ran.
 *   3. Nothing downstream treated "declared even" as a promise, so the settlement branch
 *      was free to invoice (or, on the old delta arithmetic, to attempt a $177.84 refund).
 *
 * Stubbing follows the resolveLineItems.test.js pattern: seed require.cache before
 * requiring the module under test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };

const money = (amount, currencyCode = 'USD') => ({ shopMoney: { amount, currencyCode } });

const LINE_M = 'gid://shopify/LineItem/18122046144790';
const VARIANT_16 = 'gid://shopify/ProductVariant/46767822373142';
const ORDER_ID = 'gid://shopify/Order/7483848917270';

// #33295 as it stood: 6x AJ-BLK-M at $33.21, 15% AJ Volume Discount (an AUTOMATIC
// discount) taking it to $28.22 each. CAD presentment, USD shop.
const orderLineItems = () => ([{
  id: LINE_M,
  sku: 'AJ-BLK-M',
  title: 'AJ NO-TUCK SHAPING UNDERWEAR',
  variantTitle: 'Black / M',
  quantity: 6,
  originalUnitPriceSet: money('33.21'),
  discountAllocations: [{
    allocatedAmountSet: { shopMoney: { amount: '29.89', currencyCode: 'USD' } },
    discountApplication: { __typename: 'AutomaticDiscountApplication', title: '15% AJ Volume Discount' },
  }],
  variant: { id: 'gid://shopify/ProductVariant/39428866441301' },
}]);

const state = {
  discountCalls: [],
  commitCalls: [],
  invoiceCalls: [],
  refundCalls: [],
  // What Shopify says the staged edit totals, against $177.85 already paid.
  stagedTotal: '177.85',
  // What the committed order reports back.
  committedCurrentTotal: '177.85',
  committedNetPayment: '177.85',
};

stub(path.join(LIB, 'shopify.js'), {
  getOrderForEdit: async () => ({
    id: ORDER_ID,
    name: '#33295',
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    cancelledAt: null,
    customer: { email: 'buyer@example.com' },
    shippingAddress: { countryCodeV2: 'CA' },
    shippingLines: [{ title: 'Standard Shipping' }],
    totalPriceSet: money('177.85'),
    currentTotalPriceSet: money('177.85'),
    discountCodes: [],
    discountApplications: [{ __typename: 'AutomaticDiscountApplication', title: '15% AJ Volume Discount' }],
    lineItems: orderLineItems(),
  }),
  orderEditBegin: async () => ({
    id: 'gid://shopify/CalculatedOrder/1',
    lineItems: orderLineItems().map(li => ({
      id: li.id.replace('LineItem', 'CalculatedLineItem'),
      sku: li.sku, quantity: li.quantity, calculatedDiscountAllocations: [],
    })),
  }),
  orderEditSetQuantity: async () => ({}),
  orderEditAddVariant: async (_calcId, _variantId, quantity) => ({
    calculatedLineItem: {
      id: 'gid://shopify/CalculatedLineItem/added-1',
      title: 'AJ NO-TUCK SHAPING UNDERWEAR',
      variantTitle: 'Black / 16',
      quantity,
      originalUnitPriceSet: money('33.24'),
      // Shopify does NOT extend an automatic discount to a line added by an edit —
      // measured live 2026-08-25, both at stage time and on committed orders.
      calculatedDiscountAllocations: [],
    },
  }),
  orderEditAddLineItemDiscount: async (_calcId, lineId, discount) => {
    state.discountCalls.push({ lineId, discount });
    return {};
  },
  orderEditCommit: async (calcId, staffNote, options) => {
    state.commitCalls.push({ calcId, staffNote, options });
    return {
      id: ORDER_ID,
      name: '#33295',
      totalPriceSet: money('364.45'),
      currentTotalPriceSet: money(state.committedCurrentTotal),
      netPaymentSet: money(state.committedNetPayment),
    };
  },
  sendOrderInvoice: async (orderId) => { state.invoiceCalls.push(orderId); return {}; },
  calculateRefund: async () => ({}),
  createRefund: async (input) => { state.refundCalls.push(input); return {}; },
  getAdminUrl: () => 'https://admin.example/orders/1',
  normalizeGid: (x) => x,
  updateOrderShippingAddress: async () => ({}),
  shopifyGraphQL: async (query) => {
    if (/suggestedRefund/.test(query)) {
      return {
        order: {
          suggestedRefund: {
            amountSet: { shopMoney: money('0').shopMoney, presentmentMoney: { amount: '0', currencyCode: 'CAD' } },
            suggestedTransactions: [{
              gateway: 'shopify_payments',
              parentTransaction: { id: 'gid://shopify/OrderTransaction/1' },
              amountSet: { shopMoney: money('8.76').shopMoney, presentmentMoney: { amount: '11.91', currencyCode: 'CAD' } },
            }],
          },
        },
      };
    }
    return {
      node: {
        id: 'gid://shopify/CalculatedOrder/1',
        totalPriceSet: money(state.stagedTotal),
        originalOrder: {
          id: ORDER_ID,
          name: '#33295',
          totalPriceSet: money('177.85'),
          currentTotalPriceSet: money('177.85'),
          netPaymentSet: money('177.85'),
        },
        addedLineItems: { edges: [] },
      },
    };
  },
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
stub(path.join(LIB, 'addressUtils.js'), { toCountryCode: (c) => c, formatAddressBlock: () => '' });

const { handleEditOrder, getLineItemDiscountPercent } = require(path.join(LIB, 'tools', 'editOrder.js'));

const reset = () => {
  state.discountCalls = [];
  state.commitCalls = [];
  state.invoiceCalls = [];
  state.refundCalls = [];
  state.stagedTotal = '177.85';
  state.committedCurrentTotal = '177.85';
  state.committedNetPayment = '177.85';
};
const textOf = (res) => res.content.map(c => c.text).join('\n');
const evenSwap = { remove_line_item_id: LINE_M, add_variant_id: VARIANT_16, even_swap: true };

test('the even-swap discount is a percentage, never a fixed amount', async () => {
  reset();
  await handleEditOrder({ order_number: '33295', swap_items: [evenSwap] });

  assert.strictEqual(state.discountCalls.length, 1);
  const { discount } = state.discountCalls[0];
  // A fixed amount is re-denominated into the order's presentment currency by Shopify;
  // a percentage carries no currency and so cannot be reinterpreted.
  assert.strictEqual(discount.fixedValue, undefined, 'must not send a fixed-amount discount');
  assert.ok(discount.percentValue > 0, 'sends a percentage');
  // $33.21 less the 15% automatic discount = $28.2285 effective; the $33.24 replacement
  // must land on the same figure.
  const effective = 33.24 * (1 - discount.percentValue / 100);
  assert.ok(Math.abs(effective - 28.2285) < 0.005, `replacement priced at ${effective}`);
});

test('an automatic discount stays in the replacement-line base', () => {
  // Shopify re-applies order-level CODES to lines added by an edit, but not automatic
  // discounts. Excluding an automatic discount here priced the replacement against the
  // undiscounted price, leaving the customer short the whole sale percentage.
  const line = {
    quantity: 1,
    originalUnitPriceSet: { shopMoney: { amount: '33.21', currencyCode: 'USD' } },
    discountAllocations: [{
      allocatedAmountSet: { shopMoney: { amount: '4.98', currencyCode: 'USD' } },
      discountApplication: { __typename: 'AutomaticDiscountApplication' },
    }],
  };
  assert.strictEqual(getLineItemDiscountPercent(line, { excludeReapplied: true }), 15);
});

test('Phase 1 refuses to stage an even swap that does not price to zero', async () => {
  reset();
  // Stage a good edit first, so the refusal below has to clear the slot rather than leave
  // an earlier Phase 1 sitting in it — pendingEdits is keyed by order number, and a
  // `confirmed: true` after a refusal must not commit whatever was staged before it.
  await handleEditOrder({ order_number: '33295', swap_items: [evenSwap] });

  // What #33295 actually staged: $186.61 against $177.85 paid.
  state.stagedTotal = '186.61';

  const res = await handleEditOrder({ order_number: '33295', swap_items: [evenSwap] });
  const text = textOf(res);
  assert.match(text, /NOT AN EVEN SWAP/);
  assert.match(text, /8\.76/);
  assert.strictEqual(state.commitCalls.length, 0, 'nothing committed');

  // And Phase 2 is unreachable for it — no pending edit was stored.
  const confirm = await handleEditOrder({ order_number: '33295', confirmed: true });
  assert.match(textOf(confirm), /No pending edit found/);
  assert.strictEqual(state.invoiceCalls.length, 0);
});

test('a residual balance found only at commit is reported, never invoiced or refunded', async () => {
  reset();
  // Prices to zero when staged, so Phase 1 lets it through...
  const staged = await handleEditOrder({ order_number: '33295', swap_items: [evenSwap] });
  assert.doesNotMatch(textOf(staged), /NOT AN EVEN SWAP/);

  // ...and only the committed totals reveal the gap (tax recalculation, or a discount code
  // Shopify allocates on commit).
  state.committedCurrentTotal = '186.61';
  const res = await handleEditOrder({ order_number: '33295', confirmed: true });
  const text = textOf(res);

  assert.strictEqual(state.commitCalls.length, 1, 'the edit itself still commits');
  assert.match(text, /NOT AN EVEN SWAP/);
  assert.match(text, /8\.76/);
  assert.strictEqual(state.invoiceCalls.length, 0, 'no invoice on a swap declared even');
  assert.strictEqual(state.refundCalls.length, 0, 'and no money pushed out either');
});

test('an even swap overpaid at commit is reported rather than auto-refunded', async () => {
  reset();
  await handleEditOrder({ order_number: '33295', swap_items: [evenSwap] });
  state.committedCurrentTotal = '0.01'; // the shape of the old -$177.84 refund attempt
  const text = textOf(await handleEditOrder({ order_number: '33295', confirmed: true }));

  assert.match(text, /NOT AN EVEN SWAP/);
  assert.strictEqual(state.refundCalls.length, 0, 'no refund on arithmetic we already distrust');
  assert.strictEqual(state.invoiceCalls.length, 0);
});

test('an ordinary swap still settles normally', async () => {
  reset();
  // Control arm: the guard must not disarm settlement on edits nobody called even.
  state.stagedTotal = '186.61';
  const staged = await handleEditOrder({
    order_number: '33295',
    swap_items: [{ remove_line_item_id: LINE_M, add_variant_id: VARIANT_16 }],
  });
  assert.doesNotMatch(textOf(staged), /NOT AN EVEN SWAP/);

  state.committedCurrentTotal = '186.61';
  const text = textOf(await handleEditOrder({ order_number: '33295', confirmed: true }));
  assert.match(text, /Invoice:\*\* Sent to customer/);
  assert.strictEqual(state.invoiceCalls.length, 1);
});

test('the commit never lets Shopify mail the customer', async () => {
  reset();
  await handleEditOrder({ order_number: '33295', swap_items: [evenSwap] });
  await handleEditOrder({ order_number: '33295', confirmed: true });

  assert.strictEqual(state.commitCalls.length, 1);
  // Shopify's edit notification is an invoice when the edit leaves a balance, and it goes
  // out at commit — ahead of every check below it.
  assert.strictEqual(state.commitCalls[0].options?.notifyCustomer, false);
});
