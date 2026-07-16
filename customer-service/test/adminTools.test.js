/**
 * Unit tests for lib/tools/adminTools.js — audit_log tool behavior.
 *
 * Run: node --test customer-service/test/adminTools.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub supabaseClient + costsCache before requiring adminTools
// ---------------------------------------------------------------------------

const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const costsCachePath = require.resolve('../lib/costsCache');

let queryResponse = { data: [], error: null };
let lastInsert = null;
let insertResponse = { error: null };

function makeQueryChain() {
  const chain = {
    select: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: () => chain,
    then: (resolve, reject) => Promise.resolve(queryResponse).then(resolve, reject),
  };
  return chain;
}

require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from: () => ({
        ...makeQueryChain(),
        insert: (row) => { lastInsert = row; return Promise.resolve(insertResponse); },
      }),
    }),
  },
};

require.cache[costsCachePath] = {
  id: costsCachePath,
  filename: costsCachePath,
  loaded: true,
  exports: { refreshCosts: async () => 0 },
};

const adminTools = require('../lib/tools/adminTools');
const auditLogTool = adminTools.find(t => t.name === 'audit_log');
const { writeAuditEntry } = adminTools;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit_log tool', () => {
  beforeEach(() => {
    queryResponse = { data: [], error: null };
    lastInsert = null;
    insertResponse = { error: null };
  });

  it('degrades gracefully when the table is missing (PostgREST PGRST205)', async () => {
    queryResponse = {
      data: null,
      error: { code: 'PGRST205', message: "Could not find the table 'public.audit_log' in the schema cache" },
    };
    const result = await auditLogTool.handler({});
    assert.match(result.content[0].text, /audit-schema\.sql/);
  });

  it('degrades gracefully on raw Postgres 42P01 (relation does not exist)', async () => {
    queryResponse = {
      data: null,
      error: { code: '42P01', message: 'relation "audit_log" does not exist' },
    };
    const result = await auditLogTool.handler({});
    assert.match(result.content[0].text, /audit-schema\.sql/);
  });

  it('throws on other Supabase errors', async () => {
    queryResponse = { data: null, error: { code: 'XX000', message: 'boom' } };
    await assert.rejects(() => auditLogTool.handler({}), /Supabase error: boom/);
  });

  it('reports no entries when the table is empty', async () => {
    const result = await auditLogTool.handler({ days_back: 3 });
    assert.match(result.content[0].text, /No audit log entries in the last 3 days/);
  });

  it('renders entries as a markdown table', async () => {
    queryResponse = {
      data: [{
        created_at: '2026-07-16T12:00:00.000Z',
        action_type: 'order_edited',
        actor: 'claude_code',
        details: { order: '#12345' },
      }],
      error: null,
    };
    const result = await auditLogTool.handler({});
    assert.match(result.content[0].text, /order_edited/);
    assert.match(result.content[0].text, /#12345/);
  });
});

describe('writeAuditEntry', () => {
  beforeEach(() => {
    lastInsert = null;
    insertResponse = { error: null };
  });

  it('writes the entry with defaults applied', async () => {
    await writeAuditEntry({ action_type: 'order_edited', details: { order: '#1' } });
    assert.equal(lastInsert.action_type, 'order_edited');
    assert.equal(lastInsert.actor, 'claude_code');
    assert.deepEqual(lastInsert.details, { order: '#1' });
    assert.equal(lastInsert.entity_type, null);
  });

  it('never throws when the insert fails (fail-soft)', async () => {
    insertResponse = { error: { message: 'table missing' } };
    await assert.doesNotReject(() => writeAuditEntry({ action_type: 'x' }));
  });
});
