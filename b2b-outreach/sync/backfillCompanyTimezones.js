/**
 * backfillCompanyTimezones.js — write the stored `timezone` for every company
 * whose location implies one, and keep it in step when the location changed.
 *
 * Operator-set zones are never touched. This is the same derivation the panel
 * does live (meetingTimezone.timezoneFromLocation) written down, so a raw row
 * read agrees with the panel. Deterministic, no AI, no network beyond Supabase.
 *
 * Print-only by default:
 *   node b2b-outreach/sync/backfillCompanyTimezones.js            # what it would write
 *   node b2b-outreach/sync/backfillCompanyTimezones.js --write    # write it
 */
require('dotenv').config();
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { timezonePatchFor, isMissingTimezoneColumn, MIGRATION } = require('../lib/companyLocation');

async function run({ write = false } = {}) {
  const sb = getSupabaseClient();
  const companies = await fetchAllPaginated(() => sb.from('b2b_companies').select('*').order('id'));
  const todo = [];
  for (const c of companies) {
    const patch = timezonePatchFor(c);
    if (patch) todo.push({ id: c.id, name: c.name, from: c.timezone || null, ...patch });
  }
  console.log(`${companies.length} companies, ${todo.length} to ${write ? 'write' : 'update (dry run)'}`);
  for (const t of todo) console.log(`  ${t.id.padEnd(36)} ${String(t.from).padEnd(22)} → ${t.timezone || '(none)'}`);
  if (!write) { console.log('\nDry run. Pass --write to apply.'); return { total: companies.length, todo: todo.length, written: 0 }; }

  let written = 0;
  for (const t of todo) {
    const { error } = await sb.from('b2b_companies')
      .update({ timezone: t.timezone, timezone_source: t.timezone_source, updated_at: new Date().toISOString() })
      .eq('id', t.id);
    if (error) {
      if (isMissingTimezoneColumn(error)) throw new Error(`b2b_companies has no timezone column yet — run ${MIGRATION} in the Supabase SQL Editor.`);
      throw new Error(`${t.id}: ${error.message}`);
    }
    written++;
  }
  console.log(`wrote ${written}`);
  return { total: companies.length, todo: todo.length, written };
}

if (require.main === module) {
  run({ write: process.argv.includes('--write') }).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { run };
