/**
 * MCP Tool: delivery_time_report
 *
 * Generates a delivery time report by country, with US and CA split into
 * their existing regions. All transit times in calendar days except one
 * median business-day column. Processing in business days.
 *
 * Passport leg columns only shown for non-US rows with enough data.
 * Orders without Passport tracking still count toward transit stats.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const REGION_LABELS = {
  // US
  west_coast: 'US — West Coast',
  mountain: 'US — Mountain',
  midwest: 'US — Midwest',
  south: 'US — South',
  northeast: 'US — Northeast',
  us: 'US — Other',
  // CA
  western_ca: 'CA — Western',
  central_ca: 'CA — Central',
  eastern_ca: 'CA — Eastern',
  atlantic_ca: 'CA — Atlantic',
};

const US_REGIONS = new Set(['west_coast', 'mountain', 'midwest', 'south', 'northeast', 'us']);

const COUNTRY_NAMES = {
  GB: 'United Kingdom', AU: 'Australia', DE: 'Germany', FR: 'France',
  NZ: 'New Zealand', NL: 'Netherlands', ES: 'Spain', SE: 'Sweden',
  DK: 'Denmark', IS: 'Iceland', IE: 'Ireland', NO: 'Norway', FI: 'Finland',
  IT: 'Italy', CH: 'Switzerland', AT: 'Austria', BE: 'Belgium', PT: 'Portugal',
  MX: 'Mexico', IL: 'Israel', CZ: 'Czech Republic', PL: 'Poland',
  BR: 'Brazil', CL: 'Chile', KR: 'South Korea', JP: 'Japan',
  GR: 'Greece', EE: 'Estonia', LT: 'Lithuania', AR: 'Argentina',
  GF: 'French Guiana',
};

function pct(arr, p) {
  if (!arr.length) return null;
  arr.sort((a, b) => a - b);
  return arr[Math.floor(arr.length * p)];
}

function fmt(v) { return v != null ? String(v) : '-'; }

function dateCutoff(period) {
  if (!period || period === 'all') return null;
  const d = new Date();
  if (period === '30d') d.setDate(d.getDate() - 30);
  else if (period === '90d') d.setDate(d.getDate() - 90);
  else if (period === '6mo') d.setMonth(d.getMonth() - 6);
  else return null;
  return d.toISOString();
}

async function fetchRows(supabase, period) {
  const cutoff = dateCutoff(period);
  let all = [], offset = 0;
  while (true) {
    let q = supabase.from('order_delivery_times')
      .select('country_code, region, transit_days, transit_business_days, processing_days, leg1_days, leg2_days, leg1a_days, leg1b_days')
      .not('transit_days', 'is', null);
    if (cutoff) q = q.gte('delivered_at', cutoff);
    const { data, error } = await q.range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    offset += data.length;
  }
  return all;
}

function buildBuckets(rows) {
  const buckets = {};

  for (const r of rows) {
    let key;
    if (r.country_code === 'US' || r.country_code === 'CA') {
      key = r.region || r.country_code.toLowerCase();
    } else {
      key = r.country_code;
    }

    if (!buckets[key]) buckets[key] = {
      isUS: r.country_code === 'US',
      transit: [], bizDays: [], proc: [], leg1a: [], leg1b: [], leg2: [],
    };
    const b = buckets[key];
    if (r.transit_days != null) b.transit.push(r.transit_days);
    if (r.transit_business_days != null) b.bizDays.push(r.transit_business_days);
    if (r.processing_days != null) b.proc.push(r.processing_days);
    if (r.leg1a_days != null) b.leg1a.push(r.leg1a_days);
    if (r.leg1b_days != null) b.leg1b.push(r.leg1b_days);
    if (r.leg2_days != null) b.leg2.push(r.leg2_days);
  }

  return buckets;
}

function bucketLabel(key) {
  if (REGION_LABELS[key]) return REGION_LABELS[key];
  return COUNTRY_NAMES[key] || key;
}

const MIN_LEG_DATA = 3;

function buildTable(buckets) {
  const entries = Object.entries(buckets)
    .map(([key, b]) => ({ key, label: bucketLabel(key), n: b.transit.length, b }))
    .sort((a, b) => b.n - a.n);

  // Check if any non-US row has leg data — if so, include Passport columns
  const hasAnyLegData = entries.some(e => !e.b.isUS && e.b.leg1a.length >= MIN_LEG_DATA);

  let header = '| Location | Orders | Processing | Transit Med | P75 | P90 | Biz Med |';
  let sep = '|----------|--------|------------|-------------|-----|-----|---------|';
  if (hasAnyLegData) {
    header += ' To Hub | Hub Proc | In Transit |';
    sep += '--------|----------|------------|';
  }

  const rows = entries.map(({ key, label, n, b }) => {
    const procMed = b.proc.length >= MIN_LEG_DATA ? fmt(pct(b.proc, 0.5)) : '-';
    const tMed = fmt(pct(b.transit, 0.5));
    const tP75 = fmt(pct(b.transit, 0.75));
    const tP90 = fmt(pct(b.transit, 0.9));
    const bizMed = fmt(pct(b.bizDays, 0.5));

    let row = `| ${label} | ${n} | ${procMed} | ${tMed} | ${tP75} | ${tP90} | ${bizMed} |`;

    if (hasAnyLegData) {
      if (b.isUS) {
        row += ' - | - | - |';
      } else {
        const l1a = b.leg1a.length >= MIN_LEG_DATA ? fmt(pct(b.leg1a, 0.5)) : '-';
        const l1b = b.leg1b.length >= MIN_LEG_DATA ? fmt(pct(b.leg1b, 0.5)) : '-';
        const l2 = b.leg2.length >= MIN_LEG_DATA ? fmt(pct(b.leg2, 0.5)) : '-';
        row += ` ${l1a} | ${l1b} | ${l2} |`;
      }
    }

    return row;
  });

  return [header, sep, ...rows].join('\n');
}

async function handleDeliveryTimeReport({ period, country_code }) {
  const supabase = getSupabaseClient();
  const p = period || 'all';
  const rows = await fetchRows(supabase, p);

  if (rows.length === 0) {
    return { content: [{ type: 'text', text: 'No delivery time data available for the selected period.' }] };
  }

  let filtered = rows;
  if (country_code) {
    const cc = country_code.toUpperCase();
    filtered = rows.filter(r => r.country_code === cc);
    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No delivery time data for ${cc}.` }] };
    }
  }

  const buckets = buildBuckets(filtered);
  const table = buildTable(buckets);

  const periodLabel = p === 'all' ? 'all time' : `last ${p}`;
  const countryNote = country_code ? ` — ${country_code.toUpperCase()}` : '';

  let text = `## Delivery Time Report${countryNote}\n\n`;
  text += `**${filtered.length} orders** | ${periodLabel}\n`;
  text += `All times calendar days except Processing and Biz Med (business days). `;
  text += `To Hub = fulfillment → Passport receives. Hub Proc = Passport processing before export. In Transit = departed Passport → delivered.\n\n`;
  text += table;

  return { content: [{ type: 'text', text }] };
}

module.exports = [
  {
    name: 'delivery_time_report',
    description: 'Generate a delivery time report showing transit stats by country (US/CA split into regions). Use when Jamie asks for delivery time stats, shipping performance, or transit time analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period: "30d", "90d", "6mo", or "all" (default "all")',
        },
        country_code: {
          type: 'string',
          description: 'Optional ISO 2-letter country code to drill into one country',
        },
      },
    },
    handler: handleDeliveryTimeReport,
  },
];
