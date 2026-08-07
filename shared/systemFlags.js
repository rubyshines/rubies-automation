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
//
// Flags may carry an `expires_at`: past that instant the flag reads as DISABLED
// regardless of `enabled`. That turns "remember to switch this back off" into a
// property of the system instead of a thing a human has to remember — the
// motivating case is away mode, where the operator is by definition unreachable
// and cannot be relied on to flip it. NULL expires_at = never expires, which is
// how every flag predating this behaved.

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key -> { value, expires }

// Cache entries must not outlive the flag's own expiry, or an away window could
// stay "on" for up to a TTL past its end.
function cacheUntil(expiresAt) {
  const ttlExpiry = Date.now() + CACHE_TTL_MS;
  if (!expiresAt) return ttlExpiry;
  const flagExpiry = new Date(expiresAt).getTime();
  if (Number.isNaN(flagExpiry)) return ttlExpiry;
  return Math.min(ttlExpiry, Math.max(flagExpiry, Date.now()));
}

async function isFlagEnabled(key, defaultValue = false) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value = defaultValue;
  let expiresAt = null;
  try {
    const sb = getSupabaseClient();
    // select('*') rather than naming expires_at: PostgREST errors the whole
    // query on an unknown column, which would send every flag to its default
    // on any runtime deployed before the migration lands — silently switching
    // off enabled flags that default to false. With '*' the column is simply
    // absent until it exists, and absent means "no expiry".
    const { data, error } = await sb
      .from('system_flags')
      .select('*')
      .eq('key', key)
      .maybeSingle();
    if (!error && data) {
      expiresAt = data.expires_at || null;
      value = !!data.enabled && !isExpired(expiresAt);
    }
    // error (e.g. table absent) or no row → keep defaultValue (off)
  } catch (_) {
    value = defaultValue;
  }

  cache.set(key, { value, expires: cacheUntil(expiresAt) });
  return value;
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return false; // unparseable → treat as no expiry, not as off
  return t <= Date.now();
}

/**
 * Read a flag's full row (enabled, note, expires_at) plus the effective
 * `active` value after applying expiry. For status displays and for callers
 * that need the note (away mode stores its return phrase there).
 * Fail-soft: returns null when the row can't be read.
 */
async function getFlag(key) {
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from('system_flags')
      .select('*') // see isFlagEnabled — tolerates the pre-migration schema
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return null;
    return { ...data, active: !!data.enabled && !isExpired(data.expires_at) };
  } catch (_) {
    return null;
  }
}

async function setFlag(key, enabled, note, expiresAt) {
  const sb = getSupabaseClient();
  const row = {
    key,
    enabled: !!enabled,
    note: note ?? null,
    updated_at: new Date().toISOString(),
  };
  // Only touch expires_at when the caller passed it, so existing callers
  // (three-arg setFlag) can't silently clear an expiry they don't know about.
  if (expiresAt !== undefined) {
    row.expires_at = expiresAt ? new Date(expiresAt).toISOString() : null;
  }
  const { error } = await sb.from('system_flags').upsert(row, { onConflict: 'key' });
  if (error) throw error;
  cache.delete(key); // next read reflects the new value immediately
  return true;
}

function _clearCache() { cache.clear(); } // test helper

module.exports = { isFlagEnabled, getFlag, setFlag, isExpired, _clearCache };
