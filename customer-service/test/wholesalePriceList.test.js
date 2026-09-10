/**
 * The wholesale line sheet (2026-09-09/10): the featured subset and its order,
 * sectioning, price bands, the money math, the theme payload and its country
 * views, and the email template around it. All pure; the catalog load is the
 * only I/O and is not exercised here.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  PAGE_URL, PAGE_DISCOUNT_PERCENT, MINIMUM_ORDER_USD, PAYMENT_LINE, FEATURED, PAGE_VIEWS,
  countryCode, pageViewFor, pageUrlFor, isDomestic,
  wholesaleTermsLines, wholesaleDiscountFor, wholesalePrice,
  sectionFor, displayName, isSheetProduct, priceBands, orderByPopularity, buildPriceList, flatRows, themePayload,
} = require('../../b2b-outreach/lib/wholesalePriceList');
const { fillWholesaleTerms, TEMPLATES } = require('../../b2b-outreach/lib/messageTemplates');

// A product the way productCache shapes it.
function product(title, handle, sizePrices, { tags = [], categories = ['Bottoms'] } = {}) {
  return {
    title, handle, tags,
    metafields: { categories },
    variants: Object.entries(sizePrices).map(([size, price], i) => ({
      id: `v${i}`, title: `Black / ${size}`, price: String(price),
      selectedOptions: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: size }],
    })),
  };
}

const RUBY = product('RUBY NO-TUCK SHAPING BIKINI BOTTOM', 'the-ruby-no-tuck-shaping-bikini-bottom', {
  '4': 44, '6': 44, '7': 44, '8': 44, '9': 44, '10': 44, '11': 44,
  '12': 48, '13': 48, '14': 48, '16': 48, 'XS': 48, 'XS+': 48, 'S': 48, 'M': 48, 'L': 48, 'XL': 48, '2XL': 48, '3XL': 48, '4XL': 48,
}, { tags: ['bikini-bottom', 'swimwear'] });
const SKY = product('SKY NO-TUCK SHAPING ONE-PIECE', 'the-sky-shaping-one-piece', {
  '6': 59, '8': 59, '10': 59, '12': 65, '14': 65, '16': 65, 'XS': 65, 'S': 65, 'M': 65, 'L': 65, 'XL': 65, '3XL': 65,
  'S Tall': 65, 'M Tall': 65, 'L Tall': 65, '14 Tall': 65,
}, { categories: ['One-pieces'] });
const AVA = product('AVA SEAMLESS SHAPING BRA', 'the-ava-seamless-shaping-bra', { XXS: 46, XS: 46, S: 46, M: 46, L: 46, XL: 46, '2XL': 46, '3XL': 46, '4XL': 46 }, { categories: ['Tops'] });
const AJ = product('AJ NO-TUCK SHAPING UNDERWEAR', 'the-aj-shaping-underwear', { '4': 28, '6': 28, '8': 28, '10': 28, '12': 32, '14': 32, '16': 32, XS: 32, S: 32, M: 32, L: 32, XL: 32, '4XL': 32 });
const CHARLIE = product('CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR', 'the-extra-cute-shaping-underwear', { '4': 29, '10': 29, '12': 33, XS: 33, '4XL': 33 });
const NAOMI = product('NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR', 'the-naomi-gaff-extra-strength-shaping-underwear', { XS: 35, S: 35, M: 35, L: 35, XL: 35, '4XL': 35 }, { tags: ['bikini-bottom', 'swimwear'] });
const CHEEKY = product('CHEEKY NO-TUCK SHAPING BIKINI BOTTOM', 'the-cheeky-shaping-bikini-bottom', { XXS: 48, XS: 48, '3XL': 48 });
const GENESIS = product('GENESIS SURF STYLE SWIM SHORT', 'the-genesis-surf-style-short', { '6': 49, '8': 49, '10': 49, '12': 49, '14': 49, XS: 55, S: 55, M: 55, L: 55, XL: 55, '4XL': 55 });
const BUNDLE = product('RUBIES MATCHING SET - UNDERWEAR + BRA', 'rubies-matching-underwear-set', { 'Default Title': 57.8 }, { categories: ['Bundles'] });
const TEE = product('EVERY GIRL DESERVES TO SHINE ADULT TEE', 'tee', { S: 30, M: 30, L: 30 }, { tags: ['pride-merch', 'tee'], categories: ['Tops'] });
const PADS = product('RUBIES SHAPING CHEST PADS', 'pads', { S: 14, M: 14 }, { tags: ['chest-shaping'], categories: ['Tops'] });
const GIFT = { title: 'RUBIES Gift Card', handle: 'gift-card', tags: [], metafields: { categories: [] }, variants: [{ id: 'g', title: '$50.00', price: '50', selectedOptions: [{ name: 'Denominations', value: '$50.00' }] }] };

// Catalog order is deliberately scrambled: the sheet's order must come from FEATURED.
const CATALOG = [SKY, CHEEKY, AVA, NAOMI, RUBY, CHARLIE, AJ, GENESIS, BUNDLE, TEE, PADS, GIFT];

// ── sections and names ──────────────────────────────────────────────────────

test('section comes from the title, the way a retailer reads it', () => {
  assert.equal(sectionFor('AJ NO-TUCK SHAPING UNDERWEAR'), 'Underwear');
  // Tagged swimwear in the catalog, filed under Underwear on the July 2026 list.
  assert.equal(sectionFor('NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR'), 'Underwear');
  assert.equal(sectionFor('SASSY NO-TUCK SHAPING UNDERWEAR'), 'Underwear');
  assert.equal(sectionFor('AVA SEAMLESS SHAPING BRA'), 'Bras');
  assert.equal(sectionFor('EVEY SHAPING SPORTS BRA'), 'Bras');
  for (const t of ['RUBY NO-TUCK SHAPING BIKINI BOTTOM', 'SKY NO-TUCK SHAPING ONE-PIECE', 'SUNNY QUEENY TANKINI',
    'SERENA NO-TUCK SHAPING SHORTY SHORT', 'GENESIS SURF STYLE SWIM SHORT', 'MIA HALTER BIKINI TOP']) {
    assert.equal(sectionFor(t), 'Swimwear', t);
  }
  assert.equal(sectionFor('EVERY GIRL DESERVES TO SHINE ADULT TEE'), null);
  assert.equal(sectionFor('RUBIES SHAPING CHEST PADS'), null);
});

test('titles stop shouting; short all-caps names stay', () => {
  assert.equal(displayName('AJ NO-TUCK SHAPING UNDERWEAR'), 'AJ No-Tuck Shaping Underwear');
  assert.equal(displayName('SKY NO-TUCK SHAPING ONE-PIECE'), 'Sky No-Tuck Shaping One-Piece');
  assert.equal(displayName('CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR'), 'Charlie No-Tuck Extra Cute Shaping Underwear');
});

test('bundles, merch, chest pads and gift cards never reach the sheet', () => {
  assert.ok(isSheetProduct(RUBY));
  assert.ok(isSheetProduct(AVA));
  assert.ok(!isSheetProduct(BUNDLE), 'a bundle title mentions UNDERWEAR but is a bundle');
  assert.ok(!isSheetProduct(TEE));
  assert.ok(!isSheetProduct(PADS));
  assert.ok(!isSheetProduct(GIFT), 'no sized variant');
});

// ── price bands ─────────────────────────────────────────────────────────────

test('a youth/adult product yields two bands labelled the way Jamie writes them', () => {
  assert.deepEqual(priceBands(RUBY), [
    { retail: 44, sizes: 'Youth 4-11' },
    { retail: 48, sizes: 'Adult 12-16, XS-4X' },
  ]);
  assert.deepEqual(priceBands(AJ), [
    { retail: 28, sizes: 'Youth 4-10' },
    { retail: 32, sizes: 'Adult 12-16, XS-4X' },
  ]);
});

test('letters only carry no age prefix; plus sizes sit inside the range', () => {
  assert.deepEqual(priceBands(AVA), [{ retail: 46, sizes: 'XXS-4X' }]);
  assert.deepEqual(priceBands(NAOMI), [{ retail: 35, sizes: 'XS-4X' }]);
});

test('Tall variants are noted on the band, and XL-style SKU sizes read as 1X..4X', () => {
  assert.deepEqual(priceBands(SKY), [
    { retail: 59, sizes: 'Youth 6-10' },
    { retail: 65, sizes: 'Adult 12-16, XS-3X (incl. Tall)' },
  ]);
});

test('numeric sizes alone are youth whatever they run to', () => {
  assert.deepEqual(priceBands(GENESIS), [
    { retail: 49, sizes: 'Youth 6-14' },
    { retail: 55, sizes: 'XS-4X' },
  ]);
});

// ── money and terms ─────────────────────────────────────────────────────────

test('wholesale is retail less the discount, exact to the cent', () => {
  assert.equal(wholesalePrice(28, 50), 14);
  assert.equal(wholesalePrice(33, 50), 16.5);
  assert.equal(wholesalePrice(65, 50), 32.5);
  assert.equal(wholesalePrice(28, 30), 19.6);
  assert.equal(wholesalePrice(47, 30), 32.9);
});

test('the discount is the stored partner rate, else the country default', () => {
  assert.equal(wholesaleDiscountFor({ country: 'United States' }), 50);
  assert.equal(wholesaleDiscountFor({ country: 'Canada' }), 30);
  assert.equal(wholesaleDiscountFor({ country: 'Canada', wholesale_discount_percent: 40 }), 40);
  assert.equal(wholesaleDiscountFor({ country: 'US', wholesale_discount_percent: null }), 50);
  assert.equal(wholesaleDiscountFor(null), 30, 'unknown stays conservative');
});

test('terms are four short lines naming the rate, the minimum, shipping and delivery, with no em dashes', () => {
  const lines = wholesaleTermsLines(50);
  assert.deepEqual(lines, [
    '50% off retail, priced in USD',
    `$${MINIMUM_ORDER_USD} USD minimum order, no unit minimums`,
    'Free shipping, no duties',
    'Orders typically arrive within 5 business days',
  ]);
  // Outside the US, one more line: how to pay.
  const intl = wholesaleTermsLines(30, { international: true });
  assert.equal(intl.length, 5);
  assert.equal(intl[4], PAYMENT_LINE);
  assert.match(PAYMENT_LINE, /USD \(recommended\)/);
  assert.equal(MINIMUM_ORDER_USD, 300);
  assert.match(wholesaleTermsLines(30)[0], /^30% off retail/);
  assert.ok(!lines.join(' ').includes('—'), 'customer-facing: no em dashes');
  assert.throws(() => wholesaleTermsLines(0));
  assert.throws(() => wholesaleTermsLines('abc'));
});

// ── the sheet ───────────────────────────────────────────────────────────────

test('the sheet is the featured subset in its locked order, bras last, bands under one product', () => {
  const list = buildPriceList(CATALOG, { discountPercent: 50 });
  assert.deepEqual(list.sections.map(s => s.name), ['Underwear', 'Swimwear', 'Bras']);
  assert.deepEqual(list.sections[0].products.map(p => p.product),
    ['AJ No-Tuck Shaping Underwear', 'Charlie No-Tuck Extra Cute Shaping Underwear', 'Naomi Gaff Extra Strength Shaping Underwear'],
    'in FEATURED order, catalog order ignored; Sassy is absent from this catalog so it is skipped, not invented');
  assert.deepEqual(list.sections[1].products.map(p => p.handle), ['the-cheeky-shaping-bikini-bottom', 'the-ruby-no-tuck-shaping-bikini-bottom']);
  assert.deepEqual(list.sections[2].products.map(p => p.handle), ['the-ava-seamless-shaping-bra']);
  const aj = list.sections[0].products[0];
  assert.equal(aj.url, 'https://rubyshines.com/products/the-aj-shaping-underwear');
  assert.equal(aj.image, null);
  assert.deepEqual(aj.bands, [
    { sizes: 'Youth 4-10', retail: 28, wholesale: 14 },
    { sizes: 'Adult 12-16, XS-4X', retail: 32, wholesale: 16 },
  ]);
  // Not featured: Sky and Genesis are eligible but not on the sheet.
  const handles = flatRows(list).map(r => r.handle);
  assert.ok(!handles.includes('the-sky-shaping-one-piece'));
  assert.ok(!handles.includes('the-genesis-surf-style-short'));
});

test('within a section, units sold decide the order; FEATURED order breaks ties and stands in with no data', () => {
  const handles = ['a', 'b', 'c', 'd'];
  assert.deepEqual(orderByPopularity(handles, null), ['a', 'b', 'c', 'd']);
  assert.deepEqual(orderByPopularity(handles, new Map([['d', 10], ['b', 10], ['c', 3]])), ['b', 'd', 'c', 'a'],
    'b before d on the tie, a last with no sales');

  const popularity = new Map([
    ['the-sassy-no-tuck-shaping-underwear', 1526], ['the-naomi-gaff-extra-strength-shaping-underwear', 386],
    ['the-aj-shaping-underwear', 13514], ['the-extra-cute-shaping-underwear', 5855],
    ['the-ruby-no-tuck-shaping-bikini-bottom', 3793], ['the-cheeky-shaping-bikini-bottom', 850],
  ]);
  const list = buildPriceList(CATALOG, { discountPercent: 50, popularity });
  assert.deepEqual(list.sections[0].products.map(p => p.handle),
    ['the-aj-shaping-underwear', 'the-extra-cute-shaping-underwear', 'the-naomi-gaff-extra-strength-shaping-underwear']);
  assert.deepEqual(list.sections[1].products.map(p => p.handle),
    ['the-ruby-no-tuck-shaping-bikini-bottom', 'the-cheeky-shaping-bikini-bottom'], 'Ruby outsells Cheeky, so Ruby leads');
  assert.equal(themePayload(CATALOG, { popularity }).sections[1].products[0].handle, 'the-ruby-no-tuck-shaping-bikini-bottom');
  // Sales figures never reach the public payload.
  assert.ok(!JSON.stringify(themePayload(CATALOG, { popularity })).includes('13514'));
});

test('FEATURED lists real handles once each, and every handle sections where it is listed', () => {
  const all = FEATURED.flatMap(s => s.handles);
  assert.equal(new Set(all).size, all.length, 'no duplicates');
  assert.equal(FEATURED[FEATURED.length - 1].name, 'Bras', 'bras last');
  assert.ok(all.includes('the-sassy-no-tuck-shaping-underwear'));
  assert.ok(all.includes('the-shaping-shorty-shorts'), 'Serena');
});

test('the unfiltered sheet takes every eligible product, A-Z within section', () => {
  const list = buildPriceList(CATALOG, { discountPercent: 50, featured: false });
  assert.deepEqual(list.sections[1].products.map(p => p.product),
    ['Cheeky No-Tuck Shaping Bikini Bottom', 'Genesis Surf Style Swim Short', 'Ruby No-Tuck Shaping Bikini Bottom', 'Sky No-Tuck Shaping One-Piece']);
  const all = flatRows(list).map(r => r.product).join(' ');
  assert.ok(!/Matching Set|Tee|Chest Pads|Gift/.test(all));
});

test('media decorates products with their image, by handle', () => {
  const media = new Map([['the-aj-shaping-underwear', { image: 'https://cdn.shopify.com/aj.png' }]]);
  const list = buildPriceList(CATALOG, { discountPercent: 50, media });
  assert.equal(list.sections[0].products[0].image, 'https://cdn.shopify.com/aj.png');
  assert.equal(list.sections[0].products[1].image, null);
});

test('the theme payload is the page: US view by default, every view precomputed', () => {
  const p = themePayload(CATALOG, { generatedAt: '2026-09-09T12:00:00Z' });
  assert.equal(p.discount_percent, PAGE_DISCOUNT_PERCENT);
  assert.equal(p.currency, 'USD');
  assert.equal(p.minimum_order_usd, 300);
  assert.equal(p.generated_at, '2026-09-09T12:00:00.000Z');
  assert.equal(p.default_view, 'us');
  assert.deepEqual(p.terms, wholesaleTermsLines(50));
  assert.deepEqual(Object.keys(p.views), ['us', 'au', 'other']);
  assert.deepEqual(p.views.us, { rate: 50, international: false, terms: wholesaleTermsLines(50) });
  assert.deepEqual(p.views.au, { rate: 50, international: true, terms: wholesaleTermsLines(50, { international: true }) });
  assert.deepEqual(p.views.other, { rate: 30, international: true, terms: wholesaleTermsLines(30, { international: true }) });
  // The USD ↔ local toggle needs to know a country's currency; the US has none listed.
  assert.equal(p.currency_by_country.ca, 'CAD');
  assert.equal(p.currency_by_country.de, 'EUR');
  assert.equal(p.currency_by_country.us, undefined);
  // Shopify's own FX comes from the fx-reference product; its USD price rides along.
  assert.equal(p.fx_reference_usd, null);
  assert.equal(themePayload(CATALOG, { fxReferenceUsd: '9900.00' }).fx_reference_usd, 9900);
  assert.equal(p.sections.length, 3);
  // Serialisable as-is: what publishThemeAsset writes. Each band carries the
  // wholesale figure for every view's rate so the page never does arithmetic.
  const ava = JSON.parse(JSON.stringify(p)).sections[2].products[0].bands[0];
  assert.equal(ava.wholesale, 23);
  assert.deepEqual(ava.wholesale_by_rate, { '50': 23, '30': 32.2 });
  // Without extraRates (the console's markdown sheet) the shape stays lean.
  assert.equal(buildPriceList(CATALOG, { discountPercent: 50 }).sections[2].products[0].bands[0].wholesale_by_rate, undefined);
});

test('a country lands on a view, and the link carries it', () => {
  assert.equal(countryCode('United States'), 'us');
  assert.equal(countryCode('US'), 'us');
  assert.equal(countryCode('Canada'), 'ca');
  assert.equal(countryCode('United Kingdom'), 'gb');
  assert.equal(countryCode(null), null);
  assert.deepEqual(pageViewFor('United States'), { key: 'us', rate: 50, international: false });
  assert.deepEqual(pageViewFor('Australia'), { key: 'au', rate: 50, international: true });
  assert.deepEqual(pageViewFor('Canada'), { key: 'other', rate: 30, international: true });
  assert.deepEqual(pageViewFor('Denmark'), { key: 'other', rate: 30, international: true });
  assert.equal(pageViewFor(null).key, 'us', 'unknown country shows the default view');
  assert.equal(pageUrlFor('US'), PAGE_URL);
  assert.equal(pageUrlFor(null), PAGE_URL);
  assert.equal(pageUrlFor('Canada'), `${PAGE_URL}?country=ca`);
  assert.equal(pageUrlFor('Australia'), `${PAGE_URL}?country=au`);
  assert.ok(isDomestic('United States') && !isDomestic('Canada') && !isDomestic(null));
  assert.equal(PAGE_VIEWS.other.rate, 30);
});

// ── the email template ──────────────────────────────────────────────────────

test('wholesale_terms: inline terms and a country-aware page link, never an attachment', () => {
  const us = fillWholesaleTerms({ firstName: 'Ellen', discount: 50, country: 'United States' });
  assert.match(us.body, /^Hi Ellen,/);
  for (const line of wholesaleTermsLines(50)) assert.ok(us.body.includes(`\n- ${line}\n`), `terms line as a bullet: ${line}`);
  assert.ok(!us.body.includes(PAYMENT_LINE), 'domestic: no payment line');
  assert.match(us.body, /Let me know if you have any questions\. It would be great to set up a quick call to discuss\.\n\nTalk soon,/);
  assert.ok(us.body.includes(`the price list is here: [Wholesale pricing](${PAGE_URL}). `), 'bare link for the US');
  assert.ok(us.body.includes('here is [how it works](https://rubyshines.com/pages/how-it-works).'), 'explainer linked');
  assert.ok(!us.body.includes('attached'));
  assert.ok(!us.body.includes('standard'), 'no negotiated-rate note at the standard rate');
  assert.deepEqual(us.attachments, [], 'the page is the price list (Jamie 2026-09-10)');
  assert.ok(!us.body.includes('\u2014'));

  const ca = fillWholesaleTerms({ firstName: 'Ellen', discount: 30, country: 'Canada' });
  assert.match(ca.body, /30% off retail/);
  assert.ok(ca.body.includes(PAYMENT_LINE), 'international: payment line');
  assert.ok(ca.body.includes(`[Wholesale pricing](${PAGE_URL}?country=ca)`), 'the link carries the country');
  assert.deepEqual(ca.attachments, []);

  // A negotiated rate the page has no view for is stated next to the link.
  const negotiated = fillWholesaleTerms({ firstName: 'Jesse', discount: 45, country: 'Australia' });
  assert.match(negotiated.body, /45% off retail/);
  assert.ok(negotiated.body.includes(`${PAGE_URL}?country=au`));
  assert.match(negotiated.body, /The page shows our standard 50% rate\. Your pricing is 45% off, as agreed/);
  assert.deepEqual(negotiated.attachments, []);
});

test('the template is offered to retailers only', () => {
  const t = TEMPLATES.find(x => x.id === 'wholesale_terms');
  assert.ok(t, 'registered');
  assert.equal(t.retailerOnly, true);
  assert.ok(!t.orgOnly);
  // Applied from a company with no open thread it starts a new email, which
  // the send path refuses without a subject.
  assert.equal(t.subject, 'RUBIES wholesale terms and pricing');
});
