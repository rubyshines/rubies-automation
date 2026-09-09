/**
 * Unit tests for webhooks/lib/customerUpsert.js — the id-first customer upsert
 * that stops a Shopify email change from forking the mirror into two rows.
 *
 * Run: node --test webhooks/test/customerUpsert.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { upsertCustomerRow } = require('../lib/customerUpsert');

let calls;
let rowsByShopifyId; // shopify_customer_id → [{ email }]
let rowsByEmail;     // email → true when a customers row exists under it

function fakeSupabase() {
  return {
    from(table) {
      const op = { table, action: null, filters: {}, payload: null };
      function exec() {
        calls.push(op);
        if (op.action === 'select') {
          if (op.filters.email !== undefined) {
            return Promise.resolve({ data: (rowsByEmail[op.filters.email] ? [{ email: op.filters.email }] : []), error: null });
          }
          return Promise.resolve({ data: rowsByShopifyId[op.filters.shopify_customer_id] || [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      const b = {
        select() { op.action = op.action || 'select'; return b; },
        eq(col, val) { op.filters[col] = val; return b; },
        neq(col, val) { op.filters[`neq:${col}`] = val; return b; },
        update(payload) { op.action = 'update'; op.payload = payload; return b; },
        delete() { op.action = 'delete'; return b; },
        upsert(payload, opts) { op.action = 'upsert'; op.payload = payload; op.opts = opts; return exec(); },
        then(res, rej) { return exec().then(res, rej); },
      };
      return b;
    },
  };
}

beforeEach(() => { calls = []; rowsByShopifyId = {}; rowsByEmail = {}; });

const ROW = {
  email: 'new@example.com',
  shopify_customer_id: 'gid://shopify/Customer/1',
  first_name: 'Nora',
};

describe('upsertCustomerRow', () => {
  it('plain upsert when the id has no existing row', async () => {
    await upsertCustomerRow(fakeSupabase(), ROW);
    assert.deepEqual(calls.map(c => c.action), ['select', 'upsert']);
    assert.equal(calls[1].opts.onConflict, 'email');
  });

  it('plain upsert when the id already maps to the same email', async () => {
    rowsByShopifyId[ROW.shopify_customer_id] = [{ email: 'new@example.com' }];
    await upsertCustomerRow(fakeSupabase(), ROW);
    assert.deepEqual(calls.map(c => c.action), ['select', 'upsert']);
  });

  it('email change renames the existing row in place instead of forking', async () => {
    rowsByShopifyId[ROW.shopify_customer_id] = [{ email: 'old@example.com' }];
    await upsertCustomerRow(fakeSupabase(), ROW);
    const update = calls.find(c => c.action === 'update');
    assert.ok(update, 'expected a rename update');
    assert.equal(update.payload.email, 'new@example.com');
    assert.equal(update.filters.email, 'old@example.com');
    // and no second row: final write is an upsert onto the (renamed) email PK
    assert.equal(calls[calls.length - 1].action, 'upsert');
    assert.equal(calls.filter(c => c.action === 'delete').length, 0);
  });

  it('pre-existing fork (target row already present) deletes the orphans', async () => {
    rowsByShopifyId[ROW.shopify_customer_id] = [{ email: 'old@example.com' }, { email: 'new@example.com' }];
    await upsertCustomerRow(fakeSupabase(), ROW);
    const del = calls.find(c => c.action === 'delete');
    assert.ok(del, 'expected orphan cleanup');
    assert.equal(del.filters.shopify_customer_id, ROW.shopify_customer_id);
    assert.equal(del.filters['neq:email'], 'new@example.com');
    // No customer rename: the row under the current email already exists.
    assert.equal(calls.filter(c => c.action === 'update' && c.table === 'customers').length, 0);
  });

  it('a fork already sitting under the new email is merged, orders first (2026-09-09)', async () => {
    // Jared ordered under cerimelton@ before Shopify told us it was the same
    // customer as jared.melton@: the rename collided on the primary key and
    // the nightly sync logged it forever.
    rowsByShopifyId[ROW.shopify_customer_id] = [{ email: 'old@example.com' }];
    rowsByEmail['new@example.com'] = true;
    await upsertCustomerRow(fakeSupabase(), ROW);
    assert.deepEqual(calls.map(c => `${c.action}:${c.table}`),
      ['select:customers', 'select:customers', 'update:orders', 'delete:customers', 'upsert:customers']);
    assert.deepEqual(calls[2].payload, { customer_email: 'new@example.com' });
    assert.equal(calls[2].filters.customer_email, 'old@example.com');
    assert.equal(calls[3].filters['neq:email'], 'new@example.com');
    assert.equal(calls[4].payload.email, 'new@example.com');
  });

  it('orphan cleanup moves the orphans\' orders before deleting them', async () => {
    rowsByShopifyId[ROW.shopify_customer_id] = [{ email: 'older@example.com' }, { email: 'new@example.com' }];
    await upsertCustomerRow(fakeSupabase(), ROW);
    assert.deepEqual(calls.map(c => `${c.action}:${c.table}`),
      ['select:customers', 'update:orders', 'delete:customers', 'upsert:customers']);
    assert.equal(calls[1].filters.customer_email, 'older@example.com');
  });

  it('rows without a shopify id skip the lookup entirely', async () => {
    await upsertCustomerRow(fakeSupabase(), { email: 'x@example.com', shopify_customer_id: null });
    assert.deepEqual(calls.map(c => c.action), ['upsert']);
  });
});
