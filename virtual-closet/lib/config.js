'use strict';
/** Small key/value config in vc_config (sponsorship variants, discount id). Cached per process. */
const { db, must } = require('./db');

const cache = new Map();

async function get(key) {
  if (cache.has(key)) return cache.get(key);
  const row = must(await db().from('vc_config').select('value').eq('key', key).maybeSingle(), `config ${key}`);
  const value = row ? row.value : null;
  cache.set(key, value);
  return value;
}

async function set(key, value) {
  must(await db().from('vc_config').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }), `config set ${key}`);
  cache.set(key, value);
  return value;
}

function clear() { cache.clear(); }

module.exports = { get, set, clear };
