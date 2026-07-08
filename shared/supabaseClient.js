require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

let supabaseClient = null;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  }

  supabaseClient = createClient(url, key);
  return supabaseClient;
}

async function upsert(table, rows, conflictColumns) {
  if (!rows || !rows.length) return 0;

  const client = getSupabaseClient();
  const { error } = await client.from(table).upsert(rows, {
    onConflict: conflictColumns ? conflictColumns.join(',') : undefined,
  });

  if (error) {
    throw error;
  }

  return rows.length;
}

/**
 * Fetch ALL rows for a PostgREST query, paging past Supabase's 1000-row default
 * cap. This is the canonical replacement for the ~50 hand-rolled `.range()`
 * loops across the repo (several of which were missing, so queries silently
 * truncated).
 *
 * `buildQuery` MUST return a fresh, ORDERED query builder on each call — stable
 * ordering is required or `.range()` pages can overlap/skip. It is called once
 * per page with no args; apply `.order(...)` inside it.
 *
 * Throws on any page error (never returns a partial/empty set as if it were the
 * whole table).
 *
 *   const rows = await fetchAllPaginated(() =>
 *     supabase.from('orders').select('*').eq('status', 'open').order('id'));
 *
 * @param {() => import('@supabase/supabase-js').PostgrestFilterBuilder} buildQuery
 * @param {{ pageSize?: number }} [opts]
 * @returns {Promise<Array>}
 */
async function fetchAllPaginated(buildQuery, { pageSize = 1000 } = {}) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchAllPaginated: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

/**
 * Run a read query and THROW on error instead of swallowing it. A swallowed
 * Supabase error is indistinguishable from "no rows", so a transient DB failure
 * silently feeds empty/wrong data downstream (e.g. to the AI advisor). Use this
 * (or fetchAllPaginated) instead of destructuring only `{ data }`.
 *
 *   const orders = await readMany(supabase.from('orders').select('*').eq('email', e));
 *
 * @returns {Promise<Array>} the rows (never null — [] when empty)
 */
async function readMany(query) {
  const { data, error } = await query;
  if (error) throw new Error(`readMany: ${error.message}`);
  return data || [];
}

/**
 * Read a single row, THROWING on a real error but returning null for "no rows".
 * Pass a query WITHOUT `.single()` (this applies `.maybeSingle()` semantics via
 * limit(1)) so a missing row is null rather than a thrown PostgREST error.
 *
 * @returns {Promise<object|null>}
 */
async function readOne(query) {
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(`readOne: ${error.message}`);
  return data || null;
}

module.exports = {
  getSupabaseClient,
  upsert,
  fetchAllPaginated,
  readMany,
  readOne,
};

