/**
 * edit_order — a same-price swap must not invoice the customer for Shopify's
 * discount re-allocation.
 *
 * Live defect on #32993 (2026-08-25): a $32 Sassy Black 1X → $32 Sassy Black L
 * size swap. Shopify re-spread the order's WELCOME10 code over the lines the edit
 * left behind, cutting the discount from $15.60 to $12.40, so the committed order
 * carried a $3.20 balance against what the customer had paid. Phase 2 invoiced any
 * positive delta unconditionally, so the customer was emailed an invoice for a
 * like-for-like size change and paid it before anyone saw the ticket.
 *
 * The gate is the INTENDED delta — value added minus value removed at list price.
 * Zero on a swap, positive on a genuine addition. Only a balance the operator's
 * edit never asked for is absorbed.
 *
 * Stubbing follows the editOrderDuplicateSku.test.js pattern: seed require.cache
 * before requiring the module under test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };

const money = (amount) => ({ shopMoney: { amount, currencyCode: 'USD' } });

const LINE_SASSY_BLK = 'gid://shopify/LineItem/17900000000001';
const SASSY_BLK_L = 'gid://shopify/ProductVariant/50068403978518';
const PADS_L = 'gid://shopify/ProductVariant/48942604386582';

const orderLineItems = () => ([
  {
    id: LINE_SASSY_BLK, sku: 'HLA-BLK-XL', title: 'SASSY NO-TUCK SHAPING UNDERWEAR',
    variantTitle: 'Black / 1X', quantity: 1,
    originalUnitPriceSet: money('32.00'),
    discountAllocations: [{ allocatedAmountSet: money('3.20') }],
    variant: { id: 'gid://shopify/ProductVariant/50068404011286' },
  },
]);

const calcLineItems = () => orderLineItems().map(li => ({
  id: li.id.replace('LineItem', 'CalculatedLineItem'),
  sku: li.sku, title: li.title, variantTitle: li.variantTitle,
  quantity: li.quantity, variant: li.variant, calculatedDiscountAllocations: [],
}));

// Phase 2 settles `currentTotalPriceSet - netPaymentSet`. These are the real
// #32993 figures: the customer paid $140.40, the edited order totals $143.60.
// editOrder.js destructures its shopify imports at require time, so a test cannot
// swap a stub out afterwards — the per-test variation has to live in state the
// stub reads on every call.
const state = {
  invoicesSent: 0,
  refundsCreated: [],
  addPrice: '32.00',
  committedCurrentTotal: '143.60',
  suggestedRefund: null,
};

stub(path.join(LIB, 'shopify.js'), {
  getOrderForEdit: async () => ({
    id: 'gid://shopify/Order/7448467472662',
    name: '#32993',
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    cancelledAt: null,
    customer: { email: 'buyer@example.com' },
    shippingAddress: { countryCodeV2: 'US' },
    shippingLines: [{ title: 'Free US Standard Shipping' }],
    totalPriceSet: money('172.40'),
    currentTotalPriceSet: money('140.40'),
    netPaymentSet: money('140.40'),
    lineItems: orderLineItems(),
  }),
  orderEditBegin: async () => ({ id: 'gid://shopify/CalculatedOrder/1', lineItems: calcLineItems() }),
  orderEditSetQuantity: async () => ({}),
  orderEditAddVariant: async (_calcId, variantId, quantity) => ({
    calculatedLineItem: {
      id: 'gid://shopify/CalculatedLineItem/added-1',
      title: variantId === PADS_L ? 'MAGICAL SHAPING GEL CHEST PADS' : 'SASSY NO-TUCK SHAPING UNDERWEAR',
      variantTitle: variantId === PADS_L ? 'L' : 'Black / L',
      quantity,
      originalUnitPriceSet: money(state.addPrice),
      calculatedDiscountAllocations: [],
    },
  }),
  orderEditAddLineItemDiscount: async () => ({}),
  // The committed order is where the re-allocated discount shows up: the customer
  // paid $140.40 and the edited order now totals $143.60.
  orderEditCommit: async () => ({
    id: 'gid://shopify/Order/7448467472662',
    name: '#32993',
    totalPriceSet: money('172.40'),
    currentTotalPriceSet: money(state.committedCurrentTotal),
    netPaymentSet: money('140.40'),
  }),
  sendOrderInvoice: async () => { state.invoicesSent++; return {}; },
  calculateRefund: async () => ({}),
  createRefund: async (args) => { state.refundsCreated.push(args); return {}; },
  getAdminUrl: () => 'https://admin.example/orders/1',
  normalizeGid: (x) => x,
  updateOrderShippingAddress: async () => ({}),
  // Serves both the Phase 1 calculated-order read and the Phase 2 suggestedRefund
  // query; the caller picks the key it needs off the result.
  shopifyGraphQL: async () => ({
    node: {
      id: 'gid://shopify/CalculatedOrder/1',
      subtotalPriceSet: money('143.60'),
      totalPriceSet: money('143.60'),
      originalOrder: {
        id: 'gid://shopify/Order/7448467472662', name: '#32993',
        totalPriceSet: money('172.40'),
        currentTotalPriceSet: money('140.40'),
        netPaymentSet: money('140.40'),
      },
      addedLineItems: { edges: [] },
    },
    order: { suggestedRefund: state.suggestedRefund },
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

const { handleEditOrder } = require(path.join(LIB, 'tools', 'editOrder.js'));

const textOf = (res) => res.content.map(c => c.text).join('\n');
const reset = () => {
  state.invoicesSent = 0;
  state.refundsCreated = [];
  state.addPrice = '32.00';
  state.committedCurrentTotal = '143.60';
  state.suggestedRefund = null;
};

test('#32993: a same-price size swap absorbs the re-allocated discount instead of invoicing', async () => {
  reset();
  const phase1 = await handleEditOrder({
    order_number: '32993',
    swap_items: [{ remove_line_item_id: LINE_SASSY_BLK, add_variant_id: SASSY_BLK_L }],
  });
  assert.doesNotMatch(textOf(phase1), /^Error:/m, 'phase 1 stages cleanly');

  const phase2 = await handleEditOrder({ order_number: '32993', confirmed: true });
  const text = textOf(phase2);

  // The whole point: the customer is not billed for a size change.
  assert.strictEqual(state.invoicesSent, 0, 'no invoice may be sent on an even swap');
  assert.match(text, /Balance absorbed:\*\* \$3\.20/);
  assert.match(text, /NOT invoiced/);
  // The operator still has to be told the money exists, or absorbing it silently
  // just moves the surprise to the payout.
  assert.match(text, /discount code/i);
  assert.doesNotMatch(text, /Customer owes/);
});

test('a genuine addition still invoices — the gate is intent, not the sign of the delta', async () => {
  reset();
  state.addPrice = '27.00';
  const phase1 = await handleEditOrder({
    order_number: '32993',
    swap_items: [{ add_variant_id: PADS_L, add_quantity: 1 }],
  });
  assert.doesNotMatch(textOf(phase1), /^Error:/m);

  const phase2 = await handleEditOrder({ order_number: '32993', confirmed: true });
  const text = textOf(phase2);

  // Value really was added, so the balance is owed and the invoice must go.
  assert.strictEqual(state.invoicesSent, 1, 'an add-only edit still invoices');
  assert.match(text, /Customer owes:\*\* \$3\.20/);
  assert.doesNotMatch(text, /Balance absorbed/);
});

test('money owed BACK to the customer still refunds — the absorb branch never swallows a refund', async () => {
  reset();
  // Swap down to a cheaper item: intended delta is negative, so is Shopify's, and
  // the committed order totals LESS than what was paid.
  state.addPrice = '20.00';
  state.committedCurrentTotal = '128.40';
  state.suggestedRefund = {
    amountSet: money('12.00'),
    suggestedTransactions: [{
      gateway: 'shopify_payments',
      parentTransaction: { id: 'gid://shopify/OrderTransaction/1' },
      amountSet: { shopMoney: { amount: '12.00', currencyCode: 'USD' }, presentmentMoney: { amount: '12.00', currencyCode: 'USD' } },
    }],
  };

  const phase1 = await handleEditOrder({
    order_number: '32993',
    swap_items: [{ remove_line_item_id: LINE_SASSY_BLK, add_variant_id: SASSY_BLK_L }],
  });
  assert.doesNotMatch(textOf(phase1), /^Error:/m);

  const text = textOf(await handleEditOrder({ order_number: '32993', confirmed: true }));
  assert.strictEqual(state.invoicesSent, 0);
  assert.strictEqual(state.refundsCreated.length, 1, 'the refund branch is untouched by the absorb gate');
  assert.match(text, /Refund:\*\* \$12\.00/);
});
