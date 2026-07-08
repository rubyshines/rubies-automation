/**
 * MCP Tool: delivery_estimate
 *
 * Returns historical delivery time stats for a shipping destination.
 * Cascade: country (6mo → 12mo → all-time) → sub-zone (12mo) → zone (all-time).
 * Shows detailed breakdown: processing + transit + total order-to-door.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const MIN_CONFIDENT = 30;
const MIN_LIMITED = 10;

// Sub-zone groupings for geographic fallback
const SUB_ZONES = {
  eu_ddp: {
    label: 'European DDP countries',
    countries: [
      'GB', 'DE', 'FR', 'NL', 'ES', 'IT', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ',
      'DK', 'EE', 'FI', 'GR', 'HU', 'IE', 'LV', 'LT', 'LU', 'MT', 'NO', 'PL',
      'PT', 'RO', 'SK', 'SI', 'SE',
    ],
  },
  apac_ddp: {
    label: 'Australia & New Zealand',
    countries: ['AU', 'NZ'],
  },
};

function getSubZone(cc) {
  for (const [key, sz] of Object.entries(SUB_ZONES)) {
    if (sz.countries.includes(cc)) return sz;
  }
  return null;
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function r(n) { return n != null ? Math.round(n) : null; }
function range(lo, hi) { return lo === hi ? `${lo}` : `${lo}-${hi}`; }

// province_code was removed from the schema: the cascade only queries at
// country / sub-zone granularity, so advertising regional precision told the
// AI the tool did something it doesn't.
async function handleDeliveryEstimate({ country_code }) {
  const supabase = getSupabaseClient();
  const cc = (country_code || '').toUpperCase();

  if (!cc) return { content: [{ type: 'text', text: 'country_code is required.' }] };

  // Look up zone + country name
  const { data: zoneRow } = await supabase
    .from('shipping_zones')
    .select('zone, country_name')
    .eq('country_code', cc)
    .maybeSingle();

  const zone = zoneRow?.zone || (cc === 'US' ? 'us' : cc === 'CA' ? 'canada' : 'ddu');
  const countryName = zoneRow?.country_name || cc;

  // Build cascade steps
  const sixMonths = dateDaysAgo(180);
  const twelveMonths = dateDaysAgo(365);
  const subZone = getSubZone(cc);

  const cascade = [
    { params: { p_country_code: cc, p_since: sixMonths },
      label: countryName, period: 'last 6 months', minForUse: MIN_CONFIDENT },
    { params: { p_country_code: cc, p_since: twelveMonths },
      label: countryName, period: 'last 12 months', minForUse: MIN_CONFIDENT },
    { params: { p_country_code: cc },
      label: countryName, period: 'all time', minForUse: MIN_LIMITED },
  ];

  // Sub-zone fallback (EU → all EU, APAC → all APAC). No cross-zone pooling.
  if (subZone) {
    cascade.push({
      params: { p_country_codes: subZone.countries, p_since: twelveMonths },
      label: subZone.label, period: 'last 12 months', minForUse: MIN_CONFIDENT,
    });
    cascade.push({
      params: { p_country_codes: subZone.countries },
      label: subZone.label, period: 'all time', minForUse: MIN_LIMITED,
    });
  }

  // Walk the cascade
  let stats = null;
  let level = '';
  let period = '';
  let confidence = '';

  for (const step of cascade) {
    const { data } = await supabase.rpc('get_delivery_estimate_stats', step.params);
    if (!data || data.length === 0) continue;
    const row = data[0];
    if (!row || row.order_count === 0) continue;

    if (row.order_count >= MIN_CONFIDENT) {
      stats = row;
      level = step.label;
      period = step.period;
      confidence = 'confident';
      break;
    }

    if (row.order_count >= MIN_LIMITED && step.minForUse === MIN_LIMITED) {
      stats = row;
      level = step.label;
      period = step.period;
      confidence = 'limited';
      break;
    }
  }

  if (!stats) {
    return {
      content: [{
        type: 'text',
        text: `No delivery time data available for ${countryName}. Not enough historical orders to generate an estimate.`,
      }],
    };
  }

  // Build output
  const hasProcessing = stats.processing_median != null;
  const hasTotal = stats.total_median != null;
  const hasLegs = stats.passport_count >= 5;

  // Headline: use total if available, otherwise transit
  let headlineMedian, headlineP75, headlineP90;
  if (hasTotal) {
    headlineMedian = r(stats.total_median);
    headlineP75 = r(stats.total_p75);
    headlineP90 = r(stats.total_p90);
  } else {
    headlineMedian = r(stats.transit_median);
    headlineP75 = r(stats.transit_p75);
    headlineP90 = r(stats.transit_p90);
  }

  const headlineLow = Math.max(1, headlineMedian - 1);
  const headlineHigh = confidence === 'limited' ? r(stats.transit_p90 || headlineP90) : headlineP75;

  const confidenceNote = confidence === 'limited' ? ', limited data' : '';

  let text = `## Shipping Estimate: ${level}\n\n`
    + `Based on **${stats.order_count} orders** (${period}${confidenceNote})\n\n`
    + `**Estimated ${hasTotal ? 'order to door' : 'transit'}: ${range(headlineLow, headlineHigh)} days**\n\n`;

  // Breakdown table
  text += `| Stage | Typical | Most by | Nearly all by |\n`;
  text += `|-------|---------|---------|---------------|\n`;

  if (hasProcessing) {
    const procLow = Math.max(0, r(stats.processing_median));
    const procHigh = r(stats.processing_p75);
    const procP90 = r(stats.processing_p90);
    text += `| Warehouse processing | ${range(procLow, procHigh)} days | ${procHigh} days | ${procP90} days |\n`;
  }

  const tLow = Math.max(1, r(stats.transit_median) - 1);
  const tHigh = r(stats.transit_p75);
  const tP90 = r(stats.transit_p90);
  text += `| Transit | ${range(tLow, tHigh)} days | ${tHigh} days | ${tP90} days |\n`;

  if (hasTotal) {
    text += `| **Order to door** | **${range(headlineLow, headlineP75)} days** | **${headlineP75} days** | **${headlineP90} days** |\n`;
  }

  // Passport leg breakdown
  if (hasLegs) {
    text += `\n**Passport breakdown** (${stats.passport_count} tracked):\n`;
    text += `- Warehouse to Passport facility: ~${r(stats.leg1_median)} days\n`;
    text += `- Passport to door: ~${r(stats.leg2_median)} days\n`;
  }

  // Confidence footer
  if (confidence === 'limited') {
    text += `\n*Limited historical data (${stats.order_count} orders). Actual times may vary.*`;
  }

  return { content: [{ type: 'text', text }] };
}

module.exports = [
  {
    name: 'delivery_estimate',
    description: 'Get estimated delivery times for a shipping destination based on historical order data. Use when a customer asks how long shipping will take to their location.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 2-letter country code (e.g. "US", "CA", "GB", "AU")',
        },
      },
      required: ['country_code'],
    },
    handler: handleDeliveryEstimate,
  },
];
