/**
 * Guard tests for the shadow-eval read-only allowlist (operatorAgent.js).
 *
 * The shadow Sonnet eval must never execute a mutation. These tests cross-check
 * SHADOW_READONLY_TOOLS against the live operator tool catalog so a mutation
 * tool can never slip into the allowlist and a typo can't silently allowlist
 * nothing.
 *
 * Run: node --test customer-service/test/shadowReadonly.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'test.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'test-token';

const { SHADOW_READONLY_TOOLS } = require('../lib/operatorAgent');
const { loadAllOperatorTools } = require('../lib/operatorTools');

const catalog = new Set(((loadAllOperatorTools().tools) || loadAllOperatorTools()).map(t => t.name));

// Any tool name matching one of these is a state-changing operation and must
// NOT be in the read-only allowlist.
const MUTATION_PATTERN = /^(create_|update_|delete_|cancel_|refund_|edit_|send_|set_|resolve_|unresolve_|register_|reload_|refresh_)|_(publish|approve|reject|resend|update|delete|create|note)$|(^add_order_note$|^split_shipment$|^consolidate_orders$|^warehouse_hold$|^release_|^update_customer$|^update_shipping_speed$|^create_discount_code$|^klaviyo_subscription_update$|^shipping_delay_resolve$)/;

describe('shadow-eval read-only allowlist', () => {
  it('every allowlisted tool exists in the live catalog (no typos / stale entries)', () => {
    const missing = [...SHADOW_READONLY_TOOLS].filter(n => !catalog.has(n));
    assert.deepEqual(missing, [], `allowlist references tools not in the catalog: ${missing.join(', ')}`);
  });

  it('no allowlisted tool matches a mutation naming pattern', () => {
    const leaked = [...SHADOW_READONLY_TOOLS].filter(n => MUTATION_PATTERN.test(n));
    assert.deepEqual(leaked, [], `mutation-shaped tools must not be allowlisted: ${leaked.join(', ')}`);
  });

  it('blocks the specific mutators the review flagged as previously unprotected', () => {
    const mustBlock = [
      'cancel_order', 'create_discount_code', 'consolidate_orders', 'update_customer',
      'set_product_prices', 'send_b2b_email', 'klaviyo_subscription_update', 'seo_meta_update',
      'free_swimwear_approve', 'store_locator_publish', 'donation_partner_delete',
      'create_outreach_ticket', 'resolve_order', 'unresolve_order', 'update_shipping_speed',
      'refund_order', 'edit_order', 'create_order',
    ];
    for (const name of mustBlock) {
      assert.equal(SHADOW_READONLY_TOOLS.has(name), false, `${name} must be blocked in shadow mode`);
    }
  });

  it('allows representative read-only tools', () => {
    for (const name of ['lookup_customer', 'get_order_details', 'search_products', 'shipping_lookup']) {
      assert.equal(SHADOW_READONLY_TOOLS.has(name), true, `${name} should be allowed in shadow mode`);
      assert.equal(catalog.has(name), true, `${name} should exist in the catalog`);
    }
  });
});
