/**
 * edit_order — address-only update, Warehance hold handling.
 *
 * Regression cover for a live miss on #32930 (2026-08-11): the path released
 * `warehouse_hold`, never touched `address_hold`, and told the operator "the
 * order can ship". Warehance immediately after read
 * `has_hold: true, address_hold: true, ready_to_ship: false`, so the order sat
 * stuck while the report showed it handled.
 *
 * Stubbing follows the resolveLineItems.test.js pattern: seed require.cache
 * before requiring the module under test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };

// --- mutable stub state, reset per test -------------------------------------
const state = {
  whOrder: null,
  whAfter: null,
  validate: { ok: true, country_code: 'RO', reason: 'ok' },
  released: [],
};

stub(path.join(LIB, 'shopify.js'), {
  getOrderForEdit: async () => ({
    id: 'gid://shopify/Order/1',
    name: '#32930',
    displayFulfillmentStatus: 'UNFULFILLED',
    shippingAddress: { countryCodeV2: 'RO' },
    shippingLines: [{ title: 'International Standard' }],
  }),
  updateOrderShippingAddress: async (_id, addr) => ({
    shippingAddress: {
      address1: addr.address1, address2: addr.address2, city: addr.city,
      province: addr.province, zip: addr.zip, country: 'Romania',
    },
  }),
  getAdminUrl: () => 'https://admin.example/orders/1',
  orderEditBegin: async () => ({}), orderEditSetQuantity: async () => ({}),
  orderEditAddVariant: async () => ({}), orderEditAddLineItemDiscount: async () => ({}),
  orderEditCommit: async () => ({}), sendOrderInvoice: async () => ({}),
  calculateRefund: async () => ({}), createRefund: async () => ({}),
  normalizeGid: (x) => x, shopifyGraphQL: async () => ({}),
});
stub(path.join(LIB, 'productCache.js'), { searchProducts: async () => [] });
stub(path.join(__dirname, '..', '..', 'reports', 'lib', 'warehanceClient.js'), {
  fetchOrderByNumber: async () => (state.released.length ? state.whAfter : state.whOrder),
  releaseWarehouseHold: async () => { state.released.push('warehouse_hold'); },
  releaseAddressHold: async () => { state.released.push('address_hold'); },
  getHoldReasons: (o) => {
    if (!o || !o.has_hold) return [];
    return ['address_hold', 'fraud_hold', 'payment_hold', 'warehouse_hold', 'allocation_hold', 'store_hold'].filter(k => o[k]);
  },
  setWarehouseHold: async () => ({}), warehanceOrderUrl: () => 'https://wh.example/1',
  resolveShippingMethod: async () => null, updateShippingMethod: async () => ({}),
});
stub(path.join(LIB, 'addressValidation.js'), { validateShippingAddress: async () => state.validate });
stub(path.join(LIB, 'tools', 'shippingLookup.js'), { getShippingZone: async () => 'ddp' });
stub(path.join(LIB, 'tools', 'adminTools.js'), { writeAuditEntry: () => {} });
// Only toCountryCode is stubbed; the formatting helpers are pure, so keep the
// real ones rather than letting a partial stub silently return undefined.
const realAddressUtils = require('../lib/addressUtils');
stub(path.join(LIB, 'addressUtils.js'), {
  ...realAddressUtils,
  toCountryCode: (c) => (c === 'Romania' || c === 'RO' ? 'RO' : c),
});

const { handleEditOrder } = require('../lib/tools/editOrder');

const ADDR = { address1: 'Strada Independentei 102', city: 'Brasov', province: 'Brasov', country: 'RO', zip: '500157' };

function reset({ holds = {}, validate = { ok: true, country_code: 'RO', reason: 'ok' } } = {}) {
  state.released = [];
  state.validate = validate;
  const has = Object.values(holds).some(Boolean);
  state.whOrder = { id: 99, has_hold: has, ...holds };
  // After releases: whatever was NOT released stays set.
  state.whAfter = null;
}
function applyReleases() {
  const after = { ...state.whOrder };
  for (const r of state.released) after[r] = false;
  after.has_hold = ['address_hold', 'fraud_hold', 'payment_hold', 'warehouse_hold', 'allocation_hold', 'store_hold'].some(k => after[k]);
  state.whAfter = after;
}
async function run() {
  const res = await handleEditOrder({ order_number: '32930', shipping_address: ADDR });
  applyReleases();
  // second pass so the post-update re-read sees the released state
  state.released = [];
  const final = await handleEditOrder({ order_number: '32930', shipping_address: ADDR });
  return { first: res.content[0].text, final: final.content[0].text };
}

test('address hold is released when the new address validates', async () => {
  reset({ holds: { address_hold: true, warehouse_hold: true } });
  await handleEditOrder({ order_number: '32930', shipping_address: ADDR });
  assert.ok(state.released.includes('address_hold'), 'address_hold must be released');
  assert.ok(state.released.includes('warehouse_hold'), 'warehouse_hold must still be released');
});

test('address hold is NOT released when the new address fails validation', async () => {
  reset({ holds: { address_hold: true }, validate: { ok: false, country_code: null, reason: 'partial_match' } });
  const res = await handleEditOrder({ order_number: '32930', shipping_address: ADDR });
  const text = res.content[0].text;
  assert.ok(!state.released.includes('address_hold'), 'must not release an unvalidated address');
  assert.match(text, /STILL HELD/);
  assert.match(text, /will NOT ship/);
});

test('never claims the order can ship while a hold remains (regression for #32930)', async () => {
  // Only warehouse_hold is releasable here; the address hold survives because
  // validation failed. The output must say so rather than implying it can ship.
  reset({ holds: { address_hold: true, warehouse_hold: true }, validate: { ok: false, country_code: null, reason: 'ZERO_RESULTS' } });
  const res = await handleEditOrder({ order_number: '32930', shipping_address: ADDR });
  applyReleases();
  state.released = [];
  const again = await handleEditOrder({ order_number: '32930', shipping_address: ADDR });
  const text = again.content[0].text;
  assert.match(text, /still on hold in Warehance/i);
  assert.match(text, /address_hold/);
  assert.ok(!/No holds remaining/.test(text));
  assert.ok(!/so the order can ship/.test(res.content[0].text.split('Address hold')[0]));
});

test('reports a clean bill only when Warehance really has no holds left', async () => {
  reset({ holds: { address_hold: true } });
  const { final } = await run();
  assert.match(final, /No holds remaining/);
});

test('surfaces hold kinds this path does not manage', async () => {
  // fraud/payment holds are not ours to clear, but the operator must be told
  // the order is not going anywhere.
  reset({ holds: { fraud_hold: true } });
  const res = await handleEditOrder({ order_number: '32930', shipping_address: ADDR });
  const text = res.content[0].text;
  assert.match(text, /still on hold in Warehance/i);
  assert.match(text, /fraud_hold/);
});
