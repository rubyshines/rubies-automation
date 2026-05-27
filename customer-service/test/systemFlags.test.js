const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Stub the Supabase client before requiring the module under test (pattern per
// feedback_technical_rules.md). The fake exposes a chainable query builder whose
// terminal result is controlled per-test.
const clientPath = path.resolve(__dirname, '../../shared/supabaseClient');

let nextSelectResult; // { data, error } returned by maybeSingle()
let upsertCalls;       // records setFlag writes
let upsertError;       // forced error for setFlag

function makeFakeClient() {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => nextSelectResult,
        upsert: async (row, opts) => { upsertCalls.push({ row, opts }); return { error: upsertError }; },
      };
    },
  };
}

require.cache[require.resolve(clientPath)] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: { getSupabaseClient: () => makeFakeClient() },
};

const { isFlagEnabled, setFlag, _clearCache } = require('../../shared/systemFlags');

function reset() {
  _clearCache();
  nextSelectResult = { data: null, error: null };
  upsertCalls = [];
  upsertError = null;
}

test('returns false default when row is absent', async () => {
  reset();
  nextSelectResult = { data: null, error: null };
  assert.equal(await isFlagEnabled('cs_diagnostics'), false);
});

test('returns false (default) when the table read errors (e.g. table missing)', async () => {
  reset();
  nextSelectResult = { data: null, error: { code: 'PGRST205', message: 'no table' } };
  assert.equal(await isFlagEnabled('cs_diagnostics'), false);
});

test('honors a provided non-false default when read fails', async () => {
  reset();
  nextSelectResult = { data: null, error: { code: 'PGRST205' } };
  assert.equal(await isFlagEnabled('some_flag', true), true);
});

test('returns true when the row is enabled', async () => {
  reset();
  nextSelectResult = { data: { enabled: true }, error: null };
  assert.equal(await isFlagEnabled('cs_diagnostics'), true);
});

test('returns false when the row is explicitly disabled', async () => {
  reset();
  nextSelectResult = { data: { enabled: false }, error: null };
  assert.equal(await isFlagEnabled('cs_diagnostics'), false);
});

test('caches within TTL — a second read does not reflect a changed DB value until cache clears', async () => {
  reset();
  nextSelectResult = { data: { enabled: true }, error: null };
  assert.equal(await isFlagEnabled('cs_diagnostics'), true);
  nextSelectResult = { data: { enabled: false }, error: null }; // DB changed
  assert.equal(await isFlagEnabled('cs_diagnostics'), true);     // still cached
  _clearCache();
  assert.equal(await isFlagEnabled('cs_diagnostics'), false);    // fresh read
});

test('setFlag upserts on key and invalidates the cache', async () => {
  reset();
  nextSelectResult = { data: { enabled: false }, error: null };
  assert.equal(await isFlagEnabled('cs_diagnostics'), false); // populate cache
  nextSelectResult = { data: { enabled: true }, error: null };
  await setFlag('cs_diagnostics', true, 'enabling for eval');
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].row.key, 'cs_diagnostics');
  assert.equal(upsertCalls[0].row.enabled, true);
  assert.equal(upsertCalls[0].opts.onConflict, 'key');
  assert.equal(await isFlagEnabled('cs_diagnostics'), true); // cache was cleared → fresh read
});

test('setFlag throws on upsert error', async () => {
  reset();
  upsertError = { message: 'permission denied' };
  await assert.rejects(() => setFlag('cs_diagnostics', true), (e) => e && e.message === 'permission denied');
});
