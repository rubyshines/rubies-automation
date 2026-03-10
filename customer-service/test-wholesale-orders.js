#!/usr/bin/env node

/**
 * Integration tests for wholesale order creation.
 *
 * Uses Jamie's real Shopify account (jamie@rubyshines.com).
 *
 * Tests verify:
 *   - Phase 1 draft creation (with admin links, address, currency)
 *   - Discount tiers (US 50%, AU 50%, GB 30%)
 *   - Currency override (sockdrawerheroes → USD)
 *   - AU de minimis splitting
 *   - Input validation (missing items, missing country_code)
 *   - parse_wholesale_input parsing
 *
 * SAFE: Does NOT call phase 2 (confirmed=true), so no invoices are sent.
 *       Phase 1 creates real draft orders in Shopify — safe to delete from admin.
 *
 * Run:  node customer-service/test-wholesale-orders.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { loadProducts } = require('./lib/productCache');
const wholesaleTools = require('./lib/tools/wholesaleOrder');
const wholesaleHandler = wholesaleTools.find(t => t.name === 'create_wholesale_order').handler;
const parseHandler = wholesaleTools.find(t => t.name === 'parse_wholesale_input').handler;

// --- Test data ---
const CUSTOMER_GID = 'gid://shopify/Customer/2980390371413';
const CUSTOMER_NUMERIC = '2980390371413';

// --- Test runner ---
let passed = 0;
let failed = 0;
const failures = [];
const createdDrafts = [];

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
  // SECTION 1: Input validation
  // ============================================================
  console.log('━━━ create_wholesale_order — input validation ━━━');

  await runTest('rejects missing country_code', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      items: [{ query: 'charlie pink S' }],
    });
    const text = result.content[0].text;
    assert(text.includes('country_code is required'), `Expected country_code error, got: ${text}`);
  });

  await runTest('rejects missing items', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      country_code: 'US',
    });
    const text = result.content[0].text;
    assert(text.includes('items are required'), `Expected items error, got: ${text}`);
  });

  await runTest('rejects empty items array', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      country_code: 'US',
      items: [],
    });
    const text = result.content[0].text;
    assert(text.includes('items are required'), `Expected items error, got: ${text}`);
  });

  await runTest('rejects item with neither variant_id nor query', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      country_code: 'US',
      items: [{ quantity: 2 }],
    });
    const text = result.content[0].text;
    assert(text.includes('variant_id or query'), `Expected variant_id/query error, got: ${text}`);
  });

  await runTest('rejects unmatched product query', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      country_code: 'US',
      items: [{ query: '$$$$@@@###ZZZZ' }],
    });
    const text = result.content[0].text;
    assert(text.includes('No products found'), `Expected no-match error, got: ${text}`);
  });

  // ============================================================
  // SECTION 2: Phase 1 — US order (50% discount)
  // ============================================================
  console.log('\n━━━ create_wholesale_order — Phase 1: US order (50% discount) ━━━');

  await runTest('creates US draft with 50% discount, admin link, address, and currency', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      country_code: 'US',
      items: [{ query: 'charlie pink S', quantity: 2 }],
      note: 'TEST US wholesale — safe to delete',
    });
    const text = result.content[0].text;

    // Should be awaiting confirmation (phase 1)
    assert(text.includes('Awaiting Confirmation'), `Expected awaiting confirmation, got: ${text.substring(0, 200)}`);

    // Should have admin link
    assert(text.includes('admin.shopify.com'), `Expected admin link, got: ${text.substring(0, 300)}`);
    assert(text.includes('/draft_orders/'), `Expected draft order admin link, got: ${text.substring(0, 300)}`);

    // Should have customer name (not just ID)
    assert(!text.includes(`**Customer:** ${CUSTOMER_NUMERIC}`), `Customer should be resolved to name, not numeric ID`);

    // Should have address
    assert(text.includes('**Ship to:**'), `Expected shipping address section`);

    // Should show 50% discount
    assert(text.includes('50% discount'), `Expected 50% discount, got: ${text.substring(0, 300)}`);

    // Should show currency
    assert(text.includes('**Currency:**'), `Expected currency line, got: ${text.substring(0, 400)}`);

    // Should include draft_order_ids for phase 2
    assert(text.includes('draft_order_ids='), `Expected draft_order_ids in confirmation prompt`);

    // Track draft for cleanup info
    const idMatch = text.match(/gid:\/\/shopify\/DraftOrder\/\d+/);
    if (idMatch) {
      createdDrafts.push(idMatch[0]);
      console.log('');
      console.log(`    i  Draft created: ${idMatch[0]} — safe to delete`);
    }
  });

  // ============================================================
  // SECTION 3: Phase 1 — GB order (30% discount)
  // ============================================================
  console.log('\n━━━ create_wholesale_order — Phase 1: GB order (30% discount) ━━━');

  await runTest('creates GB draft with 30% discount', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      country_code: 'GB',
      items: [{ query: 'charlie pink M', quantity: 1 }],
      note: 'TEST GB wholesale — safe to delete',
    });
    const text = result.content[0].text;

    assert(text.includes('Awaiting Confirmation'), `Expected awaiting confirmation`);
    assert(text.includes('30% discount'), `Expected 30% discount for GB, got: ${text.substring(0, 300)}`);
    assert(text.includes('admin.shopify.com'), `Expected admin link`);

    const idMatch = text.match(/gid:\/\/shopify\/DraftOrder\/\d+/);
    if (idMatch) {
      createdDrafts.push(idMatch[0]);
      console.log('');
      console.log(`    i  Draft created: ${idMatch[0]} — safe to delete`);
    }
  });

  // ============================================================
  // SECTION 4: Phase 1 — AU order (50% discount)
  // ============================================================
  console.log('\n━━━ create_wholesale_order — Phase 1: AU order (50% discount) ━━━');

  await runTest('creates AU draft with 50% discount', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      country_code: 'AU',
      items: [{ query: 'charlie pink L', quantity: 1 }],
      note: 'TEST AU wholesale — safe to delete',
    });
    const text = result.content[0].text;

    assert(text.includes('Awaiting Confirmation'), `Expected awaiting confirmation`);
    assert(text.includes('50% discount'), `Expected 50% discount for AU, got: ${text.substring(0, 300)}`);

    const idMatch = text.match(/gid:\/\/shopify\/DraftOrder\/\d+/);
    if (idMatch) {
      createdDrafts.push(idMatch[0]);
      console.log('');
      console.log(`    i  Draft created: ${idMatch[0]} — safe to delete`);
    }
  });

  // ============================================================
  // SECTION 5: Currency override (sockdrawerheroes → USD)
  // ============================================================
  console.log('\n━━━ create_wholesale_order — Currency override ━━━');

  await runTest('sockdrawerheroes email forces USD currency', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      customer_email: 'hello@sockdrawerheroes.com',
      country_code: 'AU',
      items: [{ query: 'charlie pink S', quantity: 1 }],
      note: 'TEST currency override — safe to delete',
    });
    const text = result.content[0].text;

    assert(text.includes('Awaiting Confirmation'), `Expected awaiting confirmation`);
    assert(text.includes('Currency override') || text.includes('USD'), `Expected USD currency override, got: ${text.substring(0, 400)}`);

    // Should NOT trigger AU de minimis splitting (since currency is overridden to USD)
    assert(!text.includes('de minimis'), `Should not split when currency overridden to USD`);

    const idMatch = text.match(/gid:\/\/shopify\/DraftOrder\/\d+/);
    if (idMatch) {
      createdDrafts.push(idMatch[0]);
      console.log('');
      console.log(`    i  Draft created: ${idMatch[0]} — safe to delete`);
    }
  });

  // ============================================================
  // SECTION 6: Phase 2 validation (without actually sending)
  // ============================================================
  console.log('\n━━━ create_wholesale_order — Phase 2 validation (no invoice sent) ━━━');

  await runTest('phase 2 requires draft_order_ids', async () => {
    const result = await wholesaleHandler({
      customer_id: CUSTOMER_NUMERIC,
      confirmed: true,
    });
    const text = result.content[0].text;
    // Without draft_order_ids, it should fall through to phase 1 validation
    assert(
      text.includes('country_code is required') || text.includes('items are required'),
      `Expected validation error when confirmed=true but no draft_order_ids, got: ${text}`
    );
  });

  // ============================================================
  // SECTION 7: parse_wholesale_input
  // ============================================================
  console.log('\n━━━ parse_wholesale_input ━━━');

  await runTest('parses "2x charlie pink S" format', async () => {
    const result = await parseHandler({ input: '2x charlie pink S' });
    const parsed = JSON.parse(result.content[0].text);
    assert(parsed.resolved.length === 1, `Expected 1 resolved item, got ${parsed.resolved.length}`);
    assert(parsed.resolved[0].quantity === 2, `Expected quantity 2, got ${parsed.resolved[0].quantity}`);
    assert(parsed.errors.length === 0, `Expected no errors, got: ${parsed.errors.join(', ')}`);
  });

  await runTest('parses "charlie pink M, 3" format (quantity at end)', async () => {
    const result = await parseHandler({ input: 'charlie pink M, 3' });
    const parsed = JSON.parse(result.content[0].text);
    assert(parsed.resolved.length === 1, `Expected 1 resolved item`);
    assert(parsed.resolved[0].quantity === 3, `Expected quantity 3, got ${parsed.resolved[0].quantity}`);
  });

  await runTest('parses "1, charlie pink L" format (quantity at start)', async () => {
    const result = await parseHandler({ input: '1, charlie pink L' });
    const parsed = JSON.parse(result.content[0].text);
    assert(parsed.resolved.length === 1, `Expected 1 resolved item`);
    assert(parsed.resolved[0].quantity === 1, `Expected quantity 1, got ${parsed.resolved[0].quantity}`);
  });

  await runTest('parses multi-line input', async () => {
    const result = await parseHandler({
      input: '2x charlie pink S\n1x charlie pink M\n3x charlie pink L',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert(parsed.resolved.length === 3, `Expected 3 resolved items, got ${parsed.resolved.length}`);
    assert(parsed.errors.length === 0, `Expected no errors`);
  });

  await runTest('reports errors for unmatched lines', async () => {
    const result = await parseHandler({
      input: '2x charlie pink S\n1x $$$$@@@###ZZZZ',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert(parsed.resolved.length === 1, `Expected 1 resolved item`);
    assert(parsed.errors.length === 1, `Expected 1 error for unmatched line`);
  });

  await runTest('resolved items include price and variantId', async () => {
    const result = await parseHandler({ input: '1x charlie pink S' });
    const parsed = JSON.parse(result.content[0].text);
    const item = parsed.resolved[0];
    assert(item.variantId, `Expected variantId, got: ${JSON.stringify(item)}`);
    assert(item.price !== undefined, `Expected price, got: ${JSON.stringify(item)}`);
    assert(item.sku, `Expected sku, got: ${JSON.stringify(item)}`);
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
  if (createdDrafts.length > 0) {
    console.log(`\n  ℹ  ${createdDrafts.length} draft order(s) created — safe to delete from Shopify admin.`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
