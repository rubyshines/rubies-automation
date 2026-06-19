/**
 * flow-metrics.js — sync per-flow performance into Supabase.
 *
 * Klaviyo's flow-values-reports gives flow revenue/engagement for a window.
 * We store it at MONTH granularity (one row per flow × channel × month) so any
 * range (a quarter, a year) is just the sum of its months. This is the flow
 * analog of the campaign sync in daily-email-tracking.js.
 *
 *   node klaviyo-tracking/flow-metrics.js 2025            # backfill all of 2025
 *   node klaviyo-tracking/flow-metrics.js 2025-10         # one month
 *   node klaviyo-tracking/flow-metrics.js 2025-10 2025-12 # an inclusive month range
 *
 * Requires the klaviyo_flow_metrics table (flow-metrics-schema.sql).
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { upsert } = require('../shared/supabaseClient');
const { getKlaviyoClient } = require('../shared/klaviyoClient');

const PLACED_ORDER_METRIC_ID = 'WTakqp';
const CHANNELS = ['email', 'sms'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// First day of a month and the exclusive first-of-next-month bound.
function monthBounds(year, month /* 1-12 */) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const end = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { start, end };
}

// Expand a CLI arg set into a list of {year, month}.
function monthsFromArgs(args) {
  if (!args.length) {
    // Default: trailing 12 months is overkill for a backfill default; require an arg.
    throw new Error('Pass a year (2025), a month (2025-10), or a range (2025-10 2025-12).');
  }
  const parseOne = (a) => {
    const ym = /^(\d{4})-(\d{2})$/.exec(a);
    if (ym) return { year: +ym[1], month: +ym[2] };
    const y = /^(\d{4})$/.exec(a);
    if (y) return { year: +y[1], month: null };
    throw new Error(`Bad period "${a}". Use YYYY or YYYY-MM.`);
  };
  if (args.length === 1) {
    const p = parseOne(args[0]);
    if (p.month) return [p];
    return Array.from({ length: 12 }, (_, i) => ({ year: p.year, month: i + 1 }));
  }
  // Range: two YYYY-MM
  const a = parseOne(args[0]); const b = parseOne(args[1]);
  const out = [];
  let y = a.year, m = a.month;
  while (y < b.year || (y === b.year && m <= b.month)) {
    out.push({ year: y, month: m });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function syncMonth(client, flowMeta, year, month) {
  const { start, end } = monthBounds(year, month);
  const rows = [];
  for (const channel of CHANNELS) {
    let flows;
    try {
      flows = await client.getFlowValuesReport({
        start, end, channel, conversionMetricId: PLACED_ORDER_METRIC_ID,
      });
    } catch (err) {
      console.error(`  ✗ ${year}-${String(month).padStart(2, '0')} ${channel}: ${err.message}`);
      continue;
    }
    for (const f of flows) {
      if (!f.recipients && !f.conversion_value) continue; // skip dead rows
      const meta = flowMeta[f.flow_id] || {};
      rows.push({
        flow_id: f.flow_id,
        flow_name: meta.name || f.flow_id,
        status: meta.status || '',
        channel,
        period_start: start,
        period_end: end,
        recipients: f.recipients,
        delivered: f.delivered,
        opens: f.opens,
        clicks: f.clicks,
        conversions: f.conversions,
        conversion_value: f.conversion_value,
        open_rate: Math.round(f.open_rate * 10000) / 100,
        click_rate: Math.round(f.click_rate * 10000) / 100,
        conversion_rate: Math.round(f.conversion_rate * 10000) / 100,
        unsubscribe_rate: Math.round(f.unsubscribe_rate * 10000) / 100,
        updated_at: new Date().toISOString(),
      });
    }
    await sleep(1100); // rate limit between report calls (reporting endpoint ~1/s)
  }
  if (!rows.length) return 0;
  return upsert('klaviyo_flow_metrics', rows, ['flow_id', 'channel', 'period_start', 'period_end']);
}

async function run(args) {
  const client = getKlaviyoClient();
  if (!client) throw new Error('KLAVIYO_API_KEY not set');

  // Flow metadata (name, status) — fetched once, joined into every month.
  const flows = await client.getFlows();
  const flowMeta = {};
  for (const f of flows) {
    flowMeta[f.id] = { name: f.attributes?.name || f.id, status: f.attributes?.status || '' };
  }

  const months = monthsFromArgs(args);
  let total = 0;
  for (const { year, month } of months) {
    const written = await syncMonth(client, flowMeta, year, month);
    total += written;
    console.log(`  ${year}-${String(month).padStart(2, '0')}: ${written} flow rows`);
  }
  console.log(`Done. ${total} rows upserted across ${months.length} month(s).`);
  return total;
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
