/**
 * Sync shipping zones + rates from Shopify DeliveryProfile API → Supabase.
 *
 * Pulls: zone names, country lists, rates, free shipping thresholds.
 * Maps zone names ("DDP Shipping", "DDU Shipping", "Canada", "United States")
 * to zone codes (ddp, ddu, canada, us).
 *
 * Run: node customer-service/sync/syncShippingZones.js
 * Also callable as part of daily-sync-all.js pipeline.
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { shopifyGraphQL } = require('../lib/shopify');

const ZONE_NAME_MAP = {
  'united states': 'us',
  'canada': 'canada',
  'ddp shipping': 'ddp',
  'ddu shipping': 'ddu',
};

const QUERY = `{
  deliveryProfiles(first: 1) {
    edges {
      node {
        profileLocationGroups {
          locationGroupZones(first: 20) {
            edges {
              node {
                zone {
                  name
                  countries { code { countryCode } name }
                }
                methodDefinitions(first: 10) {
                  edges {
                    node {
                      name
                      rateProvider {
                        ... on DeliveryRateDefinition {
                          price { amount currencyCode }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

async function syncShippingZones() {
  const supabase = getSupabaseClient();
  const data = await shopifyGraphQL(QUERY);
  const profile = data.deliveryProfiles.edges[0]?.node;
  if (!profile) throw new Error('No delivery profile found');

  const rows = [];
  let totalCountries = 0;

  for (const group of profile.profileLocationGroups) {
    for (const zoneEdge of group.locationGroupZones.edges) {
      const zoneName = zoneEdge.node.zone.name;
      const zoneCode = ZONE_NAME_MAP[zoneName.toLowerCase()] || 'ddu';
      const countries = zoneEdge.node.zone.countries || [];
      const methods = zoneEdge.node.methodDefinitions.edges.map(e => ({
        name: e.node.name,
        price: parseFloat(e.node.rateProvider?.price?.amount || 0),
        currency: e.node.rateProvider?.price?.currencyCode || 'USD',
      }));

      // Find standard rate (non-free, non-expedited)
      const standardMethod = methods.find(m => m.price > 0 && !m.name.toLowerCase().includes('expedit') && !m.name.toLowerCase().includes('free'));
      const expeditedMethod = methods.find(m => m.name.toLowerCase().includes('expedit'));
      const freeMethod = methods.find(m => m.price === 0 && m.name.toLowerCase().includes('free'));

      // Determine free shipping threshold from method names
      // e.g. "Free US Standard Shipping" with $0 price for orders $99+
      const standardRate = standardMethod?.price || 0;
      const expeditedRate = expeditedMethod?.price || null;

      // Heuristic for free threshold: if there's a paid + free method, the threshold
      // is implied by the zone config. We'll use known values as defaults.
      let freeThreshold = null;
      if (zoneCode === 'us') freeThreshold = 99.00;
      else if (zoneCode === 'canada') freeThreshold = 96.00;
      else if (freeMethod && standardMethod) freeThreshold = 0; // free for $0 orders = free for all

      const isDDP = zoneCode === 'ddp';

      for (const country of countries) {
        const countryCode = country.code?.countryCode;
        if (!countryCode) continue;
        rows.push({
          country_code: countryCode,
          country_name: country.name,
          zone: zoneCode,
          duties_prepaid: isDDP,
          free_shipping_threshold: freeThreshold,
          standard_rate: standardRate,
          expedited_rate: expeditedRate,
          currency: standardMethod?.currency || 'USD',
          synced_at: new Date().toISOString(),
        });
        totalCountries++;
      }
    }
  }

  // Detect changes vs current shipping_zones state, then write history rows
  // BEFORE the upsert (so we can compare incoming vs stored).
  const { data: existingRows, error: existingErr } = await supabase
    .from('shipping_zones')
    .select('country_code, zone, free_shipping_threshold, standard_rate, expedited_rate, currency');
  if (existingErr) throw new Error(`Failed to fetch existing zones: ${existingErr.message}`);

  const existing = new Map((existingRows || []).map(r => [r.country_code, r]));
  const numEq = (a, b) => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Math.abs(Number(a) - Number(b)) < 0.001;
  };
  const historyRows = [];
  const observedAt = new Date().toISOString();
  for (const r of rows) {
    const prev = existing.get(r.country_code);
    if (!prev) {
      // New country (or first-ever sync)
      historyRows.push({
        country_code: r.country_code, zone: r.zone,
        free_shipping_threshold: r.free_shipping_threshold,
        standard_rate: r.standard_rate, expedited_rate: r.expedited_rate, currency: r.currency,
        observed_at: observedAt, change_type: 'initial',
      });
      continue;
    }
    const changes = [];
    if (prev.zone !== r.zone) changes.push('zone');
    if (!numEq(prev.free_shipping_threshold, r.free_shipping_threshold)) changes.push('threshold');
    if (!numEq(prev.standard_rate, r.standard_rate)) changes.push('rate');
    if (!numEq(prev.expedited_rate, r.expedited_rate)) changes.push('rate');
    if ((prev.currency || '') !== (r.currency || '')) changes.push('currency');
    if (changes.length === 0) continue;
    const changeType = changes.length > 1 ? 'multi_change' :
      changes[0] === 'zone' ? 'zone_change' :
      changes[0] === 'threshold' ? 'threshold_change' :
      'rate_change';
    historyRows.push({
      country_code: r.country_code, zone: r.zone,
      free_shipping_threshold: r.free_shipping_threshold,
      standard_rate: r.standard_rate, expedited_rate: r.expedited_rate, currency: r.currency,
      observed_at: observedAt, change_type: changeType,
      prev_zone: prev.zone,
      prev_free_shipping_threshold: prev.free_shipping_threshold,
      prev_standard_rate: prev.standard_rate,
      prev_expedited_rate: prev.expedited_rate,
      prev_currency: prev.currency,
    });
  }

  // Upsert current state
  if (rows.length > 0) {
    const { error } = await supabase
      .from('shipping_zones')
      .upsert(rows, { onConflict: 'country_code' });
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  // Insert history rows (only for actual changes; zero-change days write nothing)
  if (historyRows.length > 0) {
    const { error: histErr } = await supabase
      .from('shipping_zones_history')
      .insert(historyRows);
    if (histErr) throw new Error(`Supabase history insert failed: ${histErr.message}`);
  }

  const zoneCounts = {};
  for (const r of rows) {
    zoneCounts[r.zone] = (zoneCounts[r.zone] || 0) + 1;
  }

  return {
    success: true,
    totalCountries,
    zones: zoneCounts,
    historyRowsWritten: historyRows.length,
  };
}

// Pipeline-compatible run() export for daily-sync-all.js
async function run() {
  try {
    const result = await syncShippingZones();
    return {
      sources: {
        shipping_zones: { success: true, rowsWritten: result.totalCountries },
      },
      status: 'ok',
    };
  } catch (e) {
    return {
      sources: {
        shipping_zones: { success: false, error: e.message },
      },
      status: 'error',
    };
  }
}

// Standalone execution
if (require.main === module) {
  syncShippingZones()
    .then(r => console.log('Synced:', JSON.stringify(r, null, 2)))
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { syncShippingZones, run };
