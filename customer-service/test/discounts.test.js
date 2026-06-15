const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseTiers, resolveDates, etToUtcISO, constructSaleText, convertToRichText, volumeMetafieldText,
} = require('../../promotions/discounts');

// The manage_discount tool's start_sale guards short-circuit BEFORE any Shopify/DB
// I/O, so they're unit-testable without stubs.
const manageDiscount = require('../lib/tools/discounts').find((t) => t.name === 'manage_discount');

test('start_sale: attaching a gift with no minimum stops and asks', async () => {
  const res = await manageDiscount.handler({
    action: 'start_sale', name: 'Test Sale', tiers: '20%',
    start_date: '2026-06-15', end_date: '2026-06-16', free_gift_handle: 'pride-earrings',
  });
  assert.ok(!res.isError);
  assert.match(res.content[0].text, /minimum not specified/i);
});

test('start_sale: gifted sale without dates stops and asks for both', async () => {
  const res = await manageDiscount.handler({
    action: 'start_sale', name: 'Test Sale', tiers: '20%',
    free_gift_handle: 'pride-earrings', free_gift_minimum: 100,
  });
  assert.match(res.content[0].text, /needs both start_date and end_date/i);
});

test('parseTiers: quantity tiers', () => {
  assert.deepEqual(parseTiers('3+@10%,5+@15%'), [
    { threshold: 3, percentage: 10 },
    { threshold: 5, percentage: 15 },
  ]);
});

test('parseTiers: subtotal tiers with $ and out-of-order input gets sorted', () => {
  assert.deepEqual(parseTiers('$200+@20%,$100+@15%'), [
    { threshold: 100, percentage: 15 },
    { threshold: 200, percentage: 20 },
  ]);
});

test('parseTiers: bare percentage → threshold 0', () => {
  assert.deepEqual(parseTiers('20%'), [{ threshold: 0, percentage: 20 }]);
});

test('parseTiers: junk → null', () => {
  assert.equal(parseTiers(''), null);
  assert.equal(parseTiers('not a discount'), null);
  assert.equal(parseTiers(null), null);
});

test('etToUtcISO: midnight ET in summer (EDT, UTC-4)', () => {
  assert.equal(etToUtcISO(2026, 6, 30, 0, 0), '2026-06-30T04:00:00.000Z');
});

test('etToUtcISO: midnight ET in winter (EST, UTC-5)', () => {
  assert.equal(etToUtcISO(2026, 1, 15, 0, 0), '2026-01-15T05:00:00.000Z');
});

test('resolveDates: inclusive last day ends 3am ET next day (summer)', () => {
  const { startsAt, endsAt } = resolveDates('2026-06-01', '2026-06-30');
  assert.equal(startsAt, '2026-06-01T04:00:00.000Z');
  assert.equal(endsAt, '2026-07-01T07:00:00.000Z'); // 3am EDT July 1
});

test('resolveDates: end-of-month rollover across months/years', () => {
  const { endsAt } = resolveDates(null, '2026-12-31');
  assert.equal(endsAt, '2027-01-01T08:00:00.000Z'); // 3am EST Jan 1 (winter, UTC-5)
});

test('resolveDates: null inputs → nulls', () => {
  assert.deepEqual(resolveDates(null, null), { startsAt: null, endsAt: null });
});

test('constructSaleText: single flat tier', () => {
  const txt = constructSaleText([{ threshold: 0, percentage: 20 }], '2026-06-30');
  assert.match(txt, /20% off your entire cart!/);
  assert.match(txt, /Valid now until midnight Eastern Time June 30, 2026\./);
  assert.match(txt, /no code needed\./);
});

test('constructSaleText: subtotal tiers read as a ladder', () => {
  const txt = constructSaleText([{ threshold: 100, percentage: 15 }, { threshold: 200, percentage: 20 }], null);
  assert.match(txt, /Spend up to \$200, save 15%\./);
  assert.match(txt, /Spend \$200\+, save 20%!/);
});

test('convertToRichText: bolds percentages, valid JSON root', () => {
  const json = JSON.parse(convertToRichText('Save 20% today'));
  assert.equal(json.type, 'root');
  const bolded = json.children[0].children.find((c) => c.bold);
  assert.equal(bolded.value, '20%');
});

test('volumeMetafieldText: sorted, bolded thresholds', () => {
  assert.equal(
    volumeMetafieldText([{ threshold: 5, percentage: 15 }, { threshold: 3, percentage: 10 }]),
    '<b>3+</b> 10% off, <b>5+</b> 15% off'
  );
});
