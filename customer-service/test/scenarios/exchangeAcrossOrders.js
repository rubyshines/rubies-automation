/**
 * One replacement order per request, not per original order (ticket 3259).
 *
 * Incident: a customer wrote asking to exchange two AJs — a Small bought on one
 * order and a Medium bought on another — both for a Large. The advisor staged
 * the work as TWO exchanges:
 *
 *   prose:   "one against order #32573 and one against #32879"
 *   summary: "exchange on order #32573: 1x AJ S→L Black;
 *             exchange on order #32879: 1x AJ M→L Black; both straight swaps"
 *
 * The operator agent executes exactly what operator_action_summary describes,
 * so it made two create_exchange_order calls and two draft orders — two boxes
 * shipped for one customer request.
 *
 * This was NOT the model disobeying. The only "one order" rule in the prompt
 * was "Exchange + new purchases together: one combined order", scoped to an
 * exchange plus ADDED purchases. Nothing said that exchanges drawn from several
 * original orders consolidate. `original_order_id` on create_exchange_order is
 * a back-link (it sets the link and the ship-to address) and never restricted
 * what could go on the draft, so one-order-per-source was a prompt gap, not a
 * tool limitation.
 *
 * Rules under test (advisor prompt "### Exchanges — Money"; operator agent
 * "How to Execute Actions"; create_exchange_order tool description):
 *   - one exchange order covering every replacement item
 *   - operator_action_summary names both source orders so the operator agent
 *     can note them on the single draft
 *   - the prose does not describe the exchange as two orders
 *
 * Fully synthetic preContext — order-independent, no live-order drift (the
 * failure mode that left both warehouse_hold scenarios dead in 2026-08).
 *
 * Usage: node customer-service/test/scenarios/exchangeAcrossOrders.js
 */
require('dotenv').config();
const { aiAdvisor } = require('../../lib/aiAdvisor');

const ORDER_A = '#90201'; // older: AJ Black S
const ORDER_B = '#90202'; // newer: AJ Black M

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ✓ ' + msg); }

const money = (amount) => ({ shopMoney: { amount, currencyCode: 'USD' } });

const shippingAddress = {
  address1: '9921 Test Avenue', city: 'Redford', province: 'Michigan', provinceCode: 'MI',
  zip: '48239', country: 'United States', countryCodeV2: 'US',
};

const ajLine = (size, sku) => ({
  title: 'AJ NO-TUCK SHAPING UNDERWEAR',
  variantTitle: `Black / ${size}`,
  quantity: 1,
  sku,
  currentQuantity: 1,
  originalUnitPriceSet: money('32.00'),
  customAttributes: [],
});

const fulfilledOrder = (name, daysAgo, lineItem) => ({
  name,
  createdAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  cancelledAt: null,
  displayFulfillmentStatus: 'FULFILLED',
  displayFinancialStatus: 'PAID',
  totalPriceSet: money('42.50'),
  subtotalPriceSet: money('32.00'),
  totalDiscountsSet: money('0.00'),
  totalShippingPriceSet: money('10.50'),
  totalTaxSet: money('0.00'),
  totalRefundedSet: money('0.00'),
  shippingAddress,
  lineItems: [lineItem],
});

const smallLine = ajLine('S', 'AJ-BLK-S');
const mediumLine = ajLine('M', 'AJ-BLK-M');
const orderA = fulfilledOrder(ORDER_A, 29, smallLine);
const orderB = fulfilledOrder(ORDER_B, 21, mediumLine);

const preContext = {
  customer: {
    email: 'scenario-exchange-across-orders@example.com',
    firstName: null,
    defaultAddress: { ...shippingAddress, country: 'United States' },
  },
  customerGid: null,
  customerCountry: 'US',
  isNorthAmerica: true,
  orders: [orderB, orderA],
  fulfilled: [orderB, orderA],
  exchanges: [],
  all: [orderB, orderA],
  targetOrder: orderA,
  orderLineItems: [{ ...smallLine, _skuSize: 'S', _rawSkuSize: 'S' }],
  effectiveOrderNumber: ORDER_A.replace('#', ''),
  resolvedByName: false,
  conversationEmail: null,
  priorTicket: null,
};

const MESSAGE = `Hello, I'm looking to exchange two pairs of underwear that I ordered that don't fit properly, they're both too small and I didn't realize that Rubies measured the waist just under the belly button, I'm used to waist measurements being taken higher up.

They are, respectively, a Small and Medium AJ No-Tuck Shaping, orders ${ORDER_A} and ${ORDER_B}.

I'd like to exchange both for a Large AJ.`;

// The observed failure shape: one "exchange ... on <order>" clause per source
// order. A single clause is fine ("one exchange order covering items on
// #90201 and #90202"); two or more is the split that ships two boxes.
const PER_ORDER_CLAUSE_RE = /(exchange|swap)[^.;\n]{0,30}\bon\b[^.;\n]{0,15}(order\s*)?#?\d{4,}/gi;

// Prose that tells the customer their one request became two shipments.
const TWO_ORDERS_PROSE_RE =
  /\bone against\b|\btwo (separate )?(orders|exchanges|shipments)\b|\bseparate (order|exchange|shipment)\b|\beach order\b/i;

(async () => {
  console.log('=== exchange spanning two original orders ===\n');

  const r = await aiAdvisor({
    customer_email: preContext.customer.email,
    issue_description: MESSAGE,
    preContext,
  });
  const s = r?._structured || {};
  const draft = (s._composedResponse || '').trim();
  const summary = s.operator_action_summary || '';
  const items = s.prescription?.items || [];

  console.log('draft:\n---\n' + draft + '\n---');
  console.log('operator_action_summary: ' + (summary || '(none)'));
  console.log(`status: ${s.status} · action_type: ${s.action_type}\n`);

  const confirmed = items.filter((i) => i.state === 'CONFIRMED');
  if (confirmed.length >= 2) pass(`both garments staged as confirmed exchanges (${confirmed.length} items)`);
  else fail(`expected 2 CONFIRMED exchange items, got ${confirmed.length} — ${JSON.stringify(items.map(i => ({ product: i.product, state: i.state })))}`);

  if (!summary) {
    fail('no operator_action_summary — the operator agent has nothing to execute');
  } else {
    const namesA = summary.includes(ORDER_A.replace('#', ''));
    const namesB = summary.includes(ORDER_B.replace('#', ''));
    if (namesA && namesB) pass('operator_action_summary names both source orders');
    else fail(`operator_action_summary drops a source order (A:${namesA} B:${namesB}): "${summary}"`);

    const clauses = summary.match(PER_ORDER_CLAUSE_RE) || [];
    if (clauses.length <= 1) pass('operator_action_summary describes a single exchange order');
    else fail(`operator_action_summary splits into one exchange per original order — the operator agent will create ${clauses.length} draft orders: ${JSON.stringify(clauses)}`);
  }

  if (!TWO_ORDERS_PROSE_RE.test(draft)) pass('draft does not tell the customer it is two orders');
  else fail(`draft describes the exchange as separate orders: "${draft.match(TWO_ORDERS_PROSE_RE)[0]}"`);

  console.log('');
  console.log(process.exitCode === 1 ? 'FAILED — see assertions above.' : 'DONE');
})().catch((e) => { console.error(e); process.exit(1); });
