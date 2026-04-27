/**
 * Tests for the update_customer MCP tool.
 *
 * Run: node --test customer-service/test/updateCustomer.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');
const supabasePath = require.resolve('../lib/supabaseQueries');

let mockUpdateCalls = [];
let mockSearchShopifyResults = [];
let mockSearchSupabaseResults = [];
let mockUpdateThrows = null;

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    updateCustomer: async (id, input) => {
      mockUpdateCalls.push({ id, input });
      if (mockUpdateThrows) throw mockUpdateThrows;
      return { id, ...input };
    },
    searchCustomers: async (q) => mockSearchShopifyResults,
  },
};

require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    searchCustomersFromSupabase: async (q) => mockSearchSupabaseResults,
  },
};

const tools = require('../lib/tools/updateCustomer');
const updateTool = tools.find(t => t.name === 'update_customer');

beforeEach(() => {
  mockUpdateCalls = [];
  mockSearchShopifyResults = [];
  mockSearchSupabaseResults = [];
  mockUpdateThrows = null;
});

describe('update_customer', () => {
  it('updates email when customer_id is given', async () => {
    const res = await updateTool.handler({
      customer_id: 'gid://shopify/Customer/123',
      email: 'new@example.com',
    });
    assert.equal(mockUpdateCalls.length, 1);
    assert.equal(mockUpdateCalls[0].id, 'gid://shopify/Customer/123');
    assert.deepEqual(mockUpdateCalls[0].input, { email: 'new@example.com' });
    assert.match(res.content[0].text, /Updated customer/);
    assert.match(res.content[0].text, /email: new@example\.com/);
  });

  it('updates first and last name', async () => {
    const res = await updateTool.handler({
      customer_id: '456',
      first_name: 'Laura',
      last_name: 'Willard',
    });
    assert.equal(mockUpdateCalls.length, 1);
    assert.deepEqual(mockUpdateCalls[0].input, { firstName: 'Laura', lastName: 'Willard' });
    assert.match(res.content[0].text, /firstName: Laura/);
    assert.match(res.content[0].text, /lastName: Willard/);
  });

  it('updates email + name together', async () => {
    await updateTool.handler({
      customer_id: '789',
      email: 'new@example.com',
      first_name: 'Laura',
    });
    assert.deepEqual(mockUpdateCalls[0].input, { email: 'new@example.com', firstName: 'Laura' });
  });

  it('errors when no fields are provided', async () => {
    const res = await updateTool.handler({ customer_id: '123' });
    assert.equal(mockUpdateCalls.length, 0);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No fields to update/);
  });

  it('errors when neither customer_id nor customer_email is provided', async () => {
    const res = await updateTool.handler({ email: 'new@example.com' });
    assert.equal(mockUpdateCalls.length, 0);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /customer_id or customer_email/);
  });

  it('resolves customer_id from customer_email via Supabase', async () => {
    mockSearchSupabaseResults = [{ id: 'gid://shopify/Customer/999', email: 'old@example.com' }];
    const res = await updateTool.handler({
      customer_email: 'old@example.com',
      email: 'new@example.com',
    });
    assert.equal(mockUpdateCalls.length, 1);
    assert.equal(mockUpdateCalls[0].id, 'gid://shopify/Customer/999');
    assert.match(res.content[0].text, /Updated customer/);
  });

  it('falls back to Shopify search when Supabase has no match', async () => {
    mockSearchSupabaseResults = [];
    mockSearchShopifyResults = [{ id: 'gid://shopify/Customer/888', email: 'old@example.com' }];
    await updateTool.handler({
      customer_email: 'old@example.com',
      email: 'new@example.com',
    });
    assert.equal(mockUpdateCalls.length, 1);
    assert.equal(mockUpdateCalls[0].id, 'gid://shopify/Customer/888');
  });

  it('errors when customer_email lookup finds nothing', async () => {
    const res = await updateTool.handler({
      customer_email: 'unknown@example.com',
      email: 'new@example.com',
    });
    assert.equal(mockUpdateCalls.length, 0);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No customer found/);
  });

  it('matches email case-insensitively when resolving by email', async () => {
    mockSearchSupabaseResults = [{ id: '111', email: 'Old@Example.com' }];
    await updateTool.handler({
      customer_email: 'old@example.com',
      first_name: 'Laura',
    });
    assert.equal(mockUpdateCalls.length, 1);
  });

  it('returns error when Shopify mutation throws', async () => {
    mockUpdateThrows = new Error('Email already taken');
    const res = await updateTool.handler({
      customer_id: '123',
      email: 'taken@example.com',
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Failed to update customer/);
    assert.match(res.content[0].text, /Email already taken/);
  });
});
