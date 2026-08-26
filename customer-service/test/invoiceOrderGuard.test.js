/**
 * create_invoice_order Phase 1 — duplicate-shipment guard, wired end to end.
 *
 * The pure detection logic is covered in liveOrderOverlap.test.js. What this
 * file exists for is the wiring: that the tool actually calls the lookup, that
 * the warning reaches the operator-visible preview text, and that the gate's
 * marker survives into the tool result. A guard that is correct but unreachable
 * is the failure mode this whole change is about.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');
const resolvePath = require.resolve('../lib/resolveLineItems');
const shippingLookupPath = require.resolve('../lib/tools/shippingLookup');

let customerOrders = [];
let lookupCalls = 0;
// The tool destructures getCustomerOrders at require time, so the failure case
// is driven through a flag rather than by swapping the export afterwards.
let lookupError = null;

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    normalizeGid: (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Customer/${id}`),
    getAdminUrl: (gid) => `https://admin.example/${String(gid).split('/').pop()}`,
    createDraftOrder: async () => ({
      id: 'gid://shopify/DraftOrder/999',
      name: '#D9999',
      totalPrice: '27.00',
    }),
    sendDraftOrderInvoice: async () => ({ name: '#D9999', invoiceUrl: 'https://invoice.example' }),
    getCustomerOrders: async () => {
      lookupCalls++;
      if (lookupError) throw new Error(lookupError);
      return { orders: customerOrders };
    },
    searchCustomers: async () => [],
  },
};

require.cache[resolvePath] = {
  id: resolvePath,
  filename: resolvePath,
  loaded: true,
  exports: {
    resolveLineItems: async (items) => items.map(i => ({
      variantId: `gid://shopify/ProductVariant/${i.sku}`,
      productTitle: i.sku,
      variantTitle: 'Black / M',
      sku: i.sku,
      price: '27.00',
      inventoryQuantity: 100,
      quantity: i.quantity || 1,
    })),
  },
};

require.cache[shippingLookupPath] = {
  id: shippingLookupPath,
  filename: shippingLookupPath,
  loaded: true,
  exports: { getShippingZone: async () => 'domestic', tools: [] },
};

const tools = require('../lib/tools/invoiceOrder');
const { LIVE_ORDER_OVERLAP_MARKER } = require('../lib/orderUtils');

const createInvoiceOrder = tools.find(t => t.name === 'create_invoice_order');
const runPhase1 = async (args) => {
  const r = await createInvoiceOrder.handler(args);
  return r.content[0].text;
};

const LIVE_ORDER = {
  name: '#32992',
  cancelledAt: null,
  displayFulfillmentStatus: 'UNFULFILLED',
  lineItems: [{ sku: 'SKY2-BLK-16T', quantity: 1, currentQuantity: 1 }],
};

test('warns when a free line is still on the customer\'s unshipped order', async () => {
  customerOrders = [LIVE_ORDER];
  const text = await runPhase1({
    customer_id: '11877400674582',
    exchange_items: [{ sku: 'SKY2-BLK-16T', quantity: 1 }],
    paid_items: [{ sku: 'MPAD-SND-M', quantity: 1 }],
  });
  assert.ok(text.includes(LIVE_ORDER_OVERLAP_MARKER), 'marker must reach the tool result for the gate');
  assert.ok(text.includes('#32992'));
  assert.ok(/edit_order/.test(text));
  // The warning leads — an operator skimming the preview sees it before the
  // draft looks legitimate.
  assert.ok(text.indexOf(LIVE_ORDER_OVERLAP_MARKER) < text.indexOf('Invoice Draft Order Created'));
});

test('the preview still renders normally around the warning', async () => {
  customerOrders = [LIVE_ORDER];
  const text = await runPhase1({
    customer_id: '11877400674582',
    exchange_items: [{ sku: 'SKY2-BLK-16T', quantity: 1 }],
    paid_items: [{ sku: 'MPAD-SND-M', quantity: 1 }],
  });
  assert.ok(text.includes('**Draft Order:** #D9999'));
  assert.ok(text.includes('**Exchange items (free):**'));
  assert.ok(text.includes('**Paid items:**'));
  assert.ok(text.includes('confirmed=true'));
});

test('ordinary exchange off a shipped order: no warning, no marker', async () => {
  customerOrders = [{ ...LIVE_ORDER, displayFulfillmentStatus: 'FULFILLED' }];
  const text = await runPhase1({
    customer_id: '11877400674582',
    exchange_items: [{ sku: 'SKY2-BLK-16T', quantity: 1 }],
  });
  assert.ok(!text.includes(LIVE_ORDER_OVERLAP_MARKER));
  assert.ok(text.startsWith('**Invoice Draft Order Created'));
});

test('paid_items alone (invoice_kept_items) skips the lookup entirely', async () => {
  customerOrders = [LIVE_ORDER];
  const before = lookupCalls;
  await runPhase1({
    customer_id: '11877400674582',
    paid_items: [{ sku: 'SKY2-BLK-16T', quantity: 1 }],
  });
  assert.equal(lookupCalls, before, 'no exchange_items means nothing to duplicate');
});

test('a failed lookup is surfaced, never silently treated as clean', async () => {
  lookupError = 'Shopify 503';
  try {
    const text = await runPhase1({
      customer_id: '11877400674582',
      exchange_items: [{ sku: 'SKY2-BLK-16T', quantity: 1 }],
    });
    assert.ok(text.includes('Could not check for duplicate live orders'));
    assert.ok(text.includes('Shopify 503'));
    // Not a hard block: the draft is still created and the operator decides.
    assert.ok(text.includes('#D9999'));
  } finally {
    lookupError = null;
  }
});

test('phase 2 is untouched by the guard', async () => {
  const r = await createInvoiceOrder.handler({
    customer_id: '11877400674582',
    confirmed: true,
    draft_order_id: 'gid://shopify/DraftOrder/999',
  });
  assert.ok(r.content[0].text.includes('**Invoice Sent**'));
});
