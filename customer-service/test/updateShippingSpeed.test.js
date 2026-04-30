/**
 * Unit tests for the update_shipping_speed MCP tool in lib/tools/orderNotes.js.
 *
 *   - US standard / expedited → swap Warehance method via the right ID.
 *   - Non-US expedited → set Warehance method to Fedex + Incoterms reminder.
 *   - Non-US standard → return Warehance link (no method update).
 *   - in_progress → refuse with an error.
 *
 * Run: node --test customer-service/test/updateShippingSpeed.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub Warehance client + Supabase before requiring the tool.
// ---------------------------------------------------------------------------

const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const warehanceClientPath = require.resolve('../../reports/lib/warehanceClient');
const shippingLookupPath = require.resolve('../lib/tools/shippingLookup');

let stubOrder = null;
let lastUpdateShippingMethod = null;
let lastSupabaseInsert = null;
let stubZone = null;

require.cache[shippingLookupPath] = {
  id: shippingLookupPath, filename: shippingLookupPath, loaded: true,
  exports: {
    getShippingZone: async () => stubZone,
  },
};

require.cache[warehanceClientPath] = {
  id: warehanceClientPath, filename: warehanceClientPath, loaded: true,
  exports: {
    fetchOrderByNumber: async () => stubOrder,
    releaseAddressHold: async () => ({}),
    setWarehouseHold: async () => ({}),
    releaseWarehouseHold: async () => ({}),
    updateShippingMethod: async (orderId, methodId) => {
      lastUpdateShippingMethod = { orderId, methodId };
      return {};
    },
    warehanceOrderUrl: (o) => o ? `https://staging.warehance.com/orders/${o.id}` : null,
  },
};

require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: () => ({
        insert: async (row) => { lastSupabaseInsert = row; return {}; },
      }),
    }),
  },
};

const tools = require('../lib/tools/orderNotes');
const updateShippingSpeed = tools.find(t => t.name === 'update_shipping_speed');

function makeOrder({ country = 'US', status = 'unfulfilled', id = 100, orderNumber = 'TEST-1' } = {}) {
  return {
    id,
    order_number: `#${orderNumber}`,
    fulfillment_status: status,
    ship_to_address: { country_code: country },
  };
}

async function run(args) {
  lastUpdateShippingMethod = null;
  lastSupabaseInsert = null;
  return updateShippingSpeed.handler(args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('update_shipping_speed — input validation', () => {
  beforeEach(() => { stubOrder = makeOrder(); });

  it('rejects an invalid speed value', async () => {
    const result = await run({ order_number: 1, speed: 'overnight', reason: 'test' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid speed/);
    assert.equal(lastUpdateShippingMethod, null);
  });

  it('errors if the order is not found', async () => {
    stubOrder = null;
    const result = await run({ order_number: 9999, speed: 'standard', reason: 'test' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found in Warehance/);
  });

  it('refuses to update when fulfillment_status is in_progress', async () => {
    stubOrder = makeOrder({ status: 'in_progress' });
    const result = await run({ order_number: 1, speed: 'expedited', reason: 'rush' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already \*\*in progress\*\*/);
    assert.equal(lastUpdateShippingMethod, null);
  });
});

describe('update_shipping_speed — US orders', () => {
  beforeEach(() => { stubOrder = makeOrder({ country: 'US', id: 42 }); });

  it('US standard sets Warehance method to US Standard (id 231185182340)', async () => {
    const result = await run({ order_number: 1, speed: 'standard', reason: 'downgrade' });
    assert.deepEqual(lastUpdateShippingMethod, { orderId: 42, methodId: 231185182340 });
    assert.match(result.content[0].text, /US Standard Shipping/);
  });

  it('US expedited sets Warehance method to US Expedited (id 231185182342)', async () => {
    const result = await run({ order_number: 1, speed: 'expedited', reason: 'rush' });
    assert.deepEqual(lastUpdateShippingMethod, { orderId: 42, methodId: 231185182342 });
    assert.match(result.content[0].text, /US Expedited Shipping/);
  });

  it('logs the change to order_alert_notes', async () => {
    await run({ order_number: 1, speed: 'expedited', reason: 'customer paid for upgrade' });
    assert.ok(lastSupabaseInsert);
    assert.match(lastSupabaseInsert.note, /US Expedited Shipping/);
    assert.match(lastSupabaseInsert.note, /customer paid for upgrade/);
  });
});

describe('update_shipping_speed — non-US orders', () => {
  it('non-US expedited sets Warehance method to Fedex (id 231185182476) and warns about Incoterms', async () => {
    stubOrder = makeOrder({ country: 'CA', id: 77 });
    const result = await run({ order_number: 1, speed: 'expedited', reason: 'urgent' });
    assert.deepEqual(lastUpdateShippingMethod, { orderId: 77, methodId: 231185182476 });
    assert.match(result.content[0].text, /Fedex/);
    assert.match(result.content[0].text, /Verify Incoterms/);
  });

  it('non-US standard for Canada/DDP zone sets Warehance method to Passport DDP (id 231185182424)', async () => {
    stubOrder = makeOrder({ country: 'CA', id: 77 });
    stubZone = 'canada';
    const result = await run({ order_number: 1, speed: 'standard', reason: 'downgrade' });
    assert.deepEqual(lastUpdateShippingMethod, { orderId: 77, methodId: 231185182424 });
    assert.match(result.content[0].text, /Passport DDP/);
  });

  it('non-US standard for a DDP-zone country (e.g. AU) sets Warehance method to Passport DDP', async () => {
    stubOrder = makeOrder({ country: 'AU', id: 78 });
    stubZone = 'ddp';
    await run({ order_number: 1, speed: 'standard', reason: 'downgrade' });
    assert.equal(lastUpdateShippingMethod.methodId, 231185182424);
  });

  it('non-US standard for a DDU-zone country (e.g. AR) sets Warehance method to Passport DDU (id 231185182425)', async () => {
    stubOrder = makeOrder({ country: 'AR', id: 79 });
    stubZone = 'ddu';
    await run({ order_number: 1, speed: 'standard', reason: 'downgrade' });
    assert.equal(lastUpdateShippingMethod.methodId, 231185182425);
  });

  it('non-US standard with unknown zone falls back to Passport DDU', async () => {
    stubOrder = makeOrder({ country: 'XX', id: 80 });
    stubZone = null;
    await run({ order_number: 1, speed: 'standard', reason: 'downgrade' });
    assert.equal(lastUpdateShippingMethod.methodId, 231185182425);
  });

  it('non-US expedited works for any non-US country (e.g. GB, AU)', async () => {
    stubOrder = makeOrder({ country: 'GB', id: 88 });
    await run({ order_number: 1, speed: 'expedited', reason: 'rush' });
    assert.equal(lastUpdateShippingMethod.methodId, 231185182476);

    stubOrder = makeOrder({ country: 'AU', id: 99 });
    await run({ order_number: 1, speed: 'expedited', reason: 'rush' });
    assert.equal(lastUpdateShippingMethod.methodId, 231185182476);
  });
});
