/**
 * sync-audience.js — daily feed for the audience layer of the email report.
 *
 * Pulls, per day, into klaviyo_audience_daily:
 *   - email/SMS subscribe + unsubscribe counts (list growth)
 *   - signup form viewed + submitted counts
 *   - a snapshot of the current email/SMS list size (going forward only)
 *
 * The email report reads this table instead of calling Klaviyo live.
 *
 *   node klaviyo-tracking/sync-audience.js 2024-06-01 2026-06-19  # backfill
 *   node klaviyo-tracking/sync-audience.js                         # last 45 days
 *
 * List size is a point-in-time value, so historical backfill rows leave it null;
 * each daily run stamps that day's snapshot, building real history over time.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { upsert } = require('../shared/supabaseClient');
const { getKlaviyoClient } = require('../shared/klaviyoClient');

const METRICS = {
  email_subscribed: 'U7zuwx', email_unsubscribed: 'TSPEpU',
  sms_subscribed: 'T2y5cf', sms_unsubscribed: 'XeqSPQ',
  form_viewed: 'USVJX3', form_submitted: 'YtMvXZ',
};
const LISTS = { email: 'SNx3j5', sms: 'W523VY' };

function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); }

// Pull daily counts for one metric over [start,end], chunking by <=1 year
// (Klaviyo metric-aggregates cap at a 1-year range).
async function dailyCounts(client, metricId, start, endExcl) {
  const out = {};
  let chunkStart = start;
  while (chunkStart < endExcl) {
    let chunkEnd = addDays(chunkStart, 360);
    if (chunkEnd > endExcl) chunkEnd = endExcl;
    const part = await client.getMonthlyMetricCounts({ metricId, start: chunkStart, endExcl: chunkEnd, interval: 'day' });
    Object.assign(out, part);
    chunkStart = chunkEnd;
  }
  return out;
}

async function run(start = isoDaysAgo(45), endIncl = isoDaysAgo(0)) {
  const client = getKlaviyoClient();
  if (!client) throw new Error('KLAVIYO_API_KEY not set');
  const endExcl = addDays(endIncl, 1);

  const series = {};
  for (const [col, id] of Object.entries(METRICS)) {
    const counts = await dailyCounts(client, id, start, endExcl);
    for (const [date, n] of Object.entries(counts)) {
      (series[date] ||= {})[col] = n;
    }
  }

  // List-size snapshot for the most recent day only (point-in-time value).
  const today = isoDaysAgo(0);
  let emailSize = null, smsSize = null;
  if (endIncl >= isoDaysAgo(2)) {
    [emailSize, smsSize] = await Promise.all([client.getListSize(LISTS.email), client.getListSize(LISTS.sms)]);
  }

  const rows = Object.entries(series).map(([date, m]) => ({
    date,
    email_subscribed: m.email_subscribed || 0, email_unsubscribed: m.email_unsubscribed || 0,
    sms_subscribed: m.sms_subscribed || 0, sms_unsubscribed: m.sms_unsubscribed || 0,
    form_viewed: m.form_viewed || 0, form_submitted: m.form_submitted || 0,
    email_list_size: date === today ? emailSize : null,
    sms_list_size: date === today ? smsSize : null,
    updated_at: new Date().toISOString(),
  }));
  // Drop null list-size keys for non-today rows so upsert doesn't wipe a prior snapshot.
  for (const r of rows) { if (r.email_list_size == null) delete r.email_list_size; if (r.sms_list_size == null) delete r.sms_list_size; }

  // An empty day is a graceful skip, not a failure — a bare `0` return made
  // the daily runner report FAILURE and exit 1.
  if (!rows.length) {
    console.log('No audience rows.');
    return { status: 'success', sources: { audience: { success: true, rowsWritten: 0 } } };
  }
  const n = await upsert('klaviyo_audience_daily', rows, ['date']);
  console.log(`Upserted ${n} day(s) of audience metrics (${start} → ${endIncl}).${emailSize ? ` List sizes: email ${emailSize}, sms ${smsSize}.` : ''}`);
  return { status: 'success', sources: { audience: { success: true, rowsWritten: n } } };
}

if (require.main === module) {
  const start = process.argv[2] || isoDaysAgo(45);
  const end = process.argv[3] || isoDaysAgo(0);
  run(start, end).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run };
