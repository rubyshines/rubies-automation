/**
 * Unit tests for lib/merchandising/preOrderSync.js
 *
 * Run: node --test customer-service/test/preOrderSync.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computePreOrderState, syncPreOrders } = require('../lib/merchandising/preOrderSync');

const TODAY = '2026-06-24';

describe('computePreOrderState', () => {
  it('keeps only future-dated arrivals; earliest date + total upcoming qty', () => {
    const incoming = new Map([
      ['BB-BLK-S', { incoming: [
        { date: '2026-07-30', quantity: 100 },
        { date: '2026-09-15', quantity: 50 },
      ] }],
    ]);
    const out = computePreOrderState(incoming, TODAY);
    assert.deepEqual(out.get('BB-BLK-S'), { date: '2026-07-30', incoming: 150 });
  });

  it('excludes a SKU whose only arrivals are in the past', () => {
    const incoming = new Map([
      ['OLD-SKU', { incoming: [{ date: '2026-05-01', quantity: 80 }] }],
    ]);
    const out = computePreOrderState(incoming, TODAY);
    assert.equal(out.has('OLD-SKU'), false);
  });

  it('mixes past + future: ignores past, sums only future', () => {
    const incoming = new Map([
      ['MIX', { incoming: [
        { date: '2026-05-01', quantity: 80 },   // past, ignored
        { date: '2026-08-01', quantity: 40 },
        { date: '2026-08-20', quantity: 10 },
      ] }],
    ]);
    const out = computePreOrderState(incoming, TODAY);
    assert.deepEqual(out.get('MIX'), { date: '2026-08-01', incoming: 50 });
  });

  it('treats an arrival dated today as still upcoming (inclusive)', () => {
    const incoming = new Map([
      ['TODAY', { incoming: [{ date: TODAY, quantity: 5 }] }],
    ]);
    const out = computePreOrderState(incoming, TODAY);
    assert.deepEqual(out.get('TODAY'), { date: TODAY, incoming: 5 });
  });

  it('ignores zero / negative quantities', () => {
    const incoming = new Map([
      ['Z', { incoming: [{ date: '2026-08-01', quantity: 0 }, { date: '2026-09-01', quantity: -3 }] }],
    ]);
    const out = computePreOrderState(incoming, TODAY);
    assert.equal(out.has('Z'), false);
  });
});

// ---------------------------------------------------------------------------
// syncPreOrders plan-building (dry run, injected deps — no network)
// ---------------------------------------------------------------------------

function makeSupabase(variantRows) {
  // Minimal stub supporting .from('product_variants').select(...).range(...)
  return {
    from() {
      return {
        select() {
          return {
            range(start) {
              // single page
              return Promise.resolve({ data: start === 0 ? variantRows : [], error: null });
            },
          };
        },
      };
    },
  };
}

const VARIANTS = [
  { sku: 'MPAD-BLK-S', shopify_variant_id: 'v1', shopify_product_id: 'p1', pre_order_incoming: null, pre_order_date: null },
  { sku: 'MPAD-BLK-M', shopify_variant_id: 'v2', shopify_product_id: 'p1', pre_order_incoming: 20, pre_order_date: '2026-07-30' },
  { sku: 'SWS-BLK-L', shopify_variant_id: 'v3', shopify_product_id: 'p2', pre_order_incoming: null, pre_order_date: null },
  { sku: 'OLD-BLK-XL', shopify_variant_id: 'v4', shopify_product_id: 'p3', pre_order_incoming: 5, pre_order_date: '2026-05-01' },
];

function run(incomingBySku, opts = {}) {
  return syncPreOrders({
    dryRun: true,
    today: TODAY,
    ...opts,
    deps: {
      fetchIncomingOrders: async () => incomingBySku,
      supabase: makeSupabase(VARIANTS),
    },
  });
}

describe('syncPreOrders (dry run)', () => {
  it('sets a new pre-order, updates a changed one, clears an expired one', async () => {
    const incoming = new Map([
      ['MPAD-BLK-S', { incoming: [{ date: '2026-08-01', quantity: 30 }] }], // new
      ['MPAD-BLK-M', { incoming: [{ date: '2026-09-01', quantity: 99 }] }], // changed
      // OLD-BLK-XL absent from sheet AND already past-dated -> cleared
    ]);
    const r = await run(incoming);
    assert.equal(r.dryRun, true);

    const setSkus = r.set.map(o => o.sku).sort();
    assert.deepEqual(setSkus, ['MPAD-BLK-M', 'MPAD-BLK-S']);

    const newOne = r.set.find(o => o.sku === 'MPAD-BLK-S');
    assert.deepEqual({ date: newOne.date, incoming: newOne.incoming }, { date: '2026-08-01', incoming: 30 });

    const clearedSkus = r.cleared.map(o => o.sku);
    assert.deepEqual(clearedSkus, ['OLD-BLK-XL']);
  });

  it('skips a variant whose web state already matches the sheet', async () => {
    const incoming = new Map([
      ['MPAD-BLK-M', { incoming: [{ date: '2026-07-30', quantity: 20 }] }], // identical to current
    ]);
    const r = await run(incoming);
    assert.equal(r.set.length, 0);
    // MPAD-BLK-M still desired -> not cleared; OLD-BLK-XL not in filter scope here (no filter) -> cleared
    assert.deepEqual(r.cleared.map(o => o.sku), ['OLD-BLK-XL']);
  });

  it('scopes both set and clear to a SKU prefix filter', async () => {
    const incoming = new Map([
      ['MPAD-BLK-S', { incoming: [{ date: '2026-08-01', quantity: 30 }] }],
      ['MPAD-BLK-M', { incoming: [{ date: '2026-07-30', quantity: 20 }] }], // unchanged, keeps it
    ]);
    const r = await run(incoming, { skuFilter: 'MPAD' });
    assert.deepEqual(r.set.map(o => o.sku), ['MPAD-BLK-S']);
    // OLD-BLK-XL is expired but outside the MPAD filter -> NOT cleared
    assert.equal(r.cleared.length, 0);
  });

  it('reports a sheet SKU with no matching catalog variant as skipped', async () => {
    const incoming = new Map([
      ['GHOST-SKU', { incoming: [{ date: '2026-08-01', quantity: 10 }] }],
    ]);
    const r = await run(incoming);
    assert.deepEqual(r.skipped, [{ sku: 'GHOST-SKU', reason: 'no matching variant in catalog' }]);
    assert.equal(r.set.length, 0);
  });
});
