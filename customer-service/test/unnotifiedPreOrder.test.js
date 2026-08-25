/**
 * Unit tests for reports/lib/unnotifiedPreOrder.js — swap-alternative picking
 * and the done-for-you swap flow.
 *
 * Focus: findEquivalentSwap (identical-fit youth/adult equivalent, same color,
 * same price, in stock), pickAlternativesViaCompare tier precedence, and the
 * composeBody swap-done variant.
 *
 * Run: node --test customer-service/test/unnotifiedPreOrder.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Stub heavy deps BEFORE requiring the module under test
// ---------------------------------------------------------------------------

function stubModule(resolvedPath, exports) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
}

// Fixture catalog keyed by SKU — mirrors the MIA shape (Color + Youth Size options).
const VARIANTS = {
  'MIA-BLK-S': {
    sku: 'MIA-BLK-S',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'S' }],
  },
  'MIA-BLK-14': {
    sku: 'MIA-BLK-14',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: '14' }],
  },
  'MIA-BLK-16': {
    sku: 'MIA-BLK-16',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: '16' }],
  },
  'MIA-BLK-M': {
    sku: 'MIA-BLK-M',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'M' }],
  },
  'MIA-BLK-L': {
    sku: 'MIA-BLK-L',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Youth Size', value: 'L' }],
  },
  // Price-mismatch product: youth tier priced lower than adult.
  'TIER-BLK-S': {
    sku: 'TIER-BLK-S',
    productTitle: 'TIERED PRICE TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: 'S' }],
  },
  'TIER-BLK-14': {
    sku: 'TIER-BLK-14',
    productTitle: 'TIERED PRICE TOP',
    price: 36,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: '14' }],
  },
  // Plus size: the SKU segment spells it XL, the customer's order says 1X.
  'MIA-BLK-XL': {
    sku: 'MIA-BLK-XL',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: '1X' }],
  },
  'MIA-BLK-2XL': {
    sku: 'MIA-BLK-2XL',
    productTitle: 'MIA HALTER BIKINI TOP',
    price: 42,
    options: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: '2X' }],
  },
};

// Per-test compare_products responses keyed by requested size, plus a call log.
let compareResponses = {};
let compareCalls = [];

stubModule(require.resolve('../lib/aiAdvisor'), {
  executeToolCall: async (tool, input) => {
    assert.equal(tool, 'compare_products');
    compareCalls.push(input);
    const resp = compareResponses[input.size];
    if (resp instanceof Error) throw resp;
    return resp || { source: { available_colors: [] }, alternatives: [] };
  },
});

stubModule(require.resolve('../lib/productCache'), {
  getVariantBySku: sku => VARIANTS[sku] || null,
  renderVariantForCustomer: sku => {
    const v = VARIANTS[sku];
    if (!v) return null;
    const color = v.options[0].value;
    const size = v.options[1].value;
    return `the Mia in ${color}, size ${size}`;
  },
  loadFromSupabase: async () => {},
});

stubModule(require.resolve('../lib/sizingEngine'), {
  initCsConfig: async () => {},
  getProductNickname: () => 'Mia',
});

stubModule(require.resolve('../../shared/supabaseClient'), {
  getSupabaseClient: () => ({}),
});

stubModule(require.resolve('../lib/customerOutreach'), {
  seedOutboundDraft: async () => ({ ok: true }),
});

stubModule(path.resolve(__dirname, '../../reports/lib/warehanceClient.js'), {
  fetchOrderByNumber: async () => null,
  fetchUnfulfilledOrders: async () => new Map(),
  fetchSkuStockMany: async () => new Map(),
});

const {
  pickAlternativesViaCompare,
  findEquivalentSwap,
  composeBody,
  classifyOrder,
  filterToNotReadyToShip,
  reclassifyWithAllocation,
  attachSwapData,
  buildSummary,
} = require('../../reports/lib/unnotifiedPreOrder');
const { buildAllocationIndex } = require('../../reports/lib/orderAllocation');

// ---------------------------------------------------------------------------
// findEquivalentSwap
// ---------------------------------------------------------------------------

describe('findEquivalentSwap', () => {
  beforeEach(() => {
    compareResponses = {};
    compareCalls = [];
  });

  it('finds the youth equivalent in the ordered color (adult S → youth 14)', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Black', inventory: 72 }, { color: 'Pink', inventory: 67 }] },
      alternatives: [],
    };
    const swap = await findEquivalentSwap('MIA-BLK-S');
    assert.deepEqual(swap, {
      fromSku: 'MIA-BLK-S',
      toSku: 'MIA-BLK-14',
      nickname: 'Mia',
      color: 'Black',
      fromSize: 'S',
      toSize: '14',
      chart: 'youth',
      rendered: 'the Mia in Black, size 14 (our youth size with the same fit as S)',
    });
  });

  it('finds the adult equivalent for a youth leak (youth 16 → adult M)', async () => {
    compareResponses['M'] = {
      source: { available_colors: [{ color: 'Black', inventory: 16 }] },
      alternatives: [],
    };
    const swap = await findEquivalentSwap('MIA-BLK-16');
    assert.equal(swap.toSku, 'MIA-BLK-M');
    assert.equal(swap.chart, 'adult');
  });

  it('returns null when the size has no youth/adult equivalent (size L)', async () => {
    const swap = await findEquivalentSwap('MIA-BLK-L');
    assert.equal(swap, null);
    assert.deepEqual(compareCalls, []); // no lookup even attempted
  });

  it('returns null when the equivalent is priced differently', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Black', inventory: 10 }] },
      alternatives: [],
    };
    const swap = await findEquivalentSwap('TIER-BLK-S');
    assert.equal(swap, null);
    assert.deepEqual(compareCalls, []); // price gate fires before the lookup
  });

  it('returns null when the equivalent is OOS in the ordered color', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 67 }] }, // no Black
      alternatives: [],
    };
    const swap = await findEquivalentSwap('MIA-BLK-S');
    assert.equal(swap, null);
  });

  it('returns null when the lookup throws', async () => {
    compareResponses['14'] = new Error('boom');
    const swap = await findEquivalentSwap('MIA-BLK-S');
    assert.equal(swap, null);
  });
});

// ---------------------------------------------------------------------------
// pickAlternativesViaCompare
// ---------------------------------------------------------------------------

describe('pickAlternativesViaCompare', () => {
  beforeEach(() => {
    compareResponses = {};
    compareCalls = [];
  });

  it('offers the youth equivalent in the ordered color first (adult S → youth 14)', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Black', inventory: 72 }, { color: 'Pink', inventory: 67 }] },
      alternatives: [],
    };
    compareResponses['S'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 25 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-S');
    assert.deepEqual(alts, [
      'the Mia in Black, size 14 (our youth size with the same fit as S)',
      'the Mia in Pink, size S',
    ]);
    assert.deepEqual(compareCalls, [
      { product: 'Mia', size: '14' },
      { product: 'Mia', size: 'S' },
    ]);
  });

  it('skips tier 0 when the size has no youth/adult equivalent (size L)', async () => {
    compareResponses['L'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 5 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-L');
    assert.deepEqual(alts, ['the Mia in Pink, size L', 'the Queeny, size L']);
    assert.deepEqual(compareCalls, [{ product: 'Mia', size: 'L' }]);
  });

  it('falls through to same-size tiers when the equivalent is OOS in the ordered color', async () => {
    compareResponses['14'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 67 }] }, // no Black
      alternatives: [],
    };
    compareResponses['S'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 25 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-S');
    assert.deepEqual(alts, ['the Mia in Pink, size S', 'the Queeny, size S']);
  });

  it('survives a tier-0 lookup failure and still returns same-size tiers', async () => {
    compareResponses['14'] = new Error('boom');
    compareResponses['S'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 25 }] },
      alternatives: [],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-S');
    assert.deepEqual(alts, ['the Mia in Pink, size S']);
  });

  it('returns [] for an unknown SKU', async () => {
    const alts = await pickAlternativesViaCompare('NOPE-XXX-S');
    assert.deepEqual(alts, []);
  });

  // RUBIES plus sizes are always written 1X/2X/3X/4X to a customer. SKUs spell
  // the same size XL/2XL for the warehouse. Rendering the raw SKU segment
  // offered "the Mia in Pink, size XL" on an order whose own line read 1X
  // (2026-07-29).
  it('renders plus sizes as 1X, never the SKU spelling XL', async () => {
    compareResponses['1X'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 12 }] },
      alternatives: [{ product: 'Queeny' }],
    };
    compareResponses['XL'] = compareResponses['1X'];
    const alts = await pickAlternativesViaCompare('MIA-BLK-XL');
    assert.deepEqual(alts, ['the Mia in Pink, size 1X', 'the Queeny, size 1X']);
    for (const a of alts) {
      assert.doesNotMatch(a, /\bXL\b/, `plus size leaked the SKU spelling: ${a}`);
    }
  });

  it('renders 2XL SKUs as 2X', async () => {
    compareResponses['2X'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 4 }] },
      alternatives: [],
    };
    compareResponses['2XL'] = compareResponses['2X'];
    const alts = await pickAlternativesViaCompare('MIA-BLK-2XL');
    assert.deepEqual(alts, ['the Mia in Pink, size 2X']);
  });

  it('leaves non-plus sizes untouched', async () => {
    compareResponses['L'] = {
      source: { available_colors: [{ color: 'Pink', inventory: 5 }] },
      alternatives: [],
    };
    const alts = await pickAlternativesViaCompare('MIA-BLK-L');
    assert.deepEqual(alts, ['the Mia in Pink, size L']);
  });
});

// ---------------------------------------------------------------------------
// composeBody — swap-done variant
// ---------------------------------------------------------------------------

describe('composeBody with autoSwaps', () => {
  const classification = {
    case: 'B',
    leaks: [{ sku: 'MIA-BLK-S', _variant: { pre_order_date: '2026-10-15' } }],
    inStockOther: [{ sku: 'RUBY-BLK-M' }],
    oosOther: [],
  };
  const autoSwaps = [{
    fromSku: 'MIA-BLK-S',
    toSku: 'MIA-BLK-14',
    nickname: 'Mia',
    color: 'Black',
    fromSize: 'S',
    toSize: '14',
    chart: 'youth',
    rendered: 'the Mia in Black, size 14 (our youth size with the same fit as S)',
  }];

  it('states the swap as done, no options and no opt-out', () => {
    const body = composeBody({ orderNumber: '32563', classification, autoSwaps, daysSinceOrder: 1 });
    assert.match(body, /size 14 on our youth size chart is the exact same fit as the S, and it's in stock/);
    assert.match(body, /I went ahead and swapped your Mia to Black, size 14/);
    assert.match(body, /your full order can now ship right away/);
    // A straight swap needs no menu: no wait-for-original offer, no
    // color/style opt-out, no price talk, fit equivalence stated exactly once.
    assert.doesNotMatch(body, /wait/i);
    assert.doesNotMatch(body, /prefer a different/i);
    assert.doesNotMatch(body, /just reply/i);
    assert.doesNotMatch(body, /price/i);
    assert.equal((body.match(/same fit/gi) || []).length, 1);
    assert.doesNotMatch(body, /Here's what I can do/);
    assert.doesNotMatch(body, /Swap for/);
    assert.doesNotMatch(body, /—/); // no em dashes in customer copy
  });

  it('keeps the options email when autoSwaps is empty', () => {
    const body = composeBody({ orderNumber: '32563', classification, alternatives: ['the Mia in Pink, size S'], daysSinceOrder: 1 });
    assert.match(body, /Here's what I can do/);
    assert.match(body, /Swap for the Mia in Pink, size S/);
  });
});

// ---------------------------------------------------------------------------
// Allocation gate — the whole point of the detection step
// ---------------------------------------------------------------------------
//
// Order #33009 (2026-08-24), the live false positive this replaced. Three paid
// items: a disclosed pre-order bra with no stock anywhere, an in-stock bra, and
// an AJ that Shopify shows at zero but the warehouse has RESERVED for this
// order. Shopify's view alone makes the AJ a leak and the order a Case C. The
// warehouse's view says nobody is waiting on the AJ at all, so there is no
// leak, so there is no email.

describe('reclassifyWithAllocation — #33009', () => {
  const LINE_ITEMS = [
    { sku: 'SPB-BLK-M', quantity: 1, unit_price: 42, custom_attributes: [{ key: 'Pre-order', value: 'Target availability end of August, 2026.' }] },
    { sku: 'SB-BLK-M', quantity: 1, unit_price: 46, custom_attributes: null },
    { sku: 'AJ-BLK-M', quantity: 1, unit_price: 32, custom_attributes: null },
  ];
  const SHOPIFY_STATE = new Map([
    ['SPB-BLK-M', { inventory_quantity: 0, pre_order_date: '2026-08-31' }],
    ['SB-BLK-M', { inventory_quantity: 166 }],
    ['AJ-BLK-M', { inventory_quantity: 0, pre_order_date: '2026-08-31' }],
  ]);
  const whOrder = (num, date, items) => ({
    order_number: `#${num}`,
    order_date: `${date}T00:00:00Z`,
    order_items: items.map(([sku, qty]) => ({ sku, quantity: qty, quantity_shipped: 0 })),
  });
  const OPEN_BOOK = [
    whOrder(32310, '2026-07-10', [['AJ-BLK-M', 2]]),
    whOrder(32809, '2026-08-01', [['AJ-BLK-M', 2]]),
    whOrder(32951, '2026-08-08', [['AJ-BLK-M', 5]]),
    whOrder(33009, '2026-08-11', [['AJ-BLK-M', 1], ['SPB-BLK-M', 1]]),
    whOrder(33295, '2026-08-24', [['AJ-BLK-M', 6]]),
  ];
  const WH_STOCK = new Map([
    ['AJ-BLK-M', { on_hand: 19, allocated: 10, available: 0, backordered: 1 }],
    ['SPB-BLK-M', { on_hand: 0, allocated: 0, available: 0, backordered: 14 }],
  ]);

  it('Shopify alone flags the AJ as a leak and the order as Case C', () => {
    const c = classifyOrder(LINE_ITEMS, SHOPIFY_STATE);
    assert.equal(c.case, 'C');
    assert.deepEqual(c.leaks.map(l => l.sku), ['AJ-BLK-M']);
    assert.deepEqual(c.oosOther.map(l => l.sku), ['SPB-BLK-M']);
  });

  it('the warehouse says the AJ is reserved, so there is no leak and no email', () => {
    const index = buildAllocationIndex(OPEN_BOOK, WH_STOCK);
    const c = classifyOrder(LINE_ITEMS, SHOPIFY_STATE);
    assert.equal(reclassifyWithAllocation(c, { orderNumber: '33009', allocationIndex: index }), null);
  });

  it('still drafts when the leak is genuinely unreserved', () => {
    // Same order, but the AJ queue is now long enough that #33009 misses out.
    const starved = buildAllocationIndex(
      [whOrder(32000, '2026-07-01', [['AJ-BLK-M', 19]]), ...OPEN_BOOK],
      WH_STOCK,
    );
    const c = classifyOrder(LINE_ITEMS, SHOPIFY_STATE);
    const out = reclassifyWithAllocation(c, { orderNumber: '33009', allocationIndex: starved });
    assert.equal(out.case, 'C');
    assert.deepEqual(out.leaks.map(l => l.sku), ['AJ-BLK-M']);
  });

  it('keeps the Shopify verdict when allocation has nothing to say', () => {
    const c = classifyOrder(LINE_ITEMS, SHOPIFY_STATE);
    const out = reclassifyWithAllocation(c, { orderNumber: '33009', allocationIndex: new Map() });
    assert.equal(out.case, 'C');
    assert.deepEqual(out.leaks.map(l => l.sku), ['AJ-BLK-M']);
  });
});

describe('filterToNotReadyToShip', () => {
  const candidate = num => ({ order: { order_number: num }, classification: {} });
  const notReady = (types = {}) => ({
    ready_to_ship: false,
    cancelled: false,
    not_ready_to_ship_types: { has_unallocated_products: true, ...types },
  });

  it('keeps an order with unallocated products', () => {
    const kept = filterToNotReadyToShip([candidate(1)], new Map([['1', notReady()]]));
    assert.equal(kept.length, 1);
  });

  // An order held for address verification reports ready_to_ship false with
  // every unit reserved. There is no stock news to send that customer.
  it('drops a fully allocated order that is held for a non-stock reason', () => {
    const wh = notReady({ has_unallocated_products: false, address_hold: true });
    assert.deepEqual(filterToNotReadyToShip([candidate(1)], new Map([['1', wh]])), []);
  });

  it('drops cancelled and already-fulfilled orders', () => {
    assert.deepEqual(filterToNotReadyToShip([candidate(1)], new Map([['1', notReady({ order_cancelled: true })]])), []);
    assert.deepEqual(filterToNotReadyToShip([candidate(1)], new Map([['1', notReady({ order_is_already_fulfilled: true })]])), []);
    assert.deepEqual(filterToNotReadyToShip([candidate(1)], new Map([['1', { ...notReady(), cancelled: true }]])), []);
  });

  it('drops orders Warehance has never heard of', () => {
    assert.deepEqual(filterToNotReadyToShip([candidate(1)], new Map()), []);
  });
});

// ---------------------------------------------------------------------------
// Shared composition — the sweep and Refresh must produce the same email
// ---------------------------------------------------------------------------
//
// recomposeOutreachForOrder exists so the dashboard's Refresh re-runs THIS
// template rather than the general outbound composer. The first attempt at
// Refresh went through the composer and produced a different kind of email
// entirely — raw SKUs and the shipping address quoted into customer copy, and
// the A/B/C case dropped. The guard against that regressing is that both paths
// build their body from the same helpers.

describe('outreach composition is shared between the sweep and Refresh', () => {
  const classification = {
    case: 'C',
    leaks: [{ sku: 'MIA-BLK-S', _variant: { pre_order_date: '2026-10-15' } }],
    inStockOther: [],
    oosOther: [{ sku: 'MIA-BLK-L' }],
  };

  it('buildSummary matches the summary the sweep files on the ticket', () => {
    assert.equal(buildSummary(classification, false), 'Unnotified pre-order (Case C) — 1 pre-order item');
    assert.equal(buildSummary(classification, true), 'Unnotified pre-order (Case C) — 1 pre-order item; identical-fit swap staged');
    assert.equal(
      buildSummary({ ...classification, leaks: [{ sku: 'A' }, { sku: 'B' }] }, false),
      'Unnotified pre-order (Case C) — 2 pre-order items',
    );
  });

  it('attachSwapData leaves Case C on the options email, never a done-for-you swap', async () => {
    compareResponses = {};
    compareCalls = [];
    compareResponses['14'] = { source: { available_colors: [{ color: 'Black', inventory: 9 }] }, alternatives: [] };
    compareResponses['S'] = { source: { available_colors: [{ color: 'Pink', inventory: 25 }] }, alternatives: [] };
    const [c] = await attachSwapData([{ classification }]);
    // Case C means other items are backordered too, so swapping the leak would
    // not unblock the order — the customer's choice matters more.
    assert.deepEqual(c.autoSwaps, []);
    assert.ok(c.alternatives.length > 0);
  });

  it('the recomposed body is the A/B/C template, with no SKUs in customer copy', () => {
    const body = composeBody({
      orderNumber: '33220',
      classification,
      alternatives: ['the Mia in Pink, size S'],
      autoSwaps: [],
      daysSinceOrder: 3,
    });
    assert.match(body, /Here's what I can do for the pre-order items specifically:/);
    assert.match(body, /Swap for the Mia in Pink, size S/);
    assert.doesNotMatch(body, /MIA-BLK-S|MIA-BLK-L/, 'raw SKUs must never reach customer copy');
    assert.doesNotMatch(body, /—/, 'no em dashes in customer copy');
  });
});
