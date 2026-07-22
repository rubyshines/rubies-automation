/**
 * Unit tests for the warehouse_hold MCP tool in lib/tools/orderNotes.js.
 *
 *   - unfulfilled / partially_fulfilled → hold placed.
 *   - in_progress → refuse (being picked/packed).
 *   - fulfilled / cancelled → refuse; error text must classify as 'impossible'
 *     in the backstop sweep (holdReconcile.classifyHoldResult) — a shipped
 *     order previously got a silent false-success hold (ticket 2700, #31533).
 *   - already held → idempotent success, no second Warehance write.
 *
 * Run: node --test customer-service/test/warehouseHold.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub Warehance client + Supabase before requiring the tool.
// ---------------------------------------------------------------------------

const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const warehanceClientPath = require.resolve('../../reports/lib/warehanceClient');
const shippingLookupPath = require.resolve('../lib/tools/shippingLookup');
const shopifyPath = require.resolve('../lib/shopify');

let stubOrder = null;
let setHoldCalls = [];
let lastSupabaseInsert = null;

require.cache[warehanceClientPath] = {
  id: warehanceClientPath, filename: warehanceClientPath, loaded: true,
  exports: {
    fetchOrderByNumber: async () => stubOrder,
    setWarehouseHold: async (id) => { setHoldCalls.push(id); },
    releaseWarehouseHold: async () => {},
    releaseAddressHold: async () => {},
    updateShippingMethod: async () => {},
    resolveShippingMethod: () => null,
    warehanceOrderUrl: (o) => `https://app.warehance.com/orders/${o.id}`,
  },
};

require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: () => ({
        insert: async (row) => { lastSupabaseInsert = row; return { error: null }; },
      }),
    }),
  },
};

require.cache[shippingLookupPath] = {
  id: shippingLookupPath, filename: shippingLookupPath, loaded: true,
  exports: { getShippingZone: async () => null },
};

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    getDraftOrderByName: async () => null,
    updateDraftOrderShipping: async () => null,
    getAdminUrl: () => '',
  },
};

const { handleWarehouseHold } = require('../lib/tools/orderNotes');
const { classifyHoldResult } = require('../lib/holdReconcile');

beforeEach(() => {
  stubOrder = null;
  setHoldCalls = [];
  lastSupabaseInsert = null;
});

describe('handleWarehouseHold', () => {
  it('places a hold on an unfulfilled order', async () => {
    stubOrder = { id: 1, fulfillment_status: 'unfulfilled', warehouse_hold: false };
    const r = await handleWarehouseHold({ order_number: 31485, reason: 'customer wants to modify' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /Warehouse hold placed/);
    assert.deepEqual(setHoldCalls, [1]);
    assert.match(lastSupabaseInsert.note, /customer wants to modify/);
    assert.equal(classifyHoldResult(r), 'placed');
  });

  it('places a hold on a partially_fulfilled order', async () => {
    stubOrder = { id: 2, fulfillment_status: 'partially_fulfilled', warehouse_hold: false };
    const r = await handleWarehouseHold({ order_number: 31485, reason: 'x' });
    assert.equal(r.isError, undefined);
    assert.deepEqual(setHoldCalls, [2]);
  });

  it('refuses an in_progress order without writing', async () => {
    stubOrder = { id: 3, fulfillment_status: 'in_progress', warehouse_hold: false };
    const r = await handleWarehouseHold({ order_number: 31485, reason: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /in progress/);
    assert.deepEqual(setHoldCalls, []);
    assert.equal(classifyHoldResult(r), 'impossible');
  });

  it('refuses a fulfilled (shipped) order without writing — sweep must classify impossible', async () => {
    stubOrder = { id: 4, fulfillment_status: 'fulfilled', warehouse_hold: false };
    const r = await handleWarehouseHold({ order_number: 31533, reason: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /shipped/);
    assert.deepEqual(setHoldCalls, []);
    assert.equal(lastSupabaseInsert, null);
    assert.equal(classifyHoldResult(r), 'impossible');
  });

  it('refuses a cancelled order without writing — sweep must classify impossible', async () => {
    stubOrder = { id: 5, fulfillment_status: 'cancelled', warehouse_hold: false };
    const r = await handleWarehouseHold({ order_number: 31485, reason: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /cancelled/);
    assert.deepEqual(setHoldCalls, []);
    assert.equal(classifyHoldResult(r), 'impossible');
  });

  it('is idempotent on an already-held order (success, no second write)', async () => {
    stubOrder = { id: 6, fulfillment_status: 'unfulfilled', warehouse_hold: true };
    const r = await handleWarehouseHold({ order_number: 31485, reason: 'x' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /already has a \*\*warehouse hold\*\*/);
    assert.deepEqual(setHoldCalls, []);
    assert.equal(classifyHoldResult(r), 'placed');
  });

  it("treats an order missing from Warehance as a retryable 'pending' for the sweep", async () => {
    stubOrder = null;
    const r = await handleWarehouseHold({ order_number: 31485, reason: 'x' });
    assert.equal(r.isError, true);
    assert.equal(classifyHoldResult(r), 'pending');
  });
});
