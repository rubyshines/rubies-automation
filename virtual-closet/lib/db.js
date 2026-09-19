'use strict';
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');

function db() { return getSupabaseClient(); }

/** Throw on a Supabase error, return data otherwise. */
function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

async function logEvent(centreId, actor, kind, detail = {}) {
  const { error } = await db().from('vc_events').insert({ centre_id: centreId || null, actor, kind, detail });
  if (error) console.warn(`[vc] event log failed (${kind}): ${error.message}`);
}

module.exports = { db, must, fetchAllPaginated, logEvent };
