require('dotenv').config();
const { getSupabaseClient } = require('./supabaseClient');

// Runtime feature flags backed by the `system_flags` Supabase table — a single
// source of truth read by every service (webhook server, crons, dashboard).
// Replaces per-service env-var toggles that required manual propagation
// (scripts/copy-railway-vars.js) and silently diverged across runtimes.
//
// Reads are FAIL-SOFT: a missing table, missing row, or read error returns the
// provided default (false). Any flag that gates a cost or side-effect therefore
// defaults to OFF if the DB is unreachable — the safe direction. Values are
// cached per-process for CACHE_TTL_MS so hot paths don't query on every call;
// a flip propagates to all runtimes within the TTL.

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key -> { value, expires }

async function isFlagEnabled(key, defaultValue = false) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value = defaultValue;
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from('system_flags')
      .select('enabled')
      .eq('key', key)
      .maybeSingle();
    if (!error && data) value = !!data.enabled;
    // error (e.g. table absent) or no row → keep defaultValue (off)
  } catch (_) {
    value = defaultValue;
  }

  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

async function setFlag(key, enabled, note) {
  const sb = getSupabaseClient();
  const { error } = await sb.from('system_flags').upsert(
    { key, enabled: !!enabled, note: note ?? null, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  if (error) throw error;
  cache.delete(key); // next read reflects the new value immediately
  return true;
}

function _clearCache() { cache.clear(); } // test helper

module.exports = { isFlagEnabled, setFlag, _clearCache };
