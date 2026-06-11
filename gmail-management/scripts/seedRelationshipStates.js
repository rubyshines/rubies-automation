/**
 * seedRelationshipStates.js — one-time: derive relationship_state (Design #1)
 * from existing b2b_companies.status + order history. Idempotent (only fills
 * NULL states). Dry-run default; --execute writes.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../../shared/supabaseClient');
const sb = getSupabaseClient();
const EXECUTE = process.argv.includes('--execute');

function deriveState(c) {
  if (c.status === 'not_interested') return 'lost';
  if (c.status === 'inactive') return 'dormant';
  if (c.status === 'active_partner') return 'active';
  if (c.status === 'customer') {
    if (!c.last_order_date) return 'active';
    const days = (Date.now() - new Date(c.last_order_date)) / 86400000;
    return days > 180 ? 'dormant' : 'active';
  }
  return 'in_contact'; // lead / qualified_lead / anything else
}

(async () => {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from('b2b_companies')
      .select('id, name, status, relationship_state, last_order_date, order_count')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const counts = {};
  let updated = 0;
  for (const c of rows) {
    if (c.relationship_state) continue; // already set — never overwrite
    const state = deriveState(c);
    counts[state] = (counts[state] || 0) + 1;
    updated++;
    if (EXECUTE) {
      const { error } = await sb.from('b2b_companies')
        .update({ relationship_state: state }).eq('id', c.id);
      if (error) throw error;
    }
  }
  console.log(`${EXECUTE ? 'Seeded' : 'Would seed'} ${updated} of ${rows.length} companies:`, JSON.stringify(counts));
})().catch(e => { console.error(e); process.exit(1); });
