#!/usr/bin/env node

/**
 * Integration tests for exchange order fulfilled-order filtering.
 *
 * Uses Jamie's real Shopify account (jamie@rubyshines.com) which has a mix of:
 *   - FULFILLED + PAID orders (gift cards)
 *   - UNFULFILLED + PAID $0 exchange orders (must be ignored)
 *   - FULFILLED + REFUNDED orders (must be excluded)
 *   - UNFULFILLED + REFUNDED orders
 *   - UNFULFILLED + PAID orders
 *
 * Tests are designed to remain valid as new orders are placed — they assert
 * on ORDER PROPERTIES (fulfilled, not refunded, not cancelled) rather than
 * hardcoding which specific order number should be "most recent".
 *
 * Run:  node customer-service/test-exchange-orders.js
 *
 * SAFE: Does NOT complete/mark-as-paid any draft orders (phase 2).
 *       Phase 1 draft creation test IS included — creates a $0 draft that
 *       can be deleted from Shopify admin if desired.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const {
  getCustomerFulfilledOrders,
  getCustomerOrders,
  normalizeGid,
} = require('./lib/shopify');

// Load product cache for exchange handler tests
const { loadProducts } = require('./lib/productCache');
const exchangeTools = require('./lib/tools/exchangeOrder');
const exchangeHandler = exchangeTools.find(t => t.name === 'create_exchange_order').handler;

// --- Test data ---
const CUSTOMER_GID = 'gid://shopify/Customer/2980390371413';
const CUSTOMER_NUMERIC = '2980390371413';

// Known "bad" orders that must NEVER be picked for an exchange.
// These are stable historical orders that won't change status.
const KNOWN_BAD_ORDERS = {
  UNFULFILLED_PAID_EXCHANGE: {
    id: 'gid://shopify/Order/5367693279510',
    name: '#11673',
    desc: 'UNFULFILLED + PAID $0 exchange (must be ignored)',
  },
  FULFILLED_REFUNDED: {
    id: 'gid://shopify/Order/5226519396630',
    name: '#9806',
    desc: 'FULFILLED + REFUNDED (must be excluded)',
  },
  UNFULFILLED_REFUNDED: {
    id: 'gid://shopify/Order/2334207344725',
    name: '#1149',
    desc: 'UNFULFILLED + REFUNDED',
  },
  UNFULFILLED_PAID: {
    id: 'gid://shopify/Order/2127849881685',
    name: '#1003',
    desc: 'UNFULFILLED + PAID',
  },
};

// --- Test runner ---
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    passed++;
    console.log('\x1b[32mPASS\x1b[0m');
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`\x1b[31mFAIL\x1b[0m — ${err.message}`);
  }
}

// --- Tests ---

async function main() {
  console.log('\n  Loading product cache...');
  await loadProducts();
  console.log('  Product cache loaded.\n');

  // ============================================================
  // SECTION 1: getCustomerFulfilledOrders — property-based checks
  // ============================================================
  console.log('━━━ getCustomerFulfilledOrders() ━━━');

  let fulfilledOrders;

  await runTest('returns results for known customer', async () => {
    fulfilledOrders = await getCustomerFulfilledOrders(CUSTOMER_GID, 20);
    assert(Array.isArray(fulfilledOrders), 'should return an array');
    assert(fulfilledOrders.length > 0, 'should have at least one fulfilled order');
  });

  await runTest('also works with numeric customer ID', async () => {
    const orders = await getCustomerFulfilledOrders(CUSTOMER_NUMERIC, 5);
    assert(Array.isArray(orders), 'should return an array');
    assert(orders.length > 0, 'should have results');
  });

  await runTest('EVERY returned order is FULFILLED', async () => {
    for (const o of fulfilledOrders) {
      assert(
        o.displayFulfillmentStatus === 'FULFILLED',
        `Order ${o.name} has status ${o.displayFulfillmentStatus}, expected FULFILLED`
      );
    }
  });

  await runTest('NO returned order is REFUNDED', async () => {
    for (const o of fulfilledOrders) {
      assert(
        o.displayFinancialStatus !== 'REFUNDED',
        `Order ${o.name} is REFUNDED but was returned`
      );
    }
  });

  await runTest('NO returned order is cancelled', async () => {
    for (const o of fulfilledOrders) {
      assert(!o.cancelledAt, `Order ${o.name} is cancelled but was returned`);
    }
  });

  await runTest('results are sorted most-recent first', async () => {
    for (let i = 1; i < fulfilledOrders.length; i++) {
      const prev = new Date(fulfilledOrders[i - 1].createdAt).getTime();
      const curr = new Date(fulfilledOrders[i].createdAt).getTime();
      assert(prev >= curr, `Order ${fulfilledOrders[i - 1].name} (${fulfilledOrders[i - 1].createdAt}) should be >= ${fulfilledOrders[i].name} (${fulfilledOrders[i].createdAt})`);
    }
  });

  // Check that every known "bad" order is excluded
  for (const [key, order] of Object.entries(KNOWN_BAD_ORDERS)) {
    await runTest(`excludes known bad order ${order.name} (${order.desc})`, async () => {
      const found = fulfilledOrders.find(o => o.id === order.id);
      assert(!found, `Order ${order.name} should NOT appear in fulfilled orders`);
    });
  }

  await runTest('each order has lineItems array', async () => {
    for (const o of fulfilledOrders) {
      assert(Array.isArray(o.lineItems), `Order ${o.name} missing lineItems array`);
    }
  });

  // ============================================================
  // SECTION 2: Cross-check — every fulfilled order also exists in
  //            the unfiltered list with matching status fields
  // ============================================================
  console.log('\n━━━ Cross-validation against getCustomerOrders (unfiltered) ━━━');

  let allOrders;

  await runTest('getCustomerOrders (unfiltered) returns MORE orders than getCustomerFulfilledOrders', async () => {
    const result = await getCustomerOrders(CUSTOMER_GID, 50);
    allOrders = result.orders;
    assert(
      allOrders.length > fulfilledOrders.length,
      `All (${allOrders.length}) should be more than fulfilled-only (${fulfilledOrders.length})`
    );
    console.log('');
    console.log(`    i  All orders: ${allOrders.length}, Fulfilled-only: ${fulfilledOrders.length}`);
  });

  await runTest('unfiltered list contains orders that are NOT fulfilled (proving filter is needed)', async () => {
    const unfulfilled = allOrders.filter(o => o.displayFulfillmentStatus !== 'FULFILLED');
    assert(unfulfilled.length > 0, 'Should have at least one unfulfilled order in unfiltered list');
    console.log('');
    console.log(`    i  Unfulfilled in unfiltered list: ${unfulfilled.map(o => o.name).join(', ')}`);
  });

  await runTest('every order in fulfilled list also appears in unfiltered list with FULFILLED status', async () => {
    for (const fo of fulfilledOrders) {
      const match = allOrders.find(o => o.id === fo.id);
      assert(match, `Fulfilled order ${fo.name} not found in unfiltered list`);
      assert(
        match.displayFulfillmentStatus === 'FULFILLED',
        `Order ${fo.name} is ${match.displayFulfillmentStatus} in unfiltered list — data mismatch`
      );
    }
  });

  // ============================================================
  // SECTION 3: Exchange handler — validation (no side effects)
  //            Tests use known bad orders that will always be bad.
  // ============================================================
  console.log('\n━━━ create_exchange_order handler — validation ━━━');

  await runTest('rejects explicit UNFULFILLED order #11673', async () => {
    const numericId = KNOWN_BAD_ORDERS.UNFULFILLED_PAID_EXCHANGE.id.split('/').pop();
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
      original_order_id: numericId,
      items: [{ query: 'gift card' }],
    });
    const text = result.content[0].text;
    assert(
      text.includes('not fulfilled') || text.includes('UNFULFILLED'),
      `Expected "not fulfilled" error for #11673, got: ${text}`
    );
  });

  await runTest('rejects explicit REFUNDED order #9806', async () => {
    const numericId = KNOWN_BAD_ORDERS.FULFILLED_REFUNDED.id.split('/').pop();
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
      original_order_id: numericId,
      items: [{ query: 'gift card' }],
    });
    const text = result.content[0].text;
    assert(
      text.includes('refunded') || text.includes('REFUNDED'),
      `Expected "refunded" error for #9806, got: ${text}`
    );
  });

  await runTest('rejects explicit UNFULFILLED+PAID order #1003', async () => {
    const numericId = KNOWN_BAD_ORDERS.UNFULFILLED_PAID.id.split('/').pop();
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
      original_order_id: numericId,
      items: [{ query: 'gift card' }],
    });
    const text = result.content[0].text;
    assert(
      text.includes('not fulfilled') || text.includes('UNFULFILLED'),
      `Expected "not fulfilled" error for #1003, got: ${text}`
    );
  });

  await runTest('rejects explicit UNFULFILLED+REFUNDED order #1149', async () => {
    const numericId = KNOWN_BAD_ORDERS.UNFULFILLED_REFUNDED.id.split('/').pop();
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
      original_order_id: numericId,
      items: [{ query: 'gift card' }],
    });
    const text = result.content[0].text;
    assert(
      text.includes('not fulfilled') || text.includes('UNFULFILLED'),
      `Expected "not fulfilled" error for #1149, got: ${text}`
    );
  });

  await runTest('returns error when items are missing', async () => {
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
    });
    const text = result.content[0].text;
    assert(text.includes('items are required'), `Expected "items required" error, got: ${text}`);
  });

  await runTest('returns error when item has neither variant_id nor query', async () => {
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
      items: [{ quantity: 1 }],
    });
    const text = result.content[0].text;
    assert(text.includes('variant_id or query'), `Expected "variant_id or query" error, got: ${text}`);
  });

  // ============================================================
  // SECTION 4: Exchange handler — auto-find path (creates a real draft)
  //
  // These tests verify PROPERTIES of the auto-found order rather than
  // asserting a specific order number — so they stay valid even if
  // new orders are placed on the account.
  // ============================================================
  console.log('\n━━━ create_exchange_order handler — auto-find + draft creation (phase 1 only) ━━━');

  await runTest('auto-find picks a FULFILLED order and creates $0 draft (phase 1)', async () => {
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
      items: [{ query: 'gift card $20' }],
      note: 'TEST — safe to delete',
    });
    const text = result.content[0].text;

    // Should contain "Draft Order Created"
    assert(
      text.includes('Draft Order Created') || text.includes('Awaiting Confirmation'),
      `Expected draft creation confirmation, got: ${text}`
    );

    // Should NOT have completed the order
    assert(!text.includes('marked as paid'), 'Phase 1 should NOT mark as paid');

    // The original order referenced should match the first fulfilled order
    // (which we already verified is FULFILLED + not REFUNDED + not cancelled)
    const mostRecent = fulfilledOrders[0];
    assert(
      text.includes(mostRecent.name),
      `Expected auto-find to pick ${mostRecent.name} (most recent fulfilled), but output was: ${text.substring(0, 300)}`
    );

    // Verify NONE of the known bad orders were picked
    for (const [key, order] of Object.entries(KNOWN_BAD_ORDERS)) {
      assert(
        !text.includes(`Original Order:** ${order.name}`),
        `Auto-find picked known bad order ${order.name} (${order.desc})!`
      );
    }

    const draftMatch = text.match(/draft_order_id="(gid:\/\/shopify\/DraftOrder\/\d+)"/);
    if (draftMatch) {
      console.log('');
      console.log(`    i  Draft created: ${draftMatch[1]} — safe to delete`);
      console.log(`    i  Auto-found original order: ${mostRecent.name}`);
    }
  });

  await runTest('explicit fulfilled order works for phase 1 (using first from fulfilled list)', async () => {
    const mostRecent = fulfilledOrders[0];
    const numericId = mostRecent.id.split('/').pop();
    const result = await exchangeHandler({
      customer_id: CUSTOMER_NUMERIC,
      original_order_id: numericId,
      items: [{ query: 'gift card $20' }],
      note: 'TEST explicit order — safe to delete',
    });
    const text = result.content[0].text;
    assert(text.includes(mostRecent.name), `Expected draft to reference ${mostRecent.name}, got: ${text.substring(0, 300)}`);
    assert(
      text.includes('Draft Order Created') || text.includes('Awaiting Confirmation'),
      `Expected draft creation, got: ${text.substring(0, 200)}`
    );

    const draftMatch = text.match(/draft_order_id="(gid:\/\/shopify\/DraftOrder\/\d+)"/);
    if (draftMatch) {
      console.log('');
      console.log(`    i  Draft created: ${draftMatch[1]} — safe to delete`);
    }
  });

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n' + '='.repeat(50));
  console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed ? '31' : '32'}m${failed} failed\x1b[0m`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    \x1b[31m✗\x1b[0m ${f.name}`);
      console.log(`      ${f.error}`);
    }
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
