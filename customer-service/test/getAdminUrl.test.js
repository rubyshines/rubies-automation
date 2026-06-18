'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { getAdminUrl, getAdminStoreSlug } = require('../lib/shopify');

// getAdminStoreSlug reads process.env at call time, so each case just sets the
// relevant vars before calling. Save/restore to avoid leaking across tests.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('derives slug from SHOPIFY_STORE_URL when SHOPIFY_ADMIN_STORE is unset', () => {
  withEnv({ SHOPIFY_STORE_URL: 'rubies-active-wear.myshopify.com', SHOPIFY_ADMIN_STORE: undefined }, () => {
    assert.strictEqual(getAdminStoreSlug(), 'rubies-active-wear');
  });
});

test('ignores the .env.example placeholder and falls back to SHOPIFY_STORE_URL', () => {
  withEnv({ SHOPIFY_STORE_URL: 'rubies-active-wear.myshopify.com', SHOPIFY_ADMIN_STORE: 'your-admin-store-slug' }, () => {
    assert.strictEqual(getAdminStoreSlug(), 'rubies-active-wear');
  });
});

test('honors a real SHOPIFY_ADMIN_STORE override', () => {
  withEnv({ SHOPIFY_STORE_URL: 'rubies-active-wear.myshopify.com', SHOPIFY_ADMIN_STORE: 'custom-admin-slug' }, () => {
    assert.strictEqual(getAdminStoreSlug(), 'custom-admin-slug');
  });
});

test('blank SHOPIFY_ADMIN_STORE falls back to SHOPIFY_STORE_URL', () => {
  withEnv({ SHOPIFY_STORE_URL: 'rubies-active-wear.myshopify.com', SHOPIFY_ADMIN_STORE: '   ' }, () => {
    assert.strictEqual(getAdminStoreSlug(), 'rubies-active-wear');
  });
});

test('getAdminUrl never emits the placeholder slug, across all GID types', () => {
  withEnv({ SHOPIFY_STORE_URL: 'rubies-active-wear.myshopify.com', SHOPIFY_ADMIN_STORE: 'your-admin-store-slug' }, () => {
    const cases = {
      'gid://shopify/DiscountCodeNode/1708506513686': '/discounts/1708506513686',
      'gid://shopify/Order/123': '/orders/123',
      'gid://shopify/DraftOrder/456': '/draft_orders/456',
      'gid://shopify/Collection/789': '/collections/789',
      'gid://shopify/Product/321': '/products/321',
    };
    for (const [gid, expectedPath] of Object.entries(cases)) {
      const url = getAdminUrl(gid);
      assert.ok(!url.includes('your-admin-store-slug'), `placeholder leaked into ${url}`);
      assert.ok(url.startsWith('https://admin.shopify.com/store/rubies-active-wear'), `wrong slug in ${url}`);
      assert.ok(url.endsWith(expectedPath), `wrong path in ${url}`);
    }
  });
});
