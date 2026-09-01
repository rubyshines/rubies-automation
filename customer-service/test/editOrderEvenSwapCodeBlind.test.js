/**
 * edit_order — even swap on an order carrying an order-level discount code.
 *
 * Live miss on #32679 (2026-09-01): the code SM-… allocated ~$4.08 to each line, and
 * Shopify only re-applies a code to lines added by an edit AT COMMIT — so the staged
 * preview always shows a phantom residual on a code-discounted order. Phase 1 has an
 * exception for exactly this (`estimateBlindToCode`: the refusal stands down and Phase
 * 2's no-money-movement rule covers settlement), but it detects codes by
 * `da.__typename` on `order.discountApplications`, and the getOrderForEdit GraphQL
 * query never requested `__typename` there. GraphQL only returns the meta field when
 * asked, so the filter matched nothing, the exception was unreachable from the day it
 * shipped, and every even swap on a code-discounted order was refused with a phantom
 * residual equal to the code's per-line allocation.
 *
 * Two layers of cover, because the defect lived in the QUERY while the branch it fed
 * was correct-but-dead:
 *  1. a source assertion that getOrderForEdit requests __typename in the order-level
 *     discountApplications selection (this is the test that fails on the regression);
 *  2. behavioral cover for the blind-estimate branch itself, which no test had ever
 *     exercised — a guard that can never pass is indistinguishable from one doing its
 *     job, which is what kept this invisible.
 *
 * Stubbing follows the resolveLineItems.test.js pattern: seed require.cache before
 * requiring the module under test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };

const money = (amount) => ({ shopMoney: { amount, currencyCode: 'USD' } });

test('getOrderForEdit requests __typename on the order-level discountApplications', () => {
  const src = fs.readFileSync(path.join(LIB, 'shopify.js'), 'utf8');
  const fnStart = src.indexOf('async function getOrderForEdit');
  assert.ok(fnStart > -1, 'getOrderForEdit exists');
  const fnEnd = src.indexOf('async function', fnStart + 1);
  const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);

  const daStart = fn.indexOf('discountApplications');
  assert.ok(daStart > -1, 'query selects discountApplications');
  // The order-level selection ends where the lineItems selection begins.
  const daBlock = fn.slice(daStart, fn.indexOf('lineItems', daStart));
  assert.match(
    daBlock,
    /__typename/,
    'order-level discountApplications must request __typename — editOrder\'s ' +
    'reapplyingCodes filter keys on it, and without it the even-swap refusal fires ' +
    'on the phantom residual a re-applying code always leaves in the staged preview',
  );
});

// ---------------------------------------------------------------------------
// Behavioral: the blind-estimate branch, on the live #32679 numbers.
// ---------------------------------------------------------------------------

const PINK_LINE = 'gid://shopify/LineItem/17900000000001';
const BLACK_VARIANT = 'gid://shopify/ProductVariant/50068403912982';

const state = { discountApplications: [] };

const orderLineItems = () => ([
  {
    id: PINK_LINE, sku: 'HLA-PNK-S', title: 'SASSY NO-TUCK SHAPING UNDERWEAR',
    variantTitle: 'Pink / S', quantity: 1,
    originalUnitPriceSet: money('36.38'),
    // The code's allocation on this line — excluded from the replacement base
    // (Shopify puts the code back by itself), so the even-swap discount prices
    // the added line at the pre-code 36.38.
    discountAllocations: state.discountApplications.length
      ? [{
          allocatedAmountSet: money('4.08'),
          discountApplication: { __typename: 'DiscountCodeApplication', code: 'SM-TEST123' },
        }]
      : [],
    variant: { id: 'gid://shopify/ProductVariant/50068411253014' },
  },
]);

stub(path.join(LIB, 'shopify.js'), {
  getOrderForEdit: async (orderNumber) => ({
    id: 'gid://shopify/Order/7413398536470',
    name: `#${orderNumber}`,
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    cancelledAt: null,
    customer: { email: 'buyer@example.com' },
    shippingAddress: { countryCodeV2: 'ES' },
    shippingLines: [{ title: 'Free Standard Shipping' }],
    totalPriceSet: money('161.50'),
    currentTotalPriceSet: money('161.50'),
    discountApplications: state.discountApplications,
    lineItems: orderLineItems(),
  }),
  orderEditBegin: async () => ({
    id: 'gid://shopify/CalculatedOrder/1',
    lineItems: orderLineItems().map(li => ({
      id: li.id.replace('LineItem', 'CalculatedLineItem'),
      sku: li.sku, title: li.title, variantTitle: li.variantTitle,
      quantity: li.quantity, variant: li.variant, calculatedDiscountAllocations: [],
    })),
  }),
  orderEditSetQuantity: async () => ({}),
  orderEditAddVariant: async (_calcId, _variantId, quantity) => ({
    calculatedLineItem: {
      id: 'gid://shopify/CalculatedLineItem/added-1',
      title: 'SASSY NO-TUCK SHAPING UNDERWEAR', variantTitle: 'Black / S',
      quantity, originalUnitPriceSet: money('37.04'), calculatedDiscountAllocations: [],
    },
  }),
  orderEditAddLineItemDiscount: async () => ({}),
  orderEditCommit: async () => ({}),
  sendOrderInvoice: async () => ({}),
  calculateRefund: async () => ({}),
  createRefund: async () => ({}),
  getAdminUrl: () => 'https://admin.example/orders/1',
  normalizeGid: (x) => x,
  updateOrderShippingAddress: async () => ({}),
  // The staged state Shopify reports before commit: the added Black S sits at its
  // even-swap price of 36.38, but the code's ~4.10 allocation on it only appears at
  // commit — so the staged total runs exactly that far ahead of what was paid.
  shopifyGraphQL: async () => ({
    node: {
      id: 'gid://shopify/CalculatedOrder/1',
      totalPriceSet: money('165.60'),
      originalOrder: {
        id: 'gid://shopify/Order/7413398536470', name: '#32679',
        netPaymentSet: money('161.50'),
        totalPriceSet: money('161.50'), currentTotalPriceSet: money('161.50'),
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

const { handleEditOrder } = require(path.join(LIB, 'tools', 'editOrder.js'));
const textOf = (res) => res.content.map(c => c.text).join('\n');

const SWAP = { remove_sku: 'HLA-PNK-S', add_variant_id: BLACK_VARIANT, even_swap: true };

test('even swap stages despite the phantom residual when a re-applying code is present', async () => {
  state.discountApplications = [{
    __typename: 'DiscountCodeApplication', code: 'SM-TEST123',
    allocationMethod: 'ACROSS', targetType: 'LINE_ITEM',
    value: { percentage: 11.2 },
  }];
  const res = await handleEditOrder({ order_number: '32679', swap_items: [SWAP] });
  const text = textOf(res);
  assert.doesNotMatch(text, /refusing to stage/i);
  assert.match(text, /To confirm, call edit_order again/, 'edit is staged for Phase 2');
  // The estimate is knowingly blind — say so, naming the code, instead of presenting
  // a confident wrong number the operator would act on.
  assert.match(text, /Estimate excludes SM-TEST123/);
  // Declared even, so whatever the estimate says, no invoice may be threatened.
  assert.doesNotMatch(text, /Invoice will be sent/);
});

test('without a code the same residual still refuses to stage the even swap', async () => {
  state.discountApplications = [];
  const res = await handleEditOrder({ order_number: '32680', swap_items: [SWAP] });
  const text = textOf(res);
  assert.match(text, /NOT AN EVEN SWAP — refusing to stage/);
  assert.doesNotMatch(text, /To confirm, call edit_order again/);
  // The refusal also cleared any staged slot: a follow-up confirm must find nothing.
  const confirm = await handleEditOrder({ order_number: '32680', confirmed: true });
  assert.match(textOf(confirm), /No pending edit found/);
});
