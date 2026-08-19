/**
 * edit_order — the shipping address written to Shopify is the COMPLETE merged
 * address, not just the fields the operator named.
 *
 * A partial MailingAddressInput leaves the result to Shopify's merge semantics,
 * which is how a corrected street can keep the previous street's apartment line
 * or lose the recipient name. Both are silent: the order looks edited and ships
 * to somewhere the customer never gave us.
 *
 * Stubbing follows the resolveLineItems.test.js pattern: seed require.cache
 * before requiring the module under test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };

// The address currently on the order: a house, with a delivery instruction that
// only makes sense for that house.
const CURRENT_ADDRESS = {
  firstName: 'Neve',
  lastName: 'Graham',
  address1: '320 Woodview Ct',
  address2: 'Right side with deck',
  city: 'Tahoe City',
  province: 'California',
  countryCodeV2: 'US',
  zip: '96145',
};

// Captures what edit_order actually sent to Shopify.
let sentAddress = null;

stub(path.join(LIB, 'shopify.js'), {
  getOrderForEdit: async () => ({
    id: 'gid://shopify/Order/1',
    name: '#32911',
    displayFulfillmentStatus: 'UNFULFILLED',
    shippingAddress: { ...CURRENT_ADDRESS },
    shippingLines: [{ title: 'Free US Standard Shipping' }],
  }),
  updateOrderShippingAddress: async (_id, addr) => {
    sentAddress = addr;
    return { shippingAddress: { ...addr, country: 'United States' } };
  },
  getAdminUrl: () => 'https://admin.example/orders/1',
  orderEditBegin: async () => ({}), orderEditSetQuantity: async () => ({}),
  orderEditAddVariant: async () => ({}), orderEditAddLineItemDiscount: async () => ({}),
  orderEditCommit: async () => ({}), sendOrderInvoice: async () => ({}),
  calculateRefund: async () => ({}), createRefund: async () => ({}),
  normalizeGid: (x) => x, shopifyGraphQL: async () => ({}),
});
stub(path.join(LIB, 'productCache.js'), { searchProducts: async () => [] });
stub(path.join(__dirname, '..', '..', 'reports', 'lib', 'warehanceClient.js'), {
  fetchOrderByNumber: async () => null,
  releaseWarehouseHold: async () => {}, releaseAddressHold: async () => {},
  getHoldReasons: () => [], setWarehouseHold: async () => ({}),
  warehanceOrderUrl: () => 'https://wh.example/1',
  resolveShippingMethod: async () => null, updateShippingMethod: async () => ({}),
});
stub(path.join(LIB, 'addressValidation.js'), { validateShippingAddress: async () => ({ ok: true, country_code: 'US', reason: 'ok' }) });
stub(path.join(LIB, 'tools', 'shippingLookup.js'), { getShippingZone: async () => 'us' });
stub(path.join(LIB, 'tools', 'adminTools.js'), { writeAuditEntry: () => {} });

const { handleEditOrder } = require('../lib/tools/editOrder');

async function editWith(shipping_address) {
  sentAddress = null;
  const res = await handleEditOrder({ order_number: '32911', shipping_address });
  return { sent: sentAddress, text: res.content[0].text };
}

test('a corrected street does not carry the old street\'s address2', async () => {
  const { sent } = await editWith({
    address1: 'PO Box 57', city: 'Tahoe City', province: 'CA', country: 'US', zip: '96145',
  });
  assert.equal(sent.address1, 'PO Box 57');
  assert.equal(sent.address2, '', '"Right side with deck" belongs to the house, not the PO box');
});

test('the recipient name survives an address-only change', async () => {
  // The operator changed the street and said nothing about the name. Sending a
  // partial address risks Shopify dropping the name off the label entirely.
  const { sent } = await editWith({ address1: 'PO Box 57', city: 'Tahoe City', province: 'CA', country: 'US', zip: '96145' });
  assert.equal(sent.firstName, 'Neve');
  assert.equal(sent.lastName, 'Graham');
});

test('an explicit recipient name is written verbatim, digits included', async () => {
  const { sent } = await editWith({
    first_name: 'Neve', last_name: 'Graham57',
    address1: 'PO Box 57', city: 'Tahoe City', province: 'CA', country: 'US', zip: '96145',
  });
  assert.equal(sent.firstName, 'Neve');
  assert.equal(sent.lastName, 'Graham57');
});

test('every address field is sent, not only the named ones', async () => {
  const { sent } = await editWith({ zip: '96146' });
  for (const key of ['firstName', 'lastName', 'address1', 'address2', 'city', 'province', 'zip', 'countryCode']) {
    assert.ok(key in sent, `${key} must be present in the address written to Shopify`);
  }
  assert.equal(sent.zip, '96146');
  assert.equal(sent.address1, '320 Woodview Ct', 'unchanged fields keep their current value');
});

test('country holds at the order\'s existing value when the override omits it', async () => {
  const { sent } = await editWith({ address1: 'PO Box 57' });
  assert.equal(sent.countryCode, 'US');
});

test('a spelled-out country is normalized to the ISO code Shopify requires', async () => {
  const { sent } = await editWith({ address1: 'PO Box 57', country: 'United States' });
  assert.equal(sent.countryCode, 'US');
});

test('the operator is shown the merged address, name first', async () => {
  // The preview is the only place to catch a wrong name before it prints.
  const { text } = await editWith({
    first_name: 'Neve', last_name: 'Graham57',
    address1: 'PO Box 57', city: 'Tahoe City', province: 'CA', country: 'US', zip: '96145',
  });
  assert.match(text, /Neve Graham57/);
  assert.match(text, /PO Box 57/);
  assert.ok(!/Right side with deck/.test(text), 'the dropped address2 must not appear in the preview');
});
