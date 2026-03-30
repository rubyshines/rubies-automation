/**
 * MCP Tool: delivery_estimate
 *
 * Returns historical delivery time stats for a shipping destination.
 * Falls back: region → country → zone if insufficient data at finer granularity.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

const MIN_ORDERS_FOR_ESTIMATE = 10;

async function handleDeliveryEstimate({ country_code, province_code }) {
  const supabase = getSupabaseClient();
  const cc = (country_code || '').toUpperCase();
  const pc = (province_code || '').toUpperCase() || null;

  if (!cc) return { content: [{ type: 'text', text: 'country_code is required.' }] };

  // Look up region
  let region = null;
  let regionLabel = null;
  if (pc) {
    const { data: regionRow } = await supabase
      .from('shipping_regions')
      .select('region, region_label')
      .eq('country_code', cc)
      .eq('province_code', pc)
      .maybeSingle();
    if (regionRow) {
      region = regionRow.region;
      regionLabel = regionRow.region_label;
    }
  }

  // Fallback to country-level region
  if (!region) {
    const { data: regionRow } = await supabase
      .from('shipping_regions')
      .select('region, region_label')
      .eq('country_code', cc)
      .eq('province_code', '*')
      .maybeSingle();
    if (regionRow) {
      region = regionRow.region;
      regionLabel = regionRow.region_label;
    }
  }

  // Look up shipping zone
  const { data: zoneRow } = await supabase
    .from('shipping_zones')
    .select('zone, country_name')
    .eq('country_code', cc)
    .maybeSingle();

  const zone = zoneRow?.zone || (cc === 'US' ? 'us' : cc === 'CA' ? 'canada' : 'ddu');
  const countryName = zoneRow?.country_name || cc;

  // Try region-level stats first, then country, then zone
  let stats = null;
  let level = '';

  if (region) {
    const { data } = await supabase.rpc('get_delivery_time_stats', {
      p_region: region,
      p_country_code: cc,
    });
    if (data && data.length > 0) {
      const combined = combineStats(data);
      if (combined.order_count >= MIN_ORDERS_FOR_ESTIMATE) {
        stats = combined;
        level = regionLabel || region;
      }
    }
  }

  if (!stats) {
    const { data } = await supabase.rpc('get_delivery_time_stats', {
      p_country_code: cc,
    });
    if (data && data.length > 0) {
      const combined = combineStats(data);
      if (combined.order_count >= MIN_ORDERS_FOR_ESTIMATE) {
        stats = combined;
        level = countryName;
      }
    }
  }

  if (!stats) {
    const { data } = await supabase.rpc('get_delivery_time_stats', {
      p_shipping_zone: zone,
    });
    if (data && data.length > 0) {
      const combined = combineStats(data);
      if (combined.order_count >= MIN_ORDERS_FOR_ESTIMATE) {
        stats = combined;
        level = `${zone.toUpperCase()} zone`;
      }
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

  // Get Passport leg stats for international orders
  let legInfo = '';
  if (zone !== 'us') {
    const { data: legs } = await supabase.rpc('get_passport_leg_stats', {
      p_country_code: cc,
    });
    if (legs && legs.length > 0) {
      const leg = legs[0];
      if (leg.order_count >= 5) {
        legInfo = `\n\n**Transit breakdown** (${leg.order_count} tracked shipments):\n`
          + `- Warehouse to Passport facility: ~${Math.round(leg.median_leg1)} days\n`
          + `- Passport to delivery: ~${Math.round(leg.median_leg2)} days`
          + (leg.local_carrier ? `\n- Last-mile carrier: ${leg.local_carrier}` : '');
      }
    }
  }

  const median = Math.round(stats.median_days);
  const p75 = Math.round(stats.p75_days);
  const p90 = Math.round(stats.p90_days);

  // Format range: median ± spread
  const rangeLow = Math.max(1, median - 1);
  const rangeHigh = p75;

  const text = `## Shipping Estimate: ${level}\n\n`
    + `Based on **${stats.order_count} recent orders** to this destination:\n\n`
    + `- **Typical delivery**: ${rangeLow}--${rangeHigh} days (median ${median} days)\n`
    + `- **Most orders arrive within**: ${p75} days (75th percentile)\n`
    + `- **Nearly all arrive within**: ${p90} days (90th percentile)\n`
    + `\n*Transit time from fulfillment. Processing at the warehouse typically adds 1--2 business days.*`
    + legInfo;

  return { content: [{ type: 'text', text }] };
}

/** Combine multiple stat rows into a single summary (weighted by order count) */
function combineStats(rows) {
  const totalOrders = rows.reduce((s, r) => s + r.order_count, 0);
  if (totalOrders === 0) return { order_count: 0 };

  // Weighted averages for percentiles
  const wMedian = rows.reduce((s, r) => s + r.median_days * r.order_count, 0) / totalOrders;
  const wP75 = rows.reduce((s, r) => s + r.p75_days * r.order_count, 0) / totalOrders;
  const wP90 = rows.reduce((s, r) => s + r.p90_days * r.order_count, 0) / totalOrders;
  const wAvg = rows.reduce((s, r) => s + r.avg_days * r.order_count, 0) / totalOrders;

  return {
    order_count: totalOrders,
    median_days: wMedian,
    p75_days: wP75,
    p90_days: wP90,
    min_days: Math.min(...rows.map(r => r.min_days)),
    max_days: Math.max(...rows.map(r => r.max_days)),
    avg_days: wAvg,
  };
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
        province_code: {
          type: 'string',
          description: 'State/province code for US or Canada (e.g. "CA", "NY", "ON", "BC"). Optional for other countries.',
        },
      },
      required: ['country_code'],
    },
    handler: handleDeliveryEstimate,
  },
];
