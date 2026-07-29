/**
 * Regression tests for getInventoryMap in reports/lib/unfulfilled.js.
 *
 * The map keys and the query ids have to agree on variant-id shape. They
 * didn't: `inventory_snapshots.variant_id` holds the full
 * `gid://shopify/ProductVariant/<n>` while the query stripped ids to the bare
 * number, so `.in()` matched nothing and every caller saw an empty map. That
 * silently killed the awaiting_stock classification and the "Stock Issues"
 * section of the daily email.
 *
 * Run: node --test reports/test/inventoryMap.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { getInventoryMap, bareVariantId, classifyOrder } = require('../lib/unfulfilled');

// Minimal fake of the PostgREST chain getInventoryMap uses. Records the ids it
// was queried with, and matches rows by exact string equality the way `.in()`
// does — so a shape mismatch produces an empty result here just as it does live.
function fakeSupabase(rows, { captureIds } = {}) {
  return {
    from() {
      const builder = {
        _ids: null,
        select() { return builder; },
        order() { return builder; },
        limit() { return Promise.resolve({ data: [{ date: '2026-07-29' }] }); },
        eq() { return builder; },
        in(_col, ids) {
          builder._ids = ids;
          if (captureIds) captureIds.push(...ids);
          const matched = rows.filter(r => ids.includes(r.variant_id));
          return Promise.resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
  };
}

const GID = 'gid://shopify/ProductVariant/39561326919765';
const ROWS = [{ variant_id: GID, inventory_quantity: 0, sku: 'MIA-BLK-XL', product_handle: 'mia' }];

test('getInventoryMap finds rows stored as full gids when given full gids', async () => {
  const { map } = await getInventoryMap(fakeSupabase(ROWS), [GID]);
  assert.equal(map.size, 1, 'the gid-shaped row must be found');
  assert.equal(map.get('39561326919765').inventory_quantity, 0);
});

test('getInventoryMap keys on the bare id, which is how callers look up', async () => {
  // classifyOrder and the stockIssues builder both do
  // String(li.shopify_variant_id).replace(/.*\//, '') before .get().
  const { map } = await getInventoryMap(fakeSupabase(ROWS), [GID]);
  const callerKey = String(GID).replace(/.*\//, '');
  assert.ok(map.has(callerKey), 'lookup key used by callers must hit');
});

test('getInventoryMap also matches rows stored as bare numbers', async () => {
  const bareRows = [{ variant_id: '39561326919765', inventory_quantity: 4, sku: 'MIA-BLK-XL' }];
  const { map } = await getInventoryMap(fakeSupabase(bareRows), [GID]);
  assert.equal(map.get('39561326919765').inventory_quantity, 4);
});

test('getInventoryMap queries both id shapes', async () => {
  const captureIds = [];
  await getInventoryMap(fakeSupabase(ROWS, { captureIds }), [GID]);
  assert.ok(captureIds.includes(GID), 'full gid queried');
  assert.ok(captureIds.includes('39561326919765'), 'bare id queried');
});

test('getInventoryMap returns an empty map for no variant ids', async () => {
  const out = await getInventoryMap(fakeSupabase(ROWS), []);
  assert.equal(out instanceof Map, true);
  assert.equal(out.size, 0);
});

test('bareVariantId strips the gid prefix and passes bare ids through', () => {
  assert.equal(bareVariantId(GID), '39561326919765');
  assert.equal(bareVariantId('39561326919765'), '39561326919765');
  assert.equal(bareVariantId(39561326919765), '39561326919765');
});

// ---------------------------------------------------------------------------
// The payoff: classifyOrder can now see an out-of-stock item.
// ---------------------------------------------------------------------------

test('classifyOrder reports awaiting_stock once the inventory map resolves', async () => {
  const { map } = await getInventoryMap(fakeSupabase(ROWS), [GID]);
  const order = {
    created_at: '2026-01-01T00:00:00Z', // old enough to be past every timing gate
    order_line_items: [{ shopify_variant_id: GID, title: 'MIA HALTER BIKINI TOP', variant_title: 'Black / 1X' }],
  };
  const c = classifyOrder(order, null, { map }, 3);
  assert.equal(c.reason, 'awaiting_stock');
  assert.match(c.detail, /MIA HALTER BIKINI TOP/);
  assert.match(c.detail, /\(0 in stock\)/);
});

test('classifyOrder does not report awaiting_stock for an in-stock item', async () => {
  const inStock = [{ variant_id: GID, inventory_quantity: 12, sku: 'MIA-BLK-XL' }];
  const { map } = await getInventoryMap(fakeSupabase(inStock), [GID]);
  const order = {
    created_at: '2026-01-01T00:00:00Z',
    order_line_items: [{ shopify_variant_id: GID, title: 'MIA HALTER BIKINI TOP', variant_title: 'Black / 1X' }],
  };
  const c = classifyOrder(order, null, { map }, 3);
  assert.notEqual(c.reason, 'awaiting_stock');
});
