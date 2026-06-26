/**
 * Sync Free Swimwear applications from the Google Sheet into Supabase.
 *
 * INSERT-IF-ABSENT keyed on (source, sheet_row). Once a row lands in Supabase,
 * Supabase owns its operational state (status, discount code, dates) — the sheet
 * is only the intake feed for NEW submissions. Re-running never clobbers a
 * portal/lifecycle decision, so it's safe to run on a schedule and concurrently.
 *
 * Runs as a sub-pipeline of daily-sync-all.js (live, current form only); also
 * runnable directly:
 *   node customer-service/sync/syncFreeSwimwearRequests.js            # dry-run, current form only
 *   node customer-service/sync/syncFreeSwimwearRequests.js --backfill # dry-run, include legacy tab
 *   node customer-service/sync/syncFreeSwimwearRequests.js --live     # write new rows
 *   node customer-service/sync/syncFreeSwimwearRequests.js --backfill --live  # one-time full history import
 */

require('dotenv').config();
const { readApplications } = require('../lib/freeSwimwearSurvey');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const TABLE = 'free_swimwear_requests';

async function fetchExistingKeys(supabase) {
  const keys = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('source, sheet_row')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch existing keys: ${error.message}`);
    for (const r of data) keys.add(`${r.source}:${r.sheet_row}`);
    if (data.length < pageSize) break;
  }
  return keys;
}

function tally(rows, field) {
  const t = {};
  for (const r of rows) t[r[field]] = (t[r[field]] || 0) + 1;
  return t;
}

/**
 * Import new applications. Returns a daily-sync-all pipeline result.
 * @param {Object} opts
 * @param {boolean} opts.backfill - include the legacy "Sheet5" tab.
 * @param {boolean} opts.live - actually insert (default false = dry run).
 */
async function run({ backfill = false, live = false } = {}) {
  console.log(`[freeSwimwearSync] reading sheet (${backfill ? 'form + legacy' : 'form only'})...`);
  const rows = await readApplications({ legacy: backfill });
  console.log(`[freeSwimwearSync] read ${rows.length} rows`);

  const supabase = getSupabaseClient();
  const existing = await fetchExistingKeys(supabase);
  const newRows = rows.filter(r => !existing.has(`${r.source}:${r.sheet_row}`));

  console.log(`[freeSwimwearSync] ${existing.size} already in Supabase, ${newRows.length} new`);
  console.log(`[freeSwimwearSync] new by status:`, JSON.stringify(tally(newRows, 'status')));

  if (!live) {
    console.log('[freeSwimwearSync] DRY RUN — pass --live to insert. No writes made.');
    return { status: 'ok', sources: { applications: { success: true, rowsWritten: 0, note: `${newRows.length} new (dry run)` } } };
  }

  let inserted = 0;
  const chunk = 500;
  for (let i = 0; i < newRows.length; i += chunk) {
    const batch = newRows.slice(i, i + chunk);
    const { error } = await supabase.from(TABLE).insert(batch);
    if (error) throw new Error(`insert batch ${i}-${i + batch.length}: ${error.message}`);
    inserted += batch.length;
    console.log(`[freeSwimwearSync] inserted ${inserted}/${newRows.length}`);
  }
  console.log(`[freeSwimwearSync] done — inserted ${inserted} rows.`);
  return { status: 'ok', sources: { applications: { success: true, rowsWritten: inserted } } };
}

module.exports = { run };

if (require.main === module) {
  const args = process.argv.slice(2);
  run({ backfill: args.includes('--backfill'), live: args.includes('--live') })
    .catch(err => {
      console.error('[freeSwimwearSync] FAILED:', err.message);
      process.exit(1);
    });
}
