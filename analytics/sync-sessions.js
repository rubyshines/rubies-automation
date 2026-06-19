/**
 * sync-sessions.js — sync total Shopify online-store sessions (traffic) into
 * Supabase by day, via ShopifyQL. Excludes China (matches the sales report).
 * Used for the signup conversion rate in the email report.
 *
 *   node analytics/sync-sessions.js 2025-01-01 2026-06-18   # backfill a range
 *   node analytics/sync-sessions.js                          # last 60 days (daily)
 *
 * Requires the shopify_sessions_daily table.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { runShopifyQLQuery, parseTableData } = require('../shared/shopifyClient');
const { upsert } = require('../shared/supabaseClient');

function daysAgoISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function run(since = daysAgoISO(60), until = daysAgoISO(0)) {
  const ql = `FROM sessions SHOW sessions, sessions_that_completed_checkout WHERE session_country != 'China' GROUP BY day SINCE ${since} UNTIL ${until}`;
  const rows = parseTableData(await runShopifyQLQuery(ql));
  const records = rows.map((r) => ({
    date: r.day || r.date,
    sessions: parseInt(r.sessions, 10) || 0,
    completed_checkout: parseInt(r.sessions_that_completed_checkout, 10) || 0,
    updated_at: new Date().toISOString(),
  })).filter((r) => r.date);
  if (!records.length) { console.log('No session rows returned.'); return 0; }
  const n = await upsert('shopify_sessions_daily', records, ['date']);
  console.log(`Upserted ${n} day(s) of sessions (${since} → ${until}).`);
  return { status: 'success', sources: { sessions: { success: true, rowsWritten: n } } };
}

if (require.main === module) {
  const since = process.argv[2] || daysAgoISO(60);
  const until = process.argv[3] || daysAgoISO(0);
  run(since, until).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run };
