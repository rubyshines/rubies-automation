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
const shopifyPath = require.resolve('../lib/shopify');

// Grab the REAL pure matcher before stubbing the module, so these tests
// exercise the actual zone+speed routing rule against the live method list.
const { pickShippingMethod } = require('../../reports/lib/warehanceClient');
delete require.cache[warehanceClientPath];

// Live method list (names + IDs as configured in Warehance, 2026-04-30).
const LIVE_METHODS = [
  { id: 231185182340, name: 'US Standard Shipping' },
  { id: 231185182342, name: 'US Expedited Shipping' },
  { id: 231185182476, name: 'Fedex' },
  { id: 231185182424, name: 'Passport DDP' },
  { id: 231185182425, name: 'Passport DDU' },
];

let stubOrder = null;
let lastUpdateShippingMethod = null;
let lastSupabaseInsert = null;
let stubZone = null;
let stubDraft = null;
let lastDraftShippingUpdate = null;

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    getDraftOrderByName: async (name) => stubDraft && stubDraft.name === name ? stubDraft : null,
    updateDraftOrderShipping: async (id, input) => {
      lastDraftShippingUpdate = { id, input };
      return { id, name: stubDraft?.name, shippingLine: input };
    },
    getAdminUrl: (gid) => `https://admin.shopify.com/store/rubyshines/${gid}`,
  },
};

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
    resolveShippingMethod: async ({ zone, speed }) => pickShippingMethod(LIVE_METHODS, zone, speed),
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
  it('non-US expedited sets Warehance method to Fedex (id 231185182476)', async () => {
    stubOrder = makeOrder({ country: 'CA', id: 77 });
    const result = await run({ order_number: 1, speed: 'expedited', reason: 'urgent' });
    assert.deepEqual(lastUpdateShippingMethod, { orderId: 77, methodId: 231185182476 });
    assert.match(result.content[0].text, /Fedex/);
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

describe('update_shipping_speed — draft orders', () => {
  beforeEach(() => {
    stubOrder = null;
    stubDraft = null;
    lastDraftShippingUpdate = null;
    stubZone = null;
  });

  it('routes "D6720"-style names to the draft path and retitles the shipping line', async () => {
    stubZone = 'ddp';
    stubDraft = {
      id: 'gid://shopify/DraftOrder/6720',
      name: 'D6720',
      status: 'OPEN',
      shippingAddress: { country: 'Australia', countryCodeV2: 'AU' },
      shippingLine: { title: 'Expedited International Shipping - All Duties and Import Fees Included', price: '0.00' },
    };
    const result = await run({ order_number: 'D6720', speed: 'standard', reason: 'Customer asked to downgrade' });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(lastDraftShippingUpdate.id, 'gid://shopify/DraftOrder/6720');
    assert.equal(
      lastDraftShippingUpdate.input.title,
      'Free International Shipping - All Duties and Import Fees Included'
    );
    assert.match(result.content[0].text, /Draft shipping updated/);
  });

  it('falls back to draft lookup when a numeric order is not in Warehance', async () => {
    stubOrder = null;
    stubZone = 'us';
    stubDraft = {
      id: 'gid://shopify/DraftOrder/9999',
      name: 'D9999',
      status: 'OPEN',
      shippingAddress: { country: 'United States', countryCodeV2: 'US' },
      shippingLine: { title: 'US Expedited Shipping', price: '0.00' },
    };
    const result = await run({ order_number: 9999, speed: 'standard', reason: 'switching back to ground' });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(lastDraftShippingUpdate.input.title, 'Free US Standard Shipping');
  });

  it('refuses when the draft has already been completed', async () => {
    stubDraft = {
      id: 'gid://shopify/DraftOrder/6720',
      name: 'D6720',
      status: 'COMPLETED',
      shippingAddress: { country: 'AU' },
      shippingLine: { title: 'Free International Shipping - All Duties and Import Fees Included' },
    };
    const result = await run({ order_number: 'D6720', speed: 'standard', reason: 'too late' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already been completed/);
    assert.equal(lastDraftShippingUpdate, null);
  });

  it('no-ops when the draft is already on the requested speed', async () => {
    stubZone = 'ddp';
    stubDraft = {
      id: 'gid://shopify/DraftOrder/6720',
      name: 'D6720',
      status: 'OPEN',
      shippingAddress: { country: 'Australia', countryCodeV2: 'AU' },
      shippingLine: { title: 'Free International Shipping - All Duties and Import Fees Included', price: '0.00' },
    };
    const result = await run({ order_number: 'D6720', speed: 'standard', reason: 'already on it' });
    assert.match(result.content[0].text, /already on \*\*Free International Shipping/);
    assert.equal(lastDraftShippingUpdate, null);
  });

  it('returns an error when the draft is not found', async () => {
    stubDraft = null;
    const result = await run({ order_number: 'D404', speed: 'standard', reason: 'oops' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Draft order D404 not found/);
  });
});
