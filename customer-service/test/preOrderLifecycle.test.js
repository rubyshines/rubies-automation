const { test } = require('node:test');
const assert = require('node:assert');

const {
  parsePromisedTarget,
  classifyOrderLines,
  composeUpdateEmail,
  describeItem,
  titleCaseProduct,
} = require('../lib/merchandising/preOrderLifecycle');

// Fixed clock for all date-sensitive assertions.
const NOW = new Date('2026-07-16T12:00:00Z');

// ---------------------------------------------------------------------------
// parsePromisedTarget
// ---------------------------------------------------------------------------

test('parsePromisedTarget: dated future target', () => {
  const p = parsePromisedTarget('Target availability middle of August, 2026.', NOW);
  assert.equal(p.kind, 'dated');
  assert.equal(p.phrase, 'the middle of August');
  assert.equal(p.isPast, false);
});

test('parsePromisedTarget: dated past target', () => {
  const p = parsePromisedTarget('Target availability beginning of April, 2026.', NOW);
  assert.equal(p.kind, 'dated');
  assert.equal(p.phrase, 'the beginning of April');
  assert.equal(p.isPast, true);
});

test('parsePromisedTarget: end-of-month anchor — end of July not past mid-July', () => {
  const p = parsePromisedTarget('Target availability end of July, 2026.', NOW);
  assert.equal(p.isPast, false); // window runs to July 31
  const later = parsePromisedTarget('Target availability end of July, 2026.', new Date('2026-08-02T00:00:00Z'));
  assert.equal(later.isPast, true);
});

test('parsePromisedTarget: middle anchors at the 20th', () => {
  const before = parsePromisedTarget('Target availability middle of July, 2026.', NOW);
  assert.equal(before.isPast, false);
  const after = parsePromisedTarget('Target availability middle of July, 2026.', new Date('2026-07-21T12:00:00Z'));
  assert.equal(after.isPast, true);
});

test('parsePromisedTarget: no-date and unknown texts', () => {
  assert.equal(parsePromisedTarget('Will ship when in stock', NOW).kind, 'no_date');
  assert.equal(parsePromisedTarget('This is a pre-order item.', NOW).kind, 'unknown');
  assert.equal(parsePromisedTarget('', NOW).kind, 'unknown');
  assert.equal(parsePromisedTarget(null, NOW).kind, 'unknown');
});

test('parsePromisedTarget: tolerates missing trailing period and comma', () => {
  const p = parsePromisedTarget('Target availability end of August 2026', NOW);
  assert.equal(p.kind, 'dated');
  assert.equal(p.phrase, 'the end of August');
});

// ---------------------------------------------------------------------------
// classifyOrderLines
// ---------------------------------------------------------------------------

const line = (sku, target) => ({
  sku,
  title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR',
  variantTitle: 'Black / M',
  qty: 1,
  customAttributes: target ? [{ key: 'Pre-order', value: target }] : [],
});

test('classifyOrderLines: wave lines wait, bare lines are in stock', () => {
  const { preItems, inStockItems, unhandledTargets } = classifyOrderLines(
    [line('HLA-BLK-M', 'Target availability middle of August, 2026.'), line('AJ-BLK-M', null)],
    { waveTargets: ['Target availability middle of August, 2026.'] }
  );
  assert.equal(preItems.length, 1);
  assert.equal(preItems[0].target, 'Target availability middle of August, 2026.');
  assert.equal(inStockItems.length, 1);
  assert.deepEqual(unhandledTargets, []);
});

test('classifyOrderLines: stale targets count as in stock (stock arrived, reserved)', () => {
  const { preItems, inStockItems, unhandledTargets } = classifyOrderLines(
    [
      line('SKY2-BLK-2XLT', 'Target availability end of June, 2026.'),
      line('GAF-BLK-2XL', 'Target availability beginning of April, 2026.'),
    ],
    {
      waveTargets: ['Target availability end of June, 2026.'],
      staleTargets: ['Target availability beginning of April, 2026.'],
    }
  );
  assert.equal(preItems.length, 1);
  assert.equal(inStockItems.length, 1);
  assert.deepEqual(unhandledTargets, []);
});

test('classifyOrderLines: unrecognized promise flags the order for individual handling', () => {
  const { unhandledTargets } = classifyOrderLines(
    [line('GAF-BLK-S', 'Target availability middle of October, 2026.')],
    { waveTargets: ['Target availability middle of August, 2026.'] }
  );
  assert.deepEqual(unhandledTargets, ['Target availability middle of October, 2026.']);
});

// ---------------------------------------------------------------------------
// composeUpdateEmail
// ---------------------------------------------------------------------------

const preLine = (target, extra = {}) => ({
  sku: 'HLA-BLK-M',
  title: 'SASSY NO-TUCK SHAPING UNDERWEAR',
  variantTitle: 'Black / M',
  qty: 1,
  target,
  ...extra,
});

test('composeUpdateEmail: variant A offers a swap, no numbered options', () => {
  const { text, variant } = composeUpdateEmail({
    preItems: [preLine('Target availability middle of August, 2026.')],
    inStockItems: [],
    newDatePhrase: 'the end of August',
  }, NOW);
  assert.equal(variant, 'A_pre_only');
  assert.match(text, /was the middle of August:/);
  assert.match(text, /closer to the end of August\./);
  assert.match(text, /happy to swap your pre-order/);
  assert.doesNotMatch(text, /1\. Have us split/);
  assert.doesNotMatch(text, /We are sorry for the wait/); // future promise, no apology
});

test('composeUpdateEmail: variant B offers split-or-swap options', () => {
  const { text, variant } = composeUpdateEmail({
    preItems: [preLine('Target availability middle of August, 2026.')],
    inStockItems: [line('AJ-BLK-M', null)],
    newDatePhrase: 'the end of August',
  }, NOW);
  assert.equal(variant, 'B_mixed');
  assert.match(text, /1\. Have us split your order/);
  assert.match(text, /2\. Swap your pre-order/);
});

test('composeUpdateEmail: past promise adds the apology line', () => {
  const { text } = composeUpdateEmail({
    preItems: [preLine('Target availability end of July, 2026.')],
    inStockItems: [],
    newDatePhrase: 'the end of August',
  }, new Date('2026-08-05T12:00:00Z'));
  assert.match(text, /We are sorry for the wait\./);
});

test('composeUpdateEmail: no-date promise uses the timing framing', () => {
  const { text } = composeUpdateEmail({
    preItems: [preLine('Will ship when in stock')],
    inStockItems: [],
    newDatePhrase: 'the end of August',
  }, NOW);
  assert.match(text, /was listed to ship when back in stock:/);
  assert.match(text, /better idea of timing/);
});

test('composeUpdateEmail: plural pre-order items phrasing', () => {
  const { text } = composeUpdateEmail({
    preItems: [
      preLine('Target availability middle of August, 2026.'),
      preLine('Target availability middle of August, 2026.', { sku: 'HLA-SND-M', variantTitle: 'Sandstone / M' }),
    ],
    inStockItems: [line('AJ-BLK-M', null)],
    newDatePhrase: 'the end of August',
  }, NOW);
  assert.match(text, /your pre-order items was the middle of August:|target availability for your pre-order items/);
  assert.match(text, /as soon as they arrive/);
});

test('composeUpdateEmail: earliest promise drives the opener', () => {
  const { text } = composeUpdateEmail({
    preItems: [
      preLine('Target availability middle of August, 2026.'),
      preLine('Target availability end of July, 2026.', { sku: 'SKY2-BLK-LT' }),
    ],
    inStockItems: [],
    newDatePhrase: 'the end of August',
  }, NOW);
  assert.match(text, /was the end of July:/);
});

test('composeUpdateEmail: customer copy contains no em dashes', () => {
  const { text, html } = composeUpdateEmail({
    preItems: [preLine('Target availability end of July, 2026.')],
    inStockItems: [line('AJ-BLK-M', null)],
    newDatePhrase: 'the end of August',
  }, NOW);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(html, /—/);
});

// ---------------------------------------------------------------------------
// describeItem / titleCaseProduct
// ---------------------------------------------------------------------------

test('describeItem: order-confirmation style with The stripped and variant flattened', () => {
  assert.equal(
    describeItem({ title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', variantTitle: 'Sandstone / M', qty: 2 }),
    '2 X Sassy No-Tuck Shaping Underwear - Sandstone, M'
  );
});

test('describeItem: size-only and Default Title variants', () => {
  assert.equal(
    describeItem({ title: 'MAGICAL SHAPING GEL CHEST PADS', variantTitle: 'Large', qty: 1 }),
    '1 X Magical Shaping Gel Chest Pads - Large'
  );
  assert.equal(
    describeItem({ title: 'PROGRESS PRIDE FLAG', variantTitle: 'Default Title', qty: 1 }),
    '1 X Progress Pride Flag'
  );
});

test('titleCaseProduct: AJ acronym stays uppercase', () => {
  assert.equal(titleCaseProduct('THE AJ NO-TUCK SHAPING UNDERWEAR'), 'The AJ No-Tuck Shaping Underwear');
});
