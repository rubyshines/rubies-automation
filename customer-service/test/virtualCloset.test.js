'use strict';
// Pure logic of the Virtual Closet: money rules, catalog, auth primitives, views.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const money = require('../../virtual-closet/lib/money');
const { MENU, normalizeSize, SIZES } = require('../../virtual-closet/lib/catalog');
const auth = require('../../virtual-closet/lib/auth');
const sponsorship = require('../../virtual-closet/lib/sponsorship');
const closetView = require('../../virtual-closet/views/closet');

test('a request costs half retail per item plus $15 when shipped to a door', () => {
  const items = [{ style: 'aj' }, { style: 'brooke' }];
  assert.equal(money.requestCostCents(items, 'pickup', MENU), 1600 + 2100);
  assert.equal(money.requestCostCents(items, 'ship', MENU), 1600 + 2100 + 1500);
  assert.equal(money.requestCostCents([{ style: 'nope' }], 'pickup', MENU), 0);
});

test('the box goal is the larger of the centre target and the cost of approved requests', () => {
  assert.equal(money.boxGoalCents(30000, [], MENU), 30000);
  assert.equal(money.boxGoalCents(10000, [], MENU), 30000, 'never below the $300 floor');
  const many = Array.from({ length: 12 }, () => ({ items: [{ style: 'ruby' }], delivery: 'ship' })); // 12 × (24 + 15) = 468
  assert.equal(money.boxGoalCents(30000, many, MENU), 46800);
  assert.equal(money.boxGoalCents(50000, many, MENU), 50000);
});

test('raised counts only the money-in kinds, and sources split them', () => {
  const ledger = [
    { kind: 'order_credit', amount_cents: 800 }, { kind: 'sponsor', amount_cents: 1600 }, { kind: 'sponsor', amount_cents: 5000 },
    { kind: 'centre_add', amount_cents: 2000 }, { kind: 'carry_in', amount_cents: 500 },
    { kind: 'match', amount_cents: 9900 }, { kind: 'door_shipping', amount_cents: -1500 }, { kind: 'carry_out', amount_cents: -400 },
  ];
  assert.equal(money.raisedCents(ledger), 9900);
  const s = money.sourcesCents(ledger);
  assert.deepEqual([s.orders, s.sponsors, s.sponsorCount, s.centre, s.carry], [800, 6600, 2, 2000, 500]);
});

test('a community order credits a quarter of its subtotal', () => {
  assert.equal(money.orderCreditCents(3200), 800);
  assert.equal(money.orderCreditCents(2560), 640);
});

test('send totals: match equals raised, door shipping comes off product, remainder carries', () => {
  const t = money.sendTotals({ raised: 30000, shippedRequestCount: 2, placedProductCents: 55000 });
  assert.equal(t.match, 30000);
  assert.equal(t.doorShipping, 3000);
  assert.equal(t.productBudget, 57000);
  assert.equal(t.carryOut, 2000);
  assert.equal(money.sendTotals({ raised: 30000, shippedRequestCount: 0, placedProductCents: 60000 }).carryOut, 0);
});

test('auto-fill never exceeds the budget and favours underwear', () => {
  const plan = money.autoFill({ budgetCents: 30000, sizes: ['S', 'M', 'L'], catalog: MENU });
  const value = money.planValueCents(plan, MENU);
  assert.ok(value <= 30000 && value > 27000, `value ${value}`);
  const underwear = plan.filter(l => ['aj', 'charlie', 'sassy'].includes(l.style)).reduce((n, l) => n + l.qty, 0);
  const other = plan.filter(l => ['brooke', 'ruby'].includes(l.style)).reduce((n, l) => n + l.qty, 0);
  assert.ok(underwear > other);
  assert.deepEqual(money.autoFill({ budgetCents: 0, sizes: ['S'], catalog: MENU }), []);
});

test('dollars formats whole and fractional cents', () => {
  assert.equal(money.dollars(30000), '$300');
  assert.equal(money.dollars(2560), '$25.60');
  assert.equal(money.dollars(0), '$0');
});

test('store sizes normalise: XL is 1X to a customer, kids sizes pass through', () => {
  assert.equal(normalizeSize('XL'), '1X');
  assert.equal(normalizeSize('xxl'), '2X');
  assert.equal(normalizeSize('M'), 'M');
  assert.equal(normalizeSize('10'), '10');
  assert.ok(!SIZES.includes('XL'));
});

test('passwords hash with a fresh salt and verify only the right password', () => {
  const h1 = auth.hashPassword('correct horse');
  const h2 = auth.hashPassword('correct horse');
  assert.notEqual(h1, h2);
  assert.ok(auth.verifyPassword('correct horse', h1));
  assert.ok(!auth.verifyPassword('wrong', h1));
  assert.ok(!auth.verifyPassword('anything', null));
  assert.equal(auth.passwordProblem('short'), 'Use at least 8 characters.');
  assert.equal(auth.passwordProblem('long enough'), null);
});

test('personal email detection and centre domain suggestion', () => {
  assert.ok(auth.isPersonalEmail('jamie.k@gmail.com'));
  assert.ok(auth.isPersonalEmail('x@Outlook.com'));
  assert.ok(!auth.isPersonalEmail('jamie@unitingpride.org'));
  assert.equal(auth.domainOf('https://www.unitingpride.org/about'), 'unitingpride.org');
  assert.equal(auth.domainOf('unitingpride.org'), 'unitingpride.org');
  assert.equal(auth.domainOf(''), null);
});

test('a sponsorship line item is read from either the webhook or the mirror shape', () => {
  const s = { variants: { pair: { id: 'gid://shopify/ProductVariant/111', cents: 1600 }, unit: { id: 'gid://shopify/ProductVariant/222', cents: 100 } } };
  const webhook = sponsorship.readLineItem({ id: 9, variant_id: 111, quantity: 1, price: '16.00', properties: [{ name: 'Closet', value: 'demo' }, { name: 'Box', value: '2' }, { name: 'Kind', value: 'sponsor' }] }, s);
  assert.deepEqual(webhook, { slug: 'demo', boxNumber: 2, kind: 'sponsor', amountCents: 1600, lineItemId: '9' });
  const mirror = sponsorship.readLineItem({ shopify_line_item_id: 'gid://shopify/LineItem/10', shopify_variant_id: 'gid://shopify/ProductVariant/222', quantity: 50, unit_price: 1, custom_attributes: [{ key: 'Closet', value: 'demo' }, { key: 'Kind', value: 'centre' }] }, s);
  assert.deepEqual(mirror, { slug: 'demo', boxNumber: null, kind: 'centre_add', amountCents: 5000, lineItemId: '10' });
  assert.equal(sponsorship.readLineItem({ variant_id: 999 }, s), null);
});

test('the closet page renders every arrangement and state without leaking undefined', () => {
  const centre = { id: 1, slug: 'demo', name: 'Demo Centre', sizes: SIZES, kids_sizes: false, items_per_request: 2, requests_per_year: 2, goal_cents: 30000, address: { city: 'Champaign' } };
  const base = { number: 2, raised: 14000, goal: 30000, funded: false, over: 0, sources: money.sourcesCents([{ kind: 'sponsor', amount_cents: 14000 }]), requests: [], approvedCount: 0, waitingCount: 0, ledger: [] };
  for (const state of ['empty', 'in_progress', 'grown', 'funded', 'over']) {
    for (const lead of ['default', 'shop', 'request', 'sponsor']) {
      const html = closetView.render({ centre, sum: { ...base, state, box: { number: 2 } }, lastSent: null, products: MENU, lead, words: [], paused: state === 'over' });
      assert.ok(!/undefined|NaN|\[object/.test(html), `${lead}/${state} leaked`);
      assert.ok(html.includes("Demo Centre's closet"));
    }
  }
  const paused = closetView.render({ centre, sum: { ...base, state: 'in_progress', box: { number: 2 } }, lastSent: null, products: MENU, lead: 'request', words: [], paused: true });
  assert.ok(paused.includes('Requests are paused at Demo Centre'));
});
