/**
 * Unit tests for flattenLineItemsKeepingRefunds (customer-service/lib/shopify.js).
 *
 * Fully-refunded line items get currentQuantity=0 from Shopify (even
 * NO_RESTOCK) and must stay visible (flagged _refunded); order-edit removals
 * (currentQuantity=0, no refund record) must be dropped.
 *
 * Run: node --test customer-service/test/flattenLineItems.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { flattenLineItemsKeepingRefunds } = require('../lib/shopify');

function orderNode({ items, refunds = [] }) {
  return {
    lineItems: { edges: items.map(node => ({ node })) },
    refunds: refunds.map(r => ({
      refundLineItems: {
        edges: r.map(node => ({ node })),
      },
    })),
  };
}

describe('flattenLineItemsKeepingRefunds', () => {
  it('keeps untouched and still-in-order items', () => {
    const { lineItems } = flattenLineItemsKeepingRefunds(orderNode({
      items: [
        { title: 'AJ', sku: 'AJ-BLK-10', variantTitle: 'Black / 10', quantity: 1, currentQuantity: 1 },
        { title: 'Ruby', sku: 'RB-BLK-M', variantTitle: 'Black / M', quantity: 2, currentQuantity: null },
      ],
    }));
    assert.equal(lineItems.length, 2);
    assert.ok(lineItems.every(li => !li._refunded));
  });

  it('keeps a fully-refunded item and flags it _refunded', () => {
    const { lineItems, refundedBySkuVariant } = flattenLineItemsKeepingRefunds(orderNode({
      items: [
        { title: 'AJ', sku: 'AJ-BLK-10', variantTitle: 'Black / 10', quantity: 1, currentQuantity: 0 },
        { title: 'Ruby', sku: 'RB-BLK-M', variantTitle: 'Black / M', quantity: 1, currentQuantity: 1 },
      ],
      refunds: [[{ quantity: 1, lineItem: { sku: 'AJ-BLK-10', variantTitle: 'Black / 10' } }]],
    }));
    assert.equal(lineItems.length, 2);
    const refunded = lineItems.find(li => li.sku === 'AJ-BLK-10');
    assert.equal(refunded._refunded, true);
    assert.equal(lineItems.find(li => li.sku === 'RB-BLK-M')._refunded, undefined);
    assert.equal(refundedBySkuVariant['AJ-BLK-10::Black / 10'], 1);
  });

  it('drops an order-edit removal (currentQuantity=0, no refund record)', () => {
    const { lineItems } = flattenLineItemsKeepingRefunds(orderNode({
      items: [
        { title: 'AJ', sku: 'AJ-BLK-10', variantTitle: 'Black / 10', quantity: 1, currentQuantity: 0 },
      ],
    }));
    assert.deepEqual(lineItems, []);
  });

  it('sums refund quantities across multiple refunds', () => {
    const { refundedBySkuVariant } = flattenLineItemsKeepingRefunds(orderNode({
      items: [
        { title: 'AJ', sku: 'AJ-BLK-10', variantTitle: 'Black / 10', quantity: 2, currentQuantity: 0 },
      ],
      refunds: [
        [{ quantity: 1, lineItem: { sku: 'AJ-BLK-10', variantTitle: 'Black / 10' } }],
        [{ quantity: 1, lineItem: { sku: 'AJ-BLK-10', variantTitle: 'Black / 10' } }],
      ],
    }));
    assert.equal(refundedBySkuVariant['AJ-BLK-10::Black / 10'], 2);
  });

  it('handles an order with no refunds selection at all', () => {
    const node = orderNode({ items: [{ title: 'AJ', sku: 'A', variantTitle: 'B', quantity: 1, currentQuantity: 1 }] });
    delete node.refunds;
    const { lineItems } = flattenLineItemsKeepingRefunds(node);
    assert.equal(lineItems.length, 1);
  });
});
