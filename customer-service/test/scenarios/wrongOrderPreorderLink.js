/**
 * Wrong-order pre-order linking scenario (ticket 2700 / CS draft 2754).
 *
 * Incident: customer with two orders wrote "I'd like to keep my pre order,
 * but could I swap it for a small instead please?" with no order number.
 * Auto-linking loaded the MOST RECENT order (fulfilled chest pads) instead of
 * the older unfulfilled order carrying the Pre-order line attribute. The
 * advisor read "swap it" as pads M→S. After an operator steer redirected it
 * to the right order, it still invented that order's composition ("your
 * pre-order stays as is" — there was no separate pre-order line).
 *
 * Fixes under test:
 *   1. Order context now includes the customer's OTHER orders + a rule to
 *      match pre-order cues against them instead of acting on the loaded one.
 *   2. New structured field action_order_number carries the action's true
 *      target (consumed by the intake auto-hold + backstop sweep).
 *   3. Steer block + anti-hallucination rule 10: load an order before
 *      describing its contents.
 *
 * Round 1 (no steer) asserts:
 *   - no CONFIRMED pads exchange is staged
 *   - the advisor either targets the pre-order order (action_order_number)
 *     or asks/needs info — never acts on the pads order
 * Round 2 (operator steer to the other order) asserts:
 *   - action_order_number names the steered order (NOT the loaded one)
 *   - action_type is warehouse_hold (unfulfilled item modify)
 *
 * Fully synthetic preContext — order-independent, no live-order drift.
 * Usage: node customer-service/test/scenarios/wrongOrderPreorderLink.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

const LOADED_ORDER = '#90102';   // most recent: fulfilled chest pads
const PREORDER_ORDER = '#90101'; // older: unfulfilled Sassy, Pre-order line

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

const money = (amount) => ({ shopMoney: { amount, currencyCode: 'USD' } });

const padsLineItem = {
  title: 'RUBIES SHAPING CHEST PADS',
  variantTitle: 'Black / M',
  quantity: 1,
  sku: 'PAD3-BLK-M',
  currentQuantity: 1,
  originalUnitPriceSet: money('34.00'),
  customAttributes: [],
};

const sassyLineItem = {
  title: 'SASSY NO-TUCK SHAPING UNDERWEAR',
  variantTitle: 'Black / M',
  quantity: 1,
  sku: 'HLA-BLK-M',
  currentQuantity: 1,
  originalUnitPriceSet: money('26.00'),
  customAttributes: [{ key: 'Pre-order', value: 'Target availability end of next month.' }],
};

const shippingAddress = {
  address1: '99 Test Lane', city: 'Portland', province: 'Oregon', provinceCode: 'OR',
  zip: '97201', country: 'United States', countryCodeV2: 'US',
};

const loadedOrder = {
  name: LOADED_ORDER,
  createdAt: new Date(Date.now() - 12 * 86400000).toISOString(),
  cancelledAt: null,
  displayFulfillmentStatus: 'FULFILLED',
  displayFinancialStatus: 'PAID',
  totalPriceSet: money('34.00'),
  subtotalPriceSet: money('34.00'),
  totalDiscountsSet: money('0.00'),
  totalShippingPriceSet: money('0.00'),
  totalTaxSet: money('0.00'),
  totalRefundedSet: money('0.00'),
  shippingAddress,
  lineItems: [padsLineItem],
};

const preorderOrder = {
  name: PREORDER_ORDER,
  createdAt: new Date(Date.now() - 13 * 86400000).toISOString(),
  cancelledAt: null,
  displayFulfillmentStatus: 'UNFULFILLED',
  displayFinancialStatus: 'PAID',
  totalPriceSet: money('26.00'),
  shippingAddress,
  lineItems: [sassyLineItem],
};

const preContext = {
  customer: {
    email: 'scenario-preorder-link@example.com',
    firstName: null,
    defaultAddress: { ...shippingAddress, country: 'United States' },
  },
  customerGid: null,
  customerCountry: 'US',
  isNorthAmerica: true,
  orders: [loadedOrder, preorderOrder],
  fulfilled: [loadedOrder],
  exchanges: [],
  all: [loadedOrder, preorderOrder],
  targetOrder: loadedOrder,
  orderLineItems: [{ ...padsLineItem, _skuSize: 'M', _rawSkuSize: 'M' }],
  effectiveOrderNumber: null,
  resolvedByName: false,
  conversationEmail: null,
  priorTicket: null,
};

const MESSAGE = "Hi!\n\nI'd like to keep my pre order, but could I swap it for a small instead please? Thank you!";

(async () => {
  console.log('Round 1: no steer — mis-link detection');
  const r1 = await aiAdvisor({
    customer_email: preContext.customer.email,
    issue_description: MESSAGE,
    preContext,
  });
  const s1 = r1?._structured || {};
  console.log(`  status: ${s1.status} · action_type: ${s1.action_type} · action_order_number: ${s1.action_order_number}`);
  console.log(`  items: ${JSON.stringify(s1.intake?.items?.map(i => i.product) || [])}`);

  const padsConfirmed = (s1.prescription?.items || []).some(
    (i) => /pad/i.test(i.product || '') && (i.state === 'CONFIRMED' || i.state === 'REFUND_CONFIRMED'),
  );
  if (padsConfirmed) fail('staged an exchange/refund on the PADS order — the pre-order cue was ignored');
  else pass('no action staged against the pads (loaded) order');

  const targetsPreorder = String(s1.action_order_number || '') === PREORDER_ORDER.replace('#', '');
  const asks = s1.status === 'needs_info' || s1.status === 'route_to_human' || s1.status === 'gathering';
  if (targetsPreorder) pass(`action targets the pre-order order ${PREORDER_ORDER}`);
  else if (asks) pass(`no wrong-order action; advisor is asking/gathering (status=${s1.status})`);
  else fail(`expected the action to target ${PREORDER_ORDER} or a clarifying question — got status=${s1.status}, action_order_number=${s1.action_order_number}`);

  console.log('\nRound 2: operator steer redirects to the pre-order order');
  const r2 = await aiAdvisor({
    customer_email: preContext.customer.email,
    issue_description: MESSAGE,
    preContext,
    operatorSteer: `Update the sassy to a small on ${PREORDER_ORDER.replace('#', '')}`,
  });
  const s2 = r2?._structured || {};
  console.log(`  status: ${s2.status} · action_type: ${s2.action_type} · action_order_number: ${s2.action_order_number}`);
  console.log(`  operator_action_summary: ${s2.operator_action_summary || '(none)'}`);

  if (String(s2.action_order_number || '') === PREORDER_ORDER.replace('#', '')) {
    pass(`action_order_number carries the steered order ${PREORDER_ORDER} (hold lands on the right order)`);
  } else {
    fail(`action_order_number should be ${PREORDER_ORDER.replace('#', '')}, got ${JSON.stringify(s2.action_order_number)} — the auto-hold would target the loaded ${LOADED_ORDER}`);
  }
  if (s2.action_type === 'warehouse_hold') {
    pass('unfulfilled item modify routed to warehouse_hold');
  } else {
    fail(`expected action_type warehouse_hold for an unshipped item swap, got ${JSON.stringify(s2.action_type)}`);
  }
  const claimsSeparatePreorder = /pre-?order (stays|will stay|remains)|rest of (the|your) order/i.test(r2?._structured?._composedResponse || '');
  if (claimsSeparatePreorder) {
    fail('reply invents order composition (claims a separate pre-order item remains on a single-item order)');
  } else {
    pass('reply does not invent the steered order\'s composition');
  }

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'DONE');
})().catch((e) => { console.error(e); process.exit(1); });
