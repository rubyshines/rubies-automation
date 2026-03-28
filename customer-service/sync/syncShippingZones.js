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

  // Upsert all rows
  if (rows.length > 0) {
    const { error } = await supabase
      .from('shipping_zones')
      .upsert(rows, { onConflict: 'country_code' });
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  const zoneCounts = {};
  for (const r of rows) {
    zoneCounts[r.zone] = (zoneCounts[r.zone] || 0) + 1;
  }

  return {
    success: true,
    totalCountries,
    zones: zoneCounts,
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
