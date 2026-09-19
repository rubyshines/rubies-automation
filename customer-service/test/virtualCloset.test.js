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
  const attrs = sponsorship.readOrderAttributes({ note_attributes: [{ name: 'Closet', value: 'demo' }, { name: 'Box', value: '3' }, { name: 'Kind', value: 'centre' }] });
  assert.deepEqual(attrs, { slug: 'demo', boxNumber: 3, kind: 'centre_add' });
  const viaOrder = sponsorship.readLineItem({ id: 11, variant_id: 222, quantity: 40, price: '1.00' }, s, attrs);
  assert.deepEqual(viaOrder, { slug: 'demo', boxNumber: 3, kind: 'centre_add', amountCents: 4000, lineItemId: '11' });
  const cartUrl = 'https://rubyshines.com/cart/222:40?attributes%5BCloset%5D=demo&attributes%5BBox%5D=3&attributes%5BKind%5D=centre';
  assert.ok(cartUrl.includes('/cart/222:40'));
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

test('each style carries its own size run, cut to what the centre offers, and maps to the shelf size', () => {
  const { sizesFor, storeSize, styleSizes } = require('../../virtual-closet/lib/catalog');
  assert.ok(!styleSizes('aj').includes('4X'), 'AJ stops at 3X');
  assert.ok(styleSizes('sassy').includes('4X') && !styleSizes('sassy').includes('12'), 'Sassy runs in letters only');
  const centre = { sizes: ['S', 'M', '1X', '4X'], kids_sizes: true };
  assert.deepEqual(sizesFor('aj', centre), ['4', '6', '8', '10', '12', '14', '16', 'S', 'M', '1X']);
  assert.deepEqual(sizesFor('sassy', centre), ['S', 'M', '1X', '4X']);
  assert.equal(storeSize('aj', 'S'), '14', 'S on AJ is the 14');
  assert.equal(storeSize('brooke', 'XS'), '12');
  assert.equal(storeSize('aj', '1X'), '1X');
  assert.equal(storeSize('aj', 'XL'), '1X');
  assert.equal(storeSize('sassy', 'S'), 'S');
});

test('the request form rejects a size the style does not come in, and describes items with the shelf size', () => {
  const requests = require('../../virtual-closet/lib/requests');
  const centre = { name: 'Demo', sizes: ['S', 'M', '4X'], kids_sizes: false, items_per_request: 2 };
  const bad = requests.cleanItems([{ style: 'aj', colour: 'Black', size: '4X' }], centre);
  assert.equal(bad.items.length, 0);
  assert.match(bad.errors[0], /AJ comes in S, M/);
  const good = requests.cleanItems([{ style: 'aj', colour: 'Black', size: 'S' }, { style: 'sassy', colour: 'Pink', size: '4X' }], centre);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(requests.describeItems(good.items).map(i => [i.styleName, i.size, i.storeSize]), [['AJ', 'S', '14'], ['Sassy', '4X', '4X']]);
});

test('the request form offers each style its own sizes', () => {
  const view = require('../../virtual-closet/views/request');
  const centre = { slug: 'demo', name: 'Demo', sizes: SIZES, kids_sizes: true, items_per_request: 2, requests_per_year: 2, ship_to_door: true, address: {} };
  const html = view.form({ centre, products: MENU });
  assert.ok(html.includes('data-sizes="4|6|8|10|12|14|16|XS|S|M|L|1X|2X|3X"'), 'numeric styles carry kids sizes and stop at 3X');
  assert.ok(html.includes('data-sizes="XS|S|M|L|1X|2X|3X|4X"'), 'Sassy carries the letter run');
  assert.ok(!/undefined|NaN/.test(html));
  assert.ok(!html.includes('Any age'));
});

test('emails compose without leaking undefined and keep the audience words', async () => {
  process.env.VC_EMAIL_MODE = 'console';
  const emails = require('../../virtual-closet/lib/emails');
  const log = console.log; const out = [];
  console.log = (...a) => out.push(a.join(' '));
  try {
    const centre = { id: 1, slug: 'demo', name: 'Demo Centre', sizes: SIZES, kids_sizes: false, items_per_request: 2, requests_per_year: 2, goal_cents: 30000, approval_mode: 'automatic', ship_to_door: true, programmes: { closet: true, pass_it_on: true }, address: { city: 'Champaign' } };
    const request = { name: 'Rosa', email: 'rosa@example.com', delivery: 'pickup', words: 'A sentence.' };
    const items = [{ styleName: 'AJ', colour: 'Black', size: '1X' }];
    const box = { number: 2, carrier: 'UPS', tracking_number: '1Z' };
    await emails.welcome({ centre, to: 'x@example.com' });
    await emails.requestReceived({ centre, request, items });
    await emails.requestReceived({ centre, request, items, needsAnswer: true });
    await emails.requestReceived({ centre, request, items, approved: true });
    await emails.requestOnItsWay({ centre, request, items });
    await emails.requestDeclined({ centre, request, againFrom: null });
    await emails.boxOnItsWay({ centre, to: 'x@example.com', box, items: 38, pickups: ['Rosa', 'Dee'], doors: ['Mel'], nextBox: { number: 3 } });
    await emails.boxFunded({ centre, to: 'x@example.com', box, raised: 30000 });
    await emails.sponsorThanks({ centre, to: 'x@example.com', amountCents: 5000, box, raised: 19000, goal: 30000, city: 'Champaign' });
    await emails.sponsorArrived({ centre, to: 'x@example.com', box, items: 38, requests: 3 });
  } finally { console.log = log; delete process.env.VC_EMAIL_MODE; }
  const all = out.join('\n');
  assert.ok(!/undefined|NaN/.test(all), all);
  assert.ok(all.includes("You're in, Rosa"), 'by-hand approval has its own subject');
  assert.ok(all.includes('Thank you from Demo Centre'));
  assert.ok(!/box you sponsored|next box/i.test(all), 'sponsors read shipment, not box');
});
