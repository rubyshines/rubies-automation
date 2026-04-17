/**
 * Unit tests for lib/tools/invoiceOrder.js — draft-order creation behavior.
 *
 * Run: node --test customer-service/test/invoiceOrder.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub shopify + productCache + resolveLineItems dependencies
// ---------------------------------------------------------------------------

const shopifyPath = require.resolve('../lib/shopify');
const productCachePath = require.resolve('../lib/productCache');
const resolveLineItemsPath = require.resolve('../lib/resolveLineItems');

let lastCreateDraftOrderArgs = null;
let createDraftOrderResponse = {
  id: 'gid://shopify/DraftOrder/999',
  name: 'D999',
  totalPrice: '0.00',
  invoiceUrl: 'https://rubyshines.com/draft/999',
};

function stubCreateDraftOrder(args) {
  lastCreateDraftOrderArgs = args;
  return Promise.resolve(createDraftOrderResponse);
}

function stubSendDraftOrderInvoice() {
  return Promise.resolve(createDraftOrderResponse);
}

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    createDraftOrder: stubCreateDraftOrder,
    sendDraftOrderInvoice: stubSendDraftOrderInvoice,
    normalizeGid: (id, type) => {
      if (typeof id === 'string' && id.startsWith('gid://')) return id;
      return `gid://shopify/${type}/${id}`;
    },
  },
};

// productCache stubs (referenced transitively by resolveLineItems in case it's not already cached)
require.cache[productCachePath] = {
  id: productCachePath,
  filename: productCachePath,
  loaded: true,
  exports: {
    searchProducts: () => [],
    getVariantById: () => null,
    getVariantBySku: () => null,
    getSiblingVariant: () => null,
  },
};

// Deterministic resolveLineItems stub — invoiceOrder doesn't care what's inside,
// only that it can pass the resolved items along to createDraftOrder.
require.cache[resolveLineItemsPath] = {
  id: resolveLineItemsPath,
  filename: resolveLineItemsPath,
  loaded: true,
  exports: {
    resolveLineItems: async (items) => items.map((it, i) => ({
      variantId: it.variant_id || `gid://shopify/ProductVariant/${100 + i}`,
      productTitle: 'TEST PRODUCT',
      variantTitle: 'Black / M',
      sku: it.sku || `test-sku-${i}`,
      price: '29.00',
      inventoryQuantity: 10,
      quantity: it.quantity || 1,
    })),
  },
};

const invoiceTools = require('../lib/tools/invoiceOrder');
const createInvoiceOrder = invoiceTools.find(t => t.name === 'create_invoice_order');

async function runHandler(args) {
  lastCreateDraftOrderArgs = null;
  return createInvoiceOrder.handler(args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create_invoice_order — validation', () => {
  it('rejects when no items are provided', async () => {
    const result = await runHandler({ customer_id: 'gid://shopify/Customer/1' });
    assert.match(result.content[0].text, /at least one exchange_item or paid_item/);
    assert.equal(lastCreateDraftOrderArgs, null);
  });
});

describe('create_invoice_order — preview mode (confirmed != true)', () => {
  it('returns a preview and does NOT create a draft order', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
    });
    assert.match(result.content[0].text, /Invoice Order Preview/);
    assert.match(result.content[0].text, /Free \(exchange order\)/);
    assert.equal(lastCreateDraftOrderArgs, null);
  });

  it('shows free-shipping messaging for mixed exchange + paid baskets', async () => {
    const result = await runHandler({
      customer_id: 'gid://shopify/Customer/1',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      paid_items: [{ sku: 'rub0002-M', quantity: 2 }],
    });
    assert.match(result.content[0].text, /Shipping: Free \(exchange order\)/);
  });
});

describe('create_invoice_order — confirmed mode', () => {
  beforeEach(() => {
    lastCreateDraftOrderArgs = null;
  });

  it('passes a free shipping line to createDraftOrder (regression for commit 58cca28)', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      confirmed: true,
    });
    assert.ok(lastCreateDraftOrderArgs, 'expected createDraftOrder to be called');
    assert.deepEqual(lastCreateDraftOrderArgs.shippingLine, {
      title: 'Free Shipping',
      price: '0.00',
    });
  });

  it('applies 100% exchange discount to exchange items', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 2 }],
      confirmed: true,
    });
    const exchangeLine = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(exchangeLine.quantity, 2);
    assert.deepEqual(exchangeLine.appliedDiscount, {
      title: 'Exchange',
      value: 100,
      valueType: 'PERCENTAGE',
    });
  });

  it('does NOT apply a discount to paid items', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      paid_items: [{ sku: 'rub0002-M', quantity: 1 }],
      confirmed: true,
    });
    const paidLine = lastCreateDraftOrderArgs.lineItems[0];
    assert.equal(paidLine.quantity, 1);
    assert.equal(paidLine.appliedDiscount, undefined);
  });

  it('orders exchange items before paid items in lineItems', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      paid_items: [{ sku: 'rub0002-M', quantity: 1 }],
      confirmed: true,
    });
    const [first, second] = lastCreateDraftOrderArgs.lineItems;
    assert.ok(first.appliedDiscount, 'first line should be the discounted exchange item');
    assert.equal(second.appliedDiscount, undefined);
  });

  it('tags draft orders with invoice + cs-mcp', async () => {
    await runHandler({
      customer_id: 'gid://shopify/Customer/42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      confirmed: true,
    });
    assert.deepEqual(lastCreateDraftOrderArgs.tags, ['invoice', 'cs-mcp']);
  });

  it('normalizes numeric customer_id to a Customer GID', async () => {
    await runHandler({
      customer_id: '42',
      exchange_items: [{ sku: 'rub0001-S', quantity: 1 }],
      confirmed: true,
    });
    assert.equal(lastCreateDraftOrderArgs.customerId, 'gid://shopify/Customer/42');
  });
});
