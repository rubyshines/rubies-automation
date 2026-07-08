/**
 * Unit tests for the shared Supabase helpers (shared/supabaseClient.js).
 *
 * Run: node --test customer-service/test/supabaseHelpers.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fetchAllPaginated, readMany, readOne } = require('../../shared/supabaseClient');

// A mock query builder whose .range(from,to) slices a fixed dataset, mimicking
// PostgREST paging (inclusive range, capped at pageSize by the caller).
function pagedSource(allRows, { error = null } = {}) {
  return () => ({
    range: async (from, to) => {
      if (error) return { data: null, error };
      return { data: allRows.slice(from, to + 1), error: null };
    },
  });
}

describe('fetchAllPaginated', () => {
  it('returns all rows across multiple pages', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    const out = await fetchAllPaginated(pagedSource(rows), { pageSize: 1000 });
    assert.equal(out.length, 2500);
    assert.equal(out[0].id, 0);
    assert.equal(out[2499].id, 2499);
  });

  it('stops on a short page', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const out = await fetchAllPaginated(pagedSource(rows), { pageSize: 1000 });
    assert.equal(out.length, 10);
  });

  it('handles an exact page-size boundary without an extra full page', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const out = await fetchAllPaginated(pagedSource(rows), { pageSize: 1000 });
    assert.equal(out.length, 1000);
  });

  it('returns [] for an empty table', async () => {
    const out = await fetchAllPaginated(pagedSource([]), { pageSize: 1000 });
    assert.deepEqual(out, []);
  });

  it('throws on a page error (never silently truncates)', async () => {
    await assert.rejects(
      () => fetchAllPaginated(pagedSource([], { error: { message: 'boom' } })),
      /fetchAllPaginated: boom/
    );
  });
});

describe('readMany', () => {
  it('returns the rows', async () => {
    const out = await readMany(Promise.resolve({ data: [{ a: 1 }], error: null }));
    assert.deepEqual(out, [{ a: 1 }]);
  });

  it('returns [] (not null) when empty', async () => {
    const out = await readMany(Promise.resolve({ data: null, error: null }));
    assert.deepEqual(out, []);
  });

  it('THROWS on error instead of returning empty', async () => {
    await assert.rejects(
      () => readMany(Promise.resolve({ data: null, error: { message: 'db down' } })),
      /readMany: db down/
    );
  });
});

describe('readOne', () => {
  const q = (result) => ({ limit: () => ({ maybeSingle: async () => result }) });

  it('returns the row', async () => {
    const out = await readOne(q({ data: { id: 7 }, error: null }));
    assert.deepEqual(out, { id: 7 });
  });

  it('returns null for no row', async () => {
    const out = await readOne(q({ data: null, error: null }));
    assert.equal(out, null);
  });

  it('throws on a real error', async () => {
    await assert.rejects(() => readOne(q({ data: null, error: { message: 'nope' } })), /readOne: nope/);
  });
});
