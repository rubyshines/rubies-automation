/**
 * styleSwitch.js — the shared "which style is cut wider, and can we supply it
 * in this size" logic behind both compare_products and sizingEngine.
 *
 * Fixture mirrors the live product_cs_config so these tests cannot pass against
 * a shape production does not have.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  styleSwitchNote, isYouthSize, offeredSizeFor, crossesToAdult, tightLegsTargets,
  buildStyleSwitchOptions,
} = require('../lib/styleSwitch');

const PRODUCTS = {
  'the-aj-shaping-underwear': { nickname: 'AJ', category: 'underwear_bottom', styleSwitch: null },
  'the-extra-cute-shaping-underwear': { nickname: 'Charlie', category: 'underwear_bottom', styleSwitch: null },
  'the-sassy-no-tuck-shaping-underwear': {
    nickname: 'Sassy', category: 'underwear_bottom',
    styleSwitch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Larger leg opening, recommend for tight legs',
      recommendFor: { tightLegs: true, ageGroups: ['adult'], sizedIn: 'adult', everyday: true } },
  },
  'the-naomi-gaff-extra-strength-shaping-underwear': {
    nickname: 'Naomi', category: 'underwear_bottom',
    styleSwitch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Higher-cut cheeky leg',
      recommendFor: { tightLegs: true, ageGroups: ['adult'], sizedIn: 'adult', everyday: false } },
  },
  'the-flo-shaping-dance-underwear': {
    nickname: 'Flo', category: 'underwear_bottom',
    styleSwitch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Larger leg opening (youth sizes only)',
      recommendFor: { tightLegs: true, ageGroups: ['youth'], sizedIn: 'youth', everyday: true } },
  },
  'the-ruby-no-tuck-shaping-bikini-bottom': { nickname: 'Ruby', category: 'swim_bottom', styleSwitch: null },
  'the-cheeky-shaping-bikini-bottom': {
    nickname: 'Cheeky', category: 'swim_bottom',
    styleSwitch: { isTarget: true, forCategories: ['swim_bottom'], note: 'Larger leg opening, recommend for tight legs',
      recommendFor: { tightLegs: true, ageGroups: ['youth', 'adult'], sizedIn: 'adult', everyday: true } },
  },
  'the-sky-no-tuck-shaping-one-piece': { nickname: 'Sky', category: 'onepiece', styleSwitch: null },
};

const names = (ts) => ts.map(t => t.nickname);

// --- isYouthSize ------------------------------------------------------------
test('isYouthSize: numeric is youth except 16, the youth/adult boundary', () => {
  for (const s of ['4', '6', '8', '10', '12', '14']) assert.strictEqual(isYouthSize(s), true, s);
  assert.strictEqual(isYouthSize('16'), false, '16 maps to M and is treated as adult');
  for (const s of ['XS', 'S', 'M', 'L', '1X']) assert.strictEqual(isYouthSize(s), false, s);
  assert.strictEqual(isYouthSize(null), false);
  assert.strictEqual(isYouthSize(undefined), false);
});

// --- offeredSizeFor ---------------------------------------------------------
test('offeredSizeFor: youth 10-16 crosses into an adult-sized style', () => {
  const adult = { sizedIn: 'adult' };
  assert.strictEqual(offeredSizeFor(adult, '10'), 'XXS');
  assert.strictEqual(offeredSizeFor(adult, '12'), 'XS');
  assert.strictEqual(offeredSizeFor(adult, '14'), 'S');
  assert.strictEqual(offeredSizeFor(adult, '16'), 'M');
});

test('offeredSizeFor: youth 4-9 has no adult equivalent, so cannot be served', () => {
  const adult = { sizedIn: 'adult' };
  for (const s of ['4', '6', '7', '8', '9']) {
    assert.strictEqual(offeredSizeFor(adult, s), null, `size ${s} must not cross over`);
  }
});

test('offeredSizeFor: an adult size passes through an adult-sized style unchanged', () => {
  assert.strictEqual(offeredSizeFor({ sizedIn: 'adult' }, 'M'), 'M');
  assert.strictEqual(offeredSizeFor({ sizedIn: 'adult' }, '1X'), '1X');
});

test('offeredSizeFor: we never cross an adult DOWN into a youth-sized style', () => {
  // An adult XS would physically fit the Flo; sending an adult to kids' dance
  // underwear is a positioning call, not a sizing one.
  const youth = { sizedIn: 'youth' };
  for (const s of ['XS', 'S', 'M', 'L']) assert.strictEqual(offeredSizeFor(youth, s), null, s);
  assert.strictEqual(offeredSizeFor(youth, '12'), '12', 'youth size in a youth style is unchanged');
});

test('offeredSizeFor: XL-style aliases normalize before mapping', () => {
  assert.strictEqual(offeredSizeFor({ sizedIn: 'adult' }, 'XL'), '1X');
});

test('offeredSizeFor: no size means unknown, not available', () => {
  assert.strictEqual(offeredSizeFor({ sizedIn: 'adult' }, null), null);
  assert.strictEqual(offeredSizeFor({ sizedIn: 'adult' }, ''), null);
});

test('crossesToAdult: true only when a youth numeric meets an adult-sized style', () => {
  assert.strictEqual(crossesToAdult({ sizedIn: 'adult' }, '12'), true);
  assert.strictEqual(crossesToAdult({ sizedIn: 'adult' }, 'M'), false);
  assert.strictEqual(crossesToAdult({ sizedIn: 'youth' }, '12'), false);
  assert.strictEqual(crossesToAdult(undefined, '12'), false);
});

// --- styleSwitchNote --------------------------------------------------------
test('styleSwitchNote: scoped to the categories it applies to', () => {
  const flo = PRODUCTS['the-flo-shaping-dance-underwear'];
  assert.match(styleSwitchNote(flo, 'underwear_bottom'), /Larger leg opening/);
  assert.strictEqual(styleSwitchNote(flo, 'swim_bottom'), null);
  assert.strictEqual(styleSwitchNote(PRODUCTS['the-aj-shaping-underwear'], 'underwear_bottom'), null);
  assert.strictEqual(styleSwitchNote(null, 'underwear_bottom'), null);
});

// --- tightLegsTargets: underwear -------------------------------------------
test('adult underwear gets the Sassy and the Naomi, everyday pick first', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M', excludeNickname: 'AJ' });
  assert.deepStrictEqual(names(t), ['Sassy', 'Naomi'], 'Sassy leads because it is the all-day pick');
  assert.strictEqual(t[0].everyday, true);
  assert.strictEqual(t[1].everyday, false);
});

test('youth underwear gets the Flo only, never the adult-positioned styles', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: true, size: '12', excludeNickname: 'AJ' });
  assert.deepStrictEqual(names(t), ['Flo']);
});

test('the style they already own is never offered back to them', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M', excludeNickname: 'Sassy' });
  assert.deepStrictEqual(names(t), ['Naomi']);
});

test('exclusion is case-insensitive', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M', excludeNickname: 'sASSy' });
  assert.ok(!names(t).includes('Sassy'));
});

// --- tightLegsTargets: swim + the crossover Jamie flagged -------------------
test('youth 10-16 swim gets the Cheeky, quoted in adult sizing', () => {
  for (const [youth, adult] of [['10', 'XXS'], ['12', 'XS'], ['14', 'S']]) {
    const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'swim_bottom', isKids: true, size: youth, excludeNickname: 'Ruby' });
    assert.deepStrictEqual(names(t), ['Cheeky'], `youth ${youth} should reach the Cheeky`);
    assert.strictEqual(t[0].size, adult, `youth ${youth} -> adult ${adult}`);
    assert.strictEqual(t[0].crossesToAdult, true);
  }
});

test('youth 4-9 swim gets nothing, because no adult size fits them', () => {
  for (const s of ['4', '6', '8', '9']) {
    const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'swim_bottom', isKids: true, size: s, excludeNickname: 'Ruby' });
    assert.deepStrictEqual(names(t), [], `youth ${s} has no crossover`);
  }
});

test('adult swim gets the Cheeky at its own size, no crossover flag', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'swim_bottom', isKids: false, size: 'M', excludeNickname: 'Ruby' });
  assert.deepStrictEqual(names(t), ['Cheeky']);
  assert.strictEqual(t[0].size, 'M');
  assert.strictEqual(t[0].crossesToAdult, false);
});

test('a Cheeky owner has no wider swim style to move to', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'swim_bottom', isKids: false, size: 'M', excludeNickname: 'Cheeky' });
  assert.deepStrictEqual(names(t), []);
});

// --- category isolation -----------------------------------------------------
test('categories never leak into each other', () => {
  const swim = tightLegsTargets({ activeProducts: PRODUCTS, category: 'swim_bottom', isKids: false, size: 'M' });
  assert.ok(!names(swim).some(n => ['Sassy', 'Naomi', 'Flo'].includes(n)), 'no underwear in a swim answer');
  const under = tightLegsTargets({ activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M' });
  assert.ok(!names(under).includes('Cheeky'), 'no swim in an underwear answer');
});

test('a one-piece has no target, so nothing is invented for it', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'onepiece', isKids: false, size: 'M', excludeNickname: 'Sky' });
  assert.deepStrictEqual(names(t), []);
});

// --- degenerate input -------------------------------------------------------
test('omitting the size returns cut facts without an availability claim', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false });
  assert.deepStrictEqual(names(t), ['Sassy', 'Naomi']);
  assert.strictEqual(t[0].size, null, 'no size means no size claim');
  assert.strictEqual(t[0].crossesToAdult, false);
});

test('missing or empty product map returns nothing rather than throwing', () => {
  assert.deepStrictEqual(tightLegsTargets({ category: 'underwear_bottom', isKids: false, size: 'M' }), []);
  assert.deepStrictEqual(tightLegsTargets({}), []);
  assert.deepStrictEqual(tightLegsTargets(), []);
});

test('a target missing recommendFor is a cut fact only, never a suggestion', () => {
  const products = {
    x: { nickname: 'X', category: 'underwear_bottom', styleSwitch: { isTarget: true, note: 'wider' } },
  };
  assert.deepStrictEqual(tightLegsTargets({ activeProducts: products, category: 'underwear_bottom', isKids: false, size: 'M' }), []);
  assert.strictEqual(styleSwitchNote(products.x, 'underwear_bottom'), 'wider', 'still reported as a cut fact');
});

test('ordering is stable when several styles share the everyday flag', () => {
  const products = {
    a: { nickname: 'Zeta', category: 'underwear_bottom', styleSwitch: { isTarget: true, note: 'n', recommendFor: { tightLegs: true, sizedIn: 'adult', everyday: true } } },
    b: { nickname: 'Alpha', category: 'underwear_bottom', styleSwitch: { isTarget: true, note: 'n', recommendFor: { tightLegs: true, sizedIn: 'adult', everyday: true } } },
  };
  const t = tightLegsTargets({ activeProducts: products, category: 'underwear_bottom', isKids: false, size: 'M' });
  assert.deepStrictEqual(names(t), ['Alpha', 'Zeta'], 'alphabetical within the same everyday flag');
});

// --- availability -----------------------------------------------------------
// Passed IN so the prescription stays synchronous and pure. Omitting it must
// behave exactly as before availability existed.

const { isOfferable } = require('../lib/styleSwitch');

test('isOfferable: in stock, or out with a restock worth waiting for', () => {
  assert.strictEqual(isOfferable({ inStock: true }), true);
  assert.strictEqual(isOfferable({ inStock: false, restock: { worth_offering: true } }), true);
  assert.strictEqual(isOfferable({ inStock: false, restock: { worth_offering: false } }), false);
  assert.strictEqual(isOfferable({ inStock: false, restock: null }), false);
});

test('isOfferable: unknown availability never silently hides a style', () => {
  assert.strictEqual(isOfferable(undefined), true);
  assert.strictEqual(isOfferable(null), true);
});

test('an out-of-stock style with no restock is dropped from the offer', () => {
  // The live Naomi: zero in every size, no inbound. The deterministic reply
  // promised it for weeks because the engine could not see stock.
  const t = tightLegsTargets({
    activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M', excludeNickname: 'AJ',
    availability: { Sassy: { inStock: true }, Naomi: { inStock: false, restock: null } },
  });
  assert.deepStrictEqual(names(t), ['Sassy']);
});

test('an out-of-stock style still arriving soon stays offerable, carrying its restock', () => {
  const restock = { worth_offering: true, sellable_phrase: 'end of August, 2026' };
  const t = tightLegsTargets({
    activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M', excludeNickname: 'AJ',
    availability: { Sassy: { inStock: false, restock }, Naomi: { inStock: false, restock: null } },
  });
  assert.deepStrictEqual(names(t), ['Sassy']);
  assert.strictEqual(t[0].inStock, false);
  assert.strictEqual(t[0].restock.sellable_phrase, 'end of August, 2026');
});

test('a restock too far out is not offered', () => {
  const t = tightLegsTargets({
    activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M', excludeNickname: 'AJ',
    availability: { Sassy: { inStock: false, restock: { worth_offering: false } }, Naomi: { inStock: false, restock: null } },
  });
  assert.deepStrictEqual(names(t), []);
});

test('omitting availability leaves every style offerable, as before', () => {
  const t = tightLegsTargets({ activeProducts: PRODUCTS, category: 'underwear_bottom', isKids: false, size: 'M', excludeNickname: 'AJ' });
  assert.deepStrictEqual(names(t), ['Sassy', 'Naomi']);
  assert.strictEqual(t[0].inStock, null, 'null means unknown, not in stock');
});

// ---------------------------------------------------------------------------
// buildStyleSwitchOptions — the three supply states the advisor actually reads
// ---------------------------------------------------------------------------

/** recByNick as compare_products builds it: nickname -> tightLegsTargets entry. */
const REC = new Map([
  ['Sassy', { nickname: 'Sassy', note: 'Roomier leg opening as it is cut higher', everyday: true }],
  ['Naomi', { nickname: 'Naomi', note: 'Roomier leg opening as it is cut higher; a gaff', everyday: false }],
]);
const ARRIVING_SASSY = {
  product: 'Sassy', size: 'M',
  restock: { worth_offering: true, sellable_phrase: 'end of August, 2026' },
};

test('an arriving style is offerable and says so on its face', () => {
  const opts = buildStyleSwitchOptions({ inStock: [], arriving: [ARRIVING_SASSY], recByNick: REC });
  assert.strictEqual(opts.length, 1, 'arriving is an option, not a rejection');
  assert.strictEqual(opts[0].product, 'Sassy');
  assert.strictEqual(opts[0].availability, 'arriving');
  assert.strictEqual(opts[0].back_in_stock, 'end of August, 2026');
  assert.ok(opts[0].note, 'carries the cut fact so the reply can still explain the fit');
});

test('an in-stock style is marked in_stock, never left unlabelled', () => {
  // An unlabelled entry is what let the model describe an arriving style in the
  // in-stock register: with no marker there was nothing to distinguish them.
  const opts = buildStyleSwitchOptions({
    inStock: [{ product: 'Sassy', style_switch_note: 'Roomier leg opening', size: 'M' }],
    arriving: [], recByNick: REC,
  });
  assert.strictEqual(opts[0].availability, 'in_stock');
  assert.ok(!('back_in_stock' in opts[0]), 'no restock phrase on something already on the shelf');
});

test('fit leads: the better-positioned style wins even when it is the arriving one', () => {
  // The founder ruling. The Sassy is the all-day pick and is arriving; the Naomi
  // is in stock and is a gaff. Offering the Naomi first because it happens to be
  // on the shelf is the failure this ordering exists to prevent.
  const opts = buildStyleSwitchOptions({
    inStock: [{ product: 'Naomi', style_switch_note: 'Roomier leg opening; a gaff', size: 'M' }],
    arriving: [ARRIVING_SASSY],
    recByNick: REC,
  });
  assert.deepStrictEqual(opts.map(o => o.product), ['Sassy', 'Naomi']);
  assert.deepStrictEqual(opts.map(o => o.availability), ['arriving', 'in_stock']);
});

test('stock breaks the tie only between equally-positioned styles', () => {
  const rec = new Map([
    ['Sassy', { note: 'n', everyday: true }],
    ['Cheeky', { note: 'n', everyday: true }],
  ]);
  const opts = buildStyleSwitchOptions({
    inStock: [{ product: 'Cheeky', style_switch_note: 'n', size: 'M' }],
    arriving: [{ product: 'Sassy', size: 'M', restock: { worth_offering: true, sellable_phrase: 'end of August, 2026' } }],
    recByNick: rec,
  });
  assert.deepStrictEqual(opts.map(o => o.product), ['Cheeky', 'Sassy'], 'same positioning, so what we can ship now leads');
});

test('an option list is never silently empty of its labels', () => {
  // Every entry must carry an availability, or a consumer cannot tell the states
  // apart and we are back to the bug.
  const opts = buildStyleSwitchOptions({
    inStock: [{ product: 'Naomi', style_switch_note: 'n', size: 'M' }],
    arriving: [ARRIVING_SASSY], recByNick: REC,
  });
  for (const o of opts) assert.ok(['in_stock', 'arriving'].includes(o.availability), JSON.stringify(o));
});

test('an alternative with no style-switch note is not a leg-cut option', () => {
  const opts = buildStyleSwitchOptions({
    inStock: [{ product: 'Charlie', size: 'M' }], arriving: [], recByNick: REC,
  });
  assert.deepStrictEqual(opts, [], 'only styles carrying the cut fact belong in this list');
});

test('degenerate input returns an empty list rather than throwing', () => {
  assert.deepStrictEqual(buildStyleSwitchOptions(), []);
  assert.deepStrictEqual(buildStyleSwitchOptions({}), []);
});
